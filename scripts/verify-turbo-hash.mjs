#!/usr/bin/env node
/**
 * turbo 해시 계약 회귀 검증.
 *
 * `turbo run --dry=json` 출력으로 계약의 두 축을 단정한다.
 *   - 해시 축: 상위 패키지(shared) 소스 변경이 하위(server·client) 태스크 해시에 반영되고,
 *     비의존 패키지(@muhan/port)는 그 변경에 영향받지 않는다. 루트 공용 설정
 *     (`globalDependencies`) 변경은 전 태스크에 반영된다.
 *   - 의존 형태 축: `type-check`·`lint`는 `dependsOn: ["transit"]`이어야 한다. 이걸
 *     `["^type-check"]`로 바꿔도 해시 전파는 동일해 해시 비교만으로는 잡히지 않지만,
 *     상위 패키지의 실행 완료를 기다리는 직렬 빌드가 된다. 해시로 보이지 않는 절반이다.
 *
 * 검증 대상은 `turbo.json`에서 파생한다 — 태스크 목록은 `tasks`의 키(보조 노드 `transit` 제외),
 * 루트 설정 프로브 대상은 `globalDependencies`. 목록을 여기에 따로 적으면 새 태스크·새 공용
 * 설정이 계약 밖에서 조용히 생긴다. 사람의 판단이 필요한 계약(어느 taskId가 전파 대상이고
 * 어느 것이 격리 대상인가)만 아래 상수로 남긴다.
 *
 * 프로브가 워킹 트리를 변조하므로 4중 보호를 둔다.
 *   1. 자가 치유 — 스크립트 전용 프로브 파일이 미추적이고 내용이 정확히 일치하면 시작 시 제거한다.
 *   2. 사전 차단 — 추적 파일 프로브 대상이 이미 더티면 아무것도 건드리지 않고 종료한다.
 *   3. 복원 — finally·exit·시그널 어느 경로로 빠져나가도 restoreAll()이 돈다.
 *   4. 사후 자기 검사 — 종료 직전 워킹 트리가 시작 시점과 동일한지 스스로 확인한다.
 *
 * 종료 코드: 0 = 전 프로브 통과, 1 = 단정 실패 또는 사후 검사 실패, 2 = 사전 차단,
 *            128 + signum = 시그널 종료 (SIGHUP 129 · SIGINT 130 · SIGTERM 143).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- 저장소 루트 고정 (T2.1) ---------------------------------------------
// 호출 디렉터리와 무관하게 스크립트 위치 기준으로 루트를 정한다.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_GUARD = 2

/** 아무것도 변조하지 않은 채 중단해야 하는 조건. 최상위에서 EXIT_GUARD로 매핑된다. */
class GuardError extends Error {}

/** 신규 생성 방식 프로브. 스크립트 전용 이름이라 이 내용일 때만 삭제가 안전하다. */
const NEW_FILE_PROBE = 'packages/shared/src/__turbo_hash_probe__.ts'
const NEW_FILE_PROBE_CONTENT = 'export const __turboHashProbe = 1\n'

const PROBE_MARKER = '// turbo-hash-probe'

/** turbo 그래프를 잇기만 하는 보조 노드. 실행 스크립트가 없어 검증 대상 태스크가 아니다. */
const TRANSIT_TASK = 'transit'

/**
 * 기대 taskId 14개. `--dry=json`의 `tasks[]`는 스크립트가 없는 패키지의 태스크와
 * transit 보조 노드까지 포함하므로, `command === '<NONEXISTENT>'`를 걸러낸 뒤 이 목록과 대조한다.
 *
 * 이 목록만은 파생하지 않고 손으로 유지한다 — 패키지가 늘었을 때 그 태스크가 전파 대상인지
 * 격리 대상인지는 사람이 정해야 할 계약이고, 자동 파생하면 Probe A의 격리 단정
 * (`@muhan/port`가 SAME)이 함께 사라진다.
 */
const EXPECTED_TASK_IDS = [
  'shared#build',
  'shared#type-check',
  'shared#lint',
  'shared#test',
  'server#build',
  'server#type-check',
  'server#lint',
  'server#test',
  'client#build',
  'client#type-check',
  'client#lint',
  'client#test',
  '@muhan/port#lint',
  '@muhan/port#test',
]

/**
 * 태스크명 → 기대 `dependsOn`. 해시 비교가 보지 못하는 계약의 절반이다.
 * `type-check`·`lint`의 `["transit"]`을 `["^type-check"]`로 바꾸면 해시는 그대로라
 * 전 프로브가 통과하지만 병렬 실행이 사라진다. 그 회귀를 여기서 잡는다.
 */
const EXPECTED_DEPENDS_ON = {
  build: ['^build'],
  'type-check': [TRANSIT_TASK],
  lint: [TRANSIT_TASK],
  test: ['^build'],
}

/** Probe A에서 격리(SAME)를 기대하는 taskId. 나머지 기대 taskId는 CHANGED여야 한다. */
const ISOLATED_TASK_IDS = ['@muhan/port#lint', '@muhan/port#test']

/** `globalDependencies` 항목이 단일 파일이 아님을 나타내는 문자. 프로브가 변조 대상을 특정할 수 없다. */
const GLOB_CHARS = /[*?[\]{}!]/

// --- 복원 상태 (T2.3) -----------------------------------------------------
// restoreAll()이 참조하는 유일한 상태. 프로브가 변조 직전에 여기에 원본을 적재한다.
/** @type {Map<string, string>} 상대 경로 → 원본 바이트 (추적 파일 복원용) */
const originalContents = new Map()
/** 신규 생성 프로브 파일이 현재 디스크에 있는지 여부 */
let newFileProbeActive = false
/** 실행 시작 시점의 `git status --porcelain`. 사후 자기 검사의 기준이다. */
let baselineStatus
/** 프로브가 한 번이라도 워킹 트리를 변조했는지. 사후 검사 결과를 보고할지 결정한다. */
let probesAttempted = false

/**
 * 모든 변조를 되돌린다. 멱등하며 전부 sync I/O라 `process.on('exit')` 안에서도 동작한다.
 *
 * 복원에 실패한 항목은 등록을 유지해 다음 호출이 재시도하게 한다. 성공했을 때만
 * 등록을 지우는 이유는, 한 번의 일시적 실패(EBUSY 등)로 원본 바이트의 유일한
 * 사본이 사라지면 이후 어떤 경로로도 복원할 수 없기 때문이다.
 */
function restoreAll() {
  for (const [relPath, content] of originalContents) {
    try {
      writeFileSync(join(REPO_ROOT, relPath), content)
      originalContents.delete(relPath)
    } catch {
      // 등록을 남겨 다음 restoreAll() 호출이 재시도한다.
    }
  }
  if (newFileProbeActive) {
    try {
      unlinkSync(join(REPO_ROOT, NEW_FILE_PROBE))
      newFileProbeActive = false
    } catch (error) {
      if (error.code === 'ENOENT') newFileProbeActive = false
    }
  }
}

/**
 * 복원되지 않고 남은 변조에 대한 복구 명령을 만든다.
 *
 * 프로세스가 죽으면 `originalContents`의 원본 바이트도 함께 사라진다 — 그 시점의 유일한
 * 복구 수단이 git이므로, 무엇을 잃었는지가 아니라 무엇을 실행해야 하는지를 출력한다.
 * 남은 변조가 없으면 빈 문자열이라 정상 경로의 메시지에는 아무것도 붙지 않는다.
 */
function recoveryHint() {
  const lines = []
  const unrestored = [...originalContents.keys()]
  if (unrestored.length > 0) {
    lines.push('복원하지 못한 추적 파일이 있다. 다음 명령으로 복구하라:')
    lines.push(`  git checkout -- ${unrestored.join(' ')}`)
  }
  if (newFileProbeActive) {
    lines.push('프로브가 만든 파일이 남아 있다. 다음 명령으로 제거하라:')
    lines.push(`  rm -f ${NEW_FILE_PROBE}`)
  }
  return lines.length > 0 ? `\n\n${lines.join('\n')}` : ''
}

/**
 * 워킹 트리가 baseline과 동일한지 확인한다. baseline 캡처 전이면 검사할 것이 없다.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyTreeRestored() {
  if (baselineStatus === undefined) return { ok: true }
  let current
  try {
    current = captureStatus()
  } catch (error) {
    return { ok: false, reason: `워킹 트리 상태를 재확인하지 못했다: ${error.message}` }
  }
  if (current === baselineStatus) return { ok: true }
  return {
    ok: false,
    reason:
      '워킹 트리가 실행 전과 다르다.\n' +
      `--- 실행 전 ---\n${baselineStatus || '(clean)'}` +
      `--- 실행 후 ---\n${current || '(clean)'}`,
  }
}

// 최후의 안전망. 여기서는 복원만 하고 판정은 하지 않는다 —
// `exit` 핸들러 안에서 종료 코드를 바꾸는 것은 Node 버전에 따라 반영이 보장되지 않는다.
process.on('exit', restoreAll)

// 시그널 경로도 복원 후 사후 검사를 거친다. 종료 코드는 관례대로 128 + signum이다.
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    restoreAll()
    const verdict = verifyTreeRestored()
    if (!verdict.ok) {
      console.error(`\n${signal} 처리 중 복원에 실패했다.\n${verdict.reason}${recoveryHint()}`)
      process.exit(EXIT_FAIL)
    }
    process.exit(exitCode)
  })
}

// --- 유틸 -----------------------------------------------------------------

/**
 * 변조 대상이 심볼릭 링크를 경유하지 않는 일반 파일인지 확인한다.
 * 링크라면 `readFileSync`/`writeFileSync`가 타깃을 따라가 저장소 밖 파일을 건드린다.
 */
function assertRegularFile(relPath) {
  let stat
  try {
    stat = lstatSync(join(REPO_ROOT, relPath))
  } catch (error) {
    throw new GuardError(`프로브 대상 상태를 읽지 못했다 (${relPath}): ${error.message}`)
  }
  if (stat.isSymbolicLink()) {
    throw new GuardError(
      `프로브 대상이 심볼릭 링크라 검증을 중단한다: ${relPath}\n` +
        '링크를 따라가면 저장소 밖 파일을 변조하게 된다. 실제 파일로 교체한 뒤 다시 실행하라.',
    )
  }
  if (!stat.isFile()) throw new GuardError(`프로브 대상이 일반 파일이 아니다: ${relPath}`)
}

/** 신규 파일 프로브가 놓일 디렉터리가 심볼릭 링크가 아닌 실제 디렉터리인지 확인한다. */
function assertRealDirectory(relPath) {
  let stat
  try {
    stat = lstatSync(join(REPO_ROOT, relPath))
  } catch (error) {
    throw new GuardError(`프로브 디렉터리 상태를 읽지 못했다 (${relPath}): ${error.message}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new GuardError(
      `프로브 파일을 놓을 경로가 실제 디렉터리가 아니다: ${relPath}\n` +
        '심볼릭 링크를 경유하면 저장소 밖에 파일을 쓰게 된다.',
    )
  }
}

/**
 * 추적 파일 끝에 프로브 마커를 붙이고 원본 바이트를 복원용으로 보관한다.
 * 원본이 개행으로 끝나면 빈 줄을 넣지 않는다 — 크래시 잔재가 정확히 마커 한 줄이어야
 * 사전 차단(층 2)의 안내 메시지가 실제 잔재와 일치한다.
 */
function appendMarker(relPath) {
  const absPath = join(REPO_ROOT, relPath)
  const original = readFileSync(absPath, 'utf8')
  originalContents.set(relPath, original)
  const separator = original.endsWith('\n') ? '' : '\n'
  writeFileSync(absPath, `${original}${separator}${PROBE_MARKER}\n`)
}

/** git 명령을 저장소 루트에서 실행하고 stdout을 돌려준다. */
function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const cause = result.signal ? `signal ${result.signal}` : `exit ${result.status}`
    throw new Error(`git ${args.join(' ')} 실패 (${cause}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** 워킹 트리 상태를 캡처한다. 사전 baseline과 사후 자기 검사가 같은 형식을 쓴다. */
function captureStatus() {
  return git(['status', '--porcelain'])
}

/**
 * 추적 파일 프로브 대상 중 미커밋 변경이 있는 경로를 돌려준다 (층 2).
 * 경로 매칭은 pathspec으로 git에 위임한다 — porcelain 라인을 직접 파싱하면
 * rename 표기(`R old -> new`)와 하위 디렉터리의 동명 파일에서 오판한다.
 */
function findDirtyProbeTargets(trackedProbePaths) {
  return trackedProbePaths.filter(
    (path) => git(['status', '--porcelain', '--', path]).trim() !== '',
  )
}

// --- 계약 로딩 ------------------------------------------------------------

/**
 * `turbo.json`에서 검증 대상을 파생한다 (M-2·M-3).
 *
 * 태스크 목록과 루트 설정 프로브 대상을 스크립트에 따로 적으면, 새 태스크나 새 공용 설정이
 * 검증 밖에서 태어나 이 토픽이 닫은 구멍이 그대로 재발한다. 파생하면 새 태스크는
 * `assertExpectedTaskIds`가 "초과"로, 오타 난 `globalDependencies` 항목은 아래 존재 확인이
 * 각각 큰 소리로 잡아낸다.
 *
 * @returns {{taskNames: string[], trackedProbePaths: string[]}}
 */
function loadContract() {
  const configPath = join(REPO_ROOT, 'turbo.json')
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new GuardError(
      `turbo.json을 읽지 못했다: ${error.message}\n` +
        'turbo는 JSONC(주석)를 허용하지만 이 로더는 순수 JSON만 읽는다. ' +
        '주석을 넣었다면 제거하거나 이 로더를 JSONC 대응으로 확장하라.',
    )
  }

  if (config.tasks === null || typeof config.tasks !== 'object') {
    throw new GuardError('turbo.json에 tasks 객체가 없다')
  }
  const taskNames = Object.keys(config.tasks).filter((name) => name !== TRANSIT_TASK)
  if (taskNames.length === 0) throw new GuardError('turbo.json에 검증할 태스크가 없다')

  // 아래 두 조건은 환경 문제가 아니라 계약 파손이라 EXIT_GUARD가 아닌 EXIT_FAIL로 끝난다 —
  // `globalDependencies`가 비면 루트 설정 변경이 어떤 태스크도 무효화하지 못하고,
  // 항목에 오타가 나면 turbo가 그 항목을 조용히 무시해 같은 구멍이 생긴다.
  const declared = config.globalDependencies
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      'turbo.json에 globalDependencies가 없다 — 루트 공용 설정 전파 계약(Probe B)이 성립하지 않는다.',
    )
  }

  for (const path of declared) {
    if (typeof path !== 'string' || path === '') {
      throw new GuardError(
        `globalDependencies 항목이 문자열 경로가 아니다: ${JSON.stringify(path)}`,
      )
    }
    if (GLOB_CHARS.test(path)) {
      throw new GuardError(
        `globalDependencies 항목이 glob 패턴이라 프로브가 변조 대상을 특정할 수 없다: ${path}\n` +
          '단일 파일 경로로 바꾸거나, 이 스크립트에 glob 전개를 추가하라.',
      )
    }
    if (path.split('/').includes('..')) {
      throw new GuardError(`globalDependencies 항목이 저장소 밖을 가리킨다: ${path}`)
    }
    if (!existsSync(join(REPO_ROOT, path))) {
      throw new Error(
        `globalDependencies 항목에 해당하는 파일이 없다 (오타?): ${path}\n` +
          'turbo는 존재하지 않는 항목을 조용히 무시하므로, 오타는 전 태스크가 cache hit하는 구멍이 된다.',
      )
    }
    assertRegularFile(path)
  }

  return { taskNames, trackedProbePaths: declared }
}

/**
 * 프로브 목록을 만든다. Probe A는 전파·격리를 함께 보고, Probe B는 `globalDependencies`
 * 항목 하나당 하나씩 생겨 전 태스크 전파를 본다.
 */
function buildProbes(trackedProbePaths) {
  const probes = [
    {
      name: 'Probe A',
      description: 'shared 패키지에 신규 소스 파일 추가 → 의존 패키지로 전파, 비의존 패키지는 격리',
      same: ISOLATED_TASK_IDS,
      apply: () => {
        // 복원 대상 등록을 파일 생성보다 먼저 한다. 생성이 실패해도 정리 경로가 열려 있게 한다.
        newFileProbeActive = true
        writeFileSync(join(REPO_ROOT, NEW_FILE_PROBE), NEW_FILE_PROBE_CONTENT)
      },
    },
  ]
  trackedProbePaths.forEach((relPath, index) => {
    probes.push({
      name: `Probe B${index + 1}`,
      description: `루트 공용 설정 ${relPath} 변경 → 전 태스크로 전파`,
      same: [],
      apply: () => appendMarker(relPath),
    })
  })
  return probes
}

// --- 측정 · 단정 ----------------------------------------------------------

/**
 * `turbo run --dry=json`을 실행해 taskId → {hash, dependsOn} 맵으로 접는다 (T2.4).
 * 스크립트가 없는 태스크(`<NONEXISTENT>`)를 먼저 제외한다 — transit 보조 노드와
 * @muhan/port의 미정의 태스크가 여기서 걸러져 실존 태스크만 남는다.
 */
function collectTaskState(taskNames) {
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', ...taskNames, '--dry=json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const cause = result.signal ? `signal ${result.signal}` : `exit ${result.status}`
    throw new Error(`turbo --dry=json 실패 (${cause}): ${result.stderr.trim()}`)
  }

  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`turbo --dry=json 출력을 JSON으로 파싱하지 못했다: ${error.message}`)
  }
  if (!Array.isArray(parsed.tasks)) {
    throw new Error('turbo --dry=json 출력에 tasks 배열이 없다')
  }

  const state = new Map()
  for (const task of parsed.tasks) {
    if (task.command === '<NONEXISTENT>') continue
    state.set(task.taskId, { hash: task.hash, dependsOn: task.resolvedTaskDefinition?.dependsOn })
  }
  return state
}

/**
 * baseline 맵이 기대 taskId 집합과 정확히 일치하는지 확인한다 (T2.5).
 * 누락은 계약이 가리키던 태스크가 사라졌다는 뜻이고, 초과는 계약 밖에서 태스크가
 * 늘었다는 뜻이다. 둘 다 조용히 통과시키면 비교가 무의미해진다.
 */
function assertExpectedTaskIds(state) {
  const actual = [...state.keys()]
  const missing = EXPECTED_TASK_IDS.filter((id) => !state.has(id))
  const unexpected = actual.filter((id) => !EXPECTED_TASK_IDS.includes(id))

  if (missing.length === 0 && unexpected.length === 0) return

  console.error('기대 taskId 집합이 실제 turbo 출력과 다르다.')
  if (missing.length > 0) console.error(`  누락 (${missing.length}건): ${missing.join(', ')}`)
  if (unexpected.length > 0)
    console.error(`  초과 (${unexpected.length}건): ${unexpected.join(', ')}`)
  console.error('  패키지·태스크 구성이 바뀌었다면 EXPECTED_TASK_IDS를 갱신하라.')
  throw new Error('기대 taskId 단정 실패')
}

/**
 * 각 태스크의 `resolvedTaskDefinition.dependsOn`이 계약과 일치하는지 확인한다 (M-1).
 * 해시 프로브가 보지 못하는 축이다 — `["transit"]`을 `["^type-check"]`로 바꾸면
 * 해시 전파는 똑같아 전 프로브가 통과하지만 병렬 실행이 사라진다.
 */
function assertDependsOnContract(state) {
  const violations = []
  for (const [taskId, entry] of state) {
    const taskName = taskId.slice(taskId.lastIndexOf('#') + 1)
    const expected = EXPECTED_DEPENDS_ON[taskName]
    if (expected === undefined) {
      violations.push(`${taskId}: 계약에 없는 태스크 — EXPECTED_DEPENDS_ON에 기대 형태를 추가하라`)
      continue
    }
    const actual = entry.dependsOn
    const matches =
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((dep, index) => actual[index] === dep)
    if (!matches) {
      violations.push(
        `${taskId}: 기대 ${JSON.stringify(expected)} · 실제 ${JSON.stringify(actual)}`,
      )
    }
  }

  if (violations.length === 0) return

  console.error('dependsOn 계약이 실제 turbo 설정과 다르다.')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    `  type-check·lint는 ${JSON.stringify([TRANSIT_TASK])} 경유여야 병렬 실행이 유지된다. ` +
      '^task로 바꾸면 해시 전파는 같아도 상위 패키지 실행을 기다리는 직렬 빌드가 된다.',
  )
  throw new Error('dependsOn 계약 단정 실패')
}

/**
 * 인터럽트 테스트용 일시 정지 (T2.8).
 * blocking sleep이 아니라 타이머로 대기해 시그널 핸들러가 즉시 실행되게 한다.
 */
function pauseIfRequested() {
  const raw = process.env.TURBO_HASH_PROBE_PAUSE_MS
  if (!raw) return Promise.resolve()
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()
  console.log(`  (TURBO_HASH_PROBE_PAUSE_MS=${ms} — 변조 상태로 대기 중)`)
  return new Promise((resolve_) => setTimeout(resolve_, ms))
}

// --- 프로브 실행 ----------------------------------------------------------

/**
 * 프로브 하나를 실행하고 taskId별 판정 결과를 돌려준다 (T2.6).
 * 변조 → 대기 → 측정 → 즉시 복원 순서를 지켜 다음 프로브가 깨끗한 트리에서 시작하게 한다.
 */
async function runProbe(probe, baseline, taskNames) {
  console.log(`\n[${probe.name}] ${probe.description}`)

  probe.apply()

  let after
  let restoreVerdict
  try {
    await pauseIfRequested()
    after = collectTaskState(taskNames)
  } finally {
    restoreAll()
    restoreVerdict = verifyTreeRestored()
  }

  // 프로브별로 복원 성공을 확인한다. 앞 프로브의 잔재가 남은 채 다음 프로브를 돌리면
  // 오염된 트리가 "전부 CHANGED" 기대를 자동으로 만족시켜 허위 통과가 나온다.
  // 판정은 `finally` 밖에서 한다 — `finally` 안에서 던지면 측정 단계의 원인 예외가 가려진다.
  // 측정이 예외로 끝나면 여기 도달하지 않지만, 그 경로의 복원 검사는 최상위 `finally`가 맡는다.
  // 이 줄들을 `finally` 안으로 되돌리지 말 것.
  if (!restoreVerdict.ok) {
    throw new Error(
      `${probe.name} 복원 실패 — 이후 프로브를 중단한다.\n${restoreVerdict.reason}${recoveryHint()}`,
    )
  }

  const rows = EXPECTED_TASK_IDS.map((taskId) => {
    const before = baseline.get(taskId)?.hash
    const now = after.get(taskId)?.hash
    const observed = now === undefined ? 'MISSING' : before === now ? 'SAME' : 'CHANGED'
    const expected = probe.same.includes(taskId) ? 'SAME' : 'CHANGED'
    return { taskId, before, after: now, observed, expected, pass: observed === expected }
  })

  const width = Math.max(...EXPECTED_TASK_IDS.map((id) => id.length))
  for (const row of rows) {
    console.log(
      `  ${row.pass ? 'PASS' : 'FAIL'}  ${row.taskId.padEnd(width)}  ` +
        `${String(row.before).slice(0, 16).padEnd(16)} -> ${String(row.after).slice(0, 16).padEnd(16)}  ` +
        `${row.observed.padEnd(7)} (기대 ${row.expected})`,
    )
  }

  const failures = rows.filter((row) => !row.pass)
  console.log(`  → ${rows.length - failures.length}/${rows.length} 통과`)
  return failures.length === 0
}

// --- 메인 -----------------------------------------------------------------

/**
 * 층 1(자가 치유) + 층 2(사전 차단). 아무것도 변조하기 전에 돌며, 여기서 걸리는 조건은
 * 전부 `GuardError`라 EXIT_GUARD로 끝난다.
 */
function preflight(trackedProbePaths) {
  // 층 1: 이전 실행이 SIGKILL로 죽어 남긴 잔재를 baseline 캡처 전에 지운다.
  // 추적 여부와 내용을 모두 확인한 뒤에만 지운다 — 이 경로의 파일이 스크립트가 만든 것이
  // 아니면 사용자의 작업물이고, baseline 캡처 전 삭제는 사후 검사에 흡수되어 조용히 사라진다.
  const staleProbe = join(REPO_ROOT, NEW_FILE_PROBE)
  if (existsSync(staleProbe)) {
    let tracked
    try {
      tracked = git(['ls-files', '--', NEW_FILE_PROBE]).trim() !== ''
    } catch (error) {
      throw new GuardError(`워킹 트리 상태를 읽지 못했다 (git 저장소가 아닌가?): ${error.message}`)
    }
    if (tracked) {
      throw new GuardError(
        `프로브 전용 예약 경로가 git에 추적되고 있어 검증을 중단한다: ${NEW_FILE_PROBE}\n` +
          '이 경로는 스크립트가 소유한다. 해당 파일을 제거하거나 이름을 바꾼 뒤 다시 실행하라.',
      )
    }
    assertRegularFile(NEW_FILE_PROBE)
    let staleContent
    try {
      staleContent = readFileSync(staleProbe, 'utf8')
    } catch (error) {
      throw new GuardError(`프로브 잔재를 읽지 못했다 (${NEW_FILE_PROBE}): ${error.message}`)
    }
    if (staleContent !== NEW_FILE_PROBE_CONTENT) {
      throw new GuardError(
        `프로브 전용 예약 경로에 스크립트가 만들지 않은 내용이 있어 검증을 중단한다: ${NEW_FILE_PROBE}\n` +
          '이 경로는 스크립트가 소유한다. 내용을 확인해 옮기거나 지운 뒤 다시 실행하라.',
      )
    }
    try {
      unlinkSync(staleProbe)
    } catch (error) {
      throw new GuardError(`프로브 잔재를 제거하지 못했다 (${NEW_FILE_PROBE}): ${error.message}`)
    }
    console.log(`이전 실행의 프로브 잔재를 제거했다: ${NEW_FILE_PROBE}`)
  }

  assertRealDirectory(dirname(NEW_FILE_PROBE))

  // 층 2: 추적 파일 프로브 대상이 더티면 아무것도 변조하지 않는다.
  let dirtyProbeTargets
  try {
    baselineStatus = captureStatus()
    dirtyProbeTargets = findDirtyProbeTargets(trackedProbePaths)
  } catch (error) {
    throw new GuardError(`워킹 트리 상태를 읽지 못했다 (git 저장소가 아닌가?): ${error.message}`)
  }

  if (dirtyProbeTargets.length > 0) {
    throw new GuardError(
      '프로브 대상 파일에 미커밋 변경이 있어 검증을 중단한다.\n' +
        dirtyProbeTargets.map((path) => `  ${path}`).join('\n') +
        `\n해당 파일을 커밋·되돌린 뒤 다시 실행하라. 끝줄이 "${PROBE_MARKER}"라면 이전 실행의 잔재이므로 그 줄을 지우면 된다.`,
    )
  }
}

async function main() {
  console.log(`turbo 해시 계약 검증 (저장소 루트: ${REPO_ROOT})`)

  const { taskNames, trackedProbePaths } = loadContract()
  console.log(`검증 대상 태스크: ${taskNames.join(', ')}`)
  console.log(`루트 공용 설정 프로브: ${trackedProbePaths.join(', ')}`)

  preflight(trackedProbePaths)

  // baseline 수집 + 계약 단정 (taskId 집합 · dependsOn 형태).
  const baseline = collectTaskState(taskNames)
  assertExpectedTaskIds(baseline)
  assertDependsOnContract(baseline)
  console.log(`baseline 수집 완료 — 실존 태스크 ${baseline.size}개, dependsOn 계약 일치`)

  let allPassed = true
  probesAttempted = true
  for (const probe of buildProbes(trackedProbePaths)) {
    const passed = await runProbe(probe, baseline, taskNames)
    allPassed = allPassed && passed
  }

  console.log(allPassed ? '\n해시 계약 검증 통과' : '\n해시 계약 검증 실패')
  return allPassed ? EXIT_PASS : EXIT_FAIL
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`\n${error.message}`)
  process.exitCode = error instanceof GuardError ? EXIT_GUARD : EXIT_FAIL
} finally {
  // 층 4: 사후 자기 검사. 정상 종료·단정 실패·예외 어느 경로로 왔든 트리가 원상태여야 한다.
  restoreAll()
  const verdict = verifyTreeRestored()
  if (verdict.ok) {
    if (probesAttempted) {
      // 복원 재시도가 성공했더라도 앞서 실패 메시지가 출력됐을 수 있다.
      // 종료 코드로 문구를 갈라 "실패 직후 무설명 합격"으로 읽히지 않게 한다.
      console.log(
        process.exitCode === EXIT_PASS
          ? '\n워킹 트리 자기 검사 통과 — 실행 전후 상태 동일'
          : '\n워킹 트리 자기 검사 통과 — 위 실패에도 트리는 원상 복구됐다',
      )
    }
  } else {
    console.error(`\n사후 자기 검사 실패 — ${verdict.reason}${recoveryHint()}`)
    process.exitCode = EXIT_FAIL
  }
}
