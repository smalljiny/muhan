#!/usr/bin/env node
/**
 * turbo 해시 계약 회귀 검증.
 *
 * `turbo run --dry=json`의 해시를 프로브 전후로 비교해 두 가지를 단정한다.
 *   - 전파: 상위 패키지(shared) 소스 변경이 하위(server·client) 태스크 해시에 반영된다.
 *   - 격리: 비의존 패키지(@muhan/port)는 그 변경에 영향받지 않는다.
 * 루트 공용 설정(tsconfig.base.json·eslint.config.js) 변경은 전 태스크에 반영된다.
 *
 * 프로브가 워킹 트리를 변조하므로 4중 보호를 둔다.
 *   1. 자가 치유 — 스크립트 전용 프로브 파일을 시작 시 무조건 제거한다.
 *   2. 사전 차단 — 추적 파일 프로브 대상이 이미 더티면 아무것도 건드리지 않고 종료한다.
 *   3. 복원 — finally·exit·시그널 어느 경로로 빠져나가도 restoreAll()이 돈다.
 *   4. 사후 자기 검사 — 종료 직전 워킹 트리가 시작 시점과 동일한지 스스로 확인한다.
 *
 * 종료 코드: 0 = 전 프로브 통과, 1 = 단정 실패 또는 사후 검사 실패, 2 = 사전 차단.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- 저장소 루트 고정 (T2.1) ---------------------------------------------
// 호출 디렉터리와 무관하게 스크립트 위치 기준으로 루트를 정한다.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_GUARD = 2

/** 신규 생성 방식 프로브. 스크립트 전용 이름이라 삭제가 항상 안전하다. */
const NEW_FILE_PROBE = 'packages/shared/src/__turbo_hash_probe__.ts'

/** 추적 파일 프로브 대상. 사전 차단(층 2)이 감시하는 경로다. */
const TRACKED_PROBE_PATHS = ['tsconfig.base.json', 'eslint.config.js']

const PROBE_MARKER = '// turbo-hash-probe'

/**
 * 기대 taskId 14개. `--dry=json`의 `tasks[]`는 스크립트가 없는 패키지의 태스크와
 * transit 보조 노드까지 포함하므로, `command === '<NONEXISTENT>'`를 걸러낸 뒤 이 목록과 대조한다.
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

/** 프로브 정의. `same`에 열거된 taskId는 SAME, 나머지 기대 taskId는 CHANGED여야 한다. */
const PROBES = [
  {
    name: 'Probe A',
    description: 'shared 패키지에 신규 소스 파일 추가 → 의존 패키지로 전파, 비의존 패키지는 격리',
    same: ['@muhan/port#lint', '@muhan/port#test'],
    apply: () => {
      // 복원 대상 등록을 파일 생성보다 먼저 한다. 생성이 실패해도 정리 경로가 열려 있게 한다.
      newFileProbeActive = true
      writeFileSync(join(REPO_ROOT, NEW_FILE_PROBE), 'export const __turboHashProbe = 1\n')
    },
  },
  {
    name: 'Probe B1',
    description: '루트 tsconfig.base.json 변경 → 전 태스크로 전파',
    same: [],
    apply: () => appendMarker('tsconfig.base.json'),
  },
  {
    name: 'Probe B2',
    description: '루트 eslint.config.js 변경 → 전 태스크로 전파',
    same: [],
    apply: () => appendMarker('eslint.config.js'),
  },
]

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
      console.error(`\n${signal} 처리 중 복원에 실패했다.\n${verdict.reason}`)
      process.exit(EXIT_FAIL)
    }
    process.exit(exitCode)
  })
}

// --- 유틸 -----------------------------------------------------------------

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
function findDirtyProbeTargets() {
  return TRACKED_PROBE_PATHS.filter(
    (path) => git(['status', '--porcelain', '--', path]).trim() !== '',
  )
}

/**
 * `turbo run --dry=json`을 실행해 taskId → hash 맵으로 접는다 (T2.4).
 * 스크립트가 없는 태스크(`<NONEXISTENT>`)를 먼저 제외한다 — transit 보조 노드와
 * @muhan/port의 미정의 태스크가 여기서 걸러져 실존 태스크만 남는다.
 */
function collectHashes() {
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', 'type-check', 'lint', 'test', '--dry=json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
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

  const hashes = new Map()
  for (const task of parsed.tasks) {
    if (task.command === '<NONEXISTENT>') continue
    hashes.set(task.taskId, task.hash)
  }
  return hashes
}

/**
 * baseline 맵이 기대 taskId 집합과 정확히 일치하는지 확인한다 (T2.5).
 * 누락은 계약이 가리키던 태스크가 사라졌다는 뜻이고, 초과는 계약 밖에서 태스크가
 * 늘었다는 뜻이다. 둘 다 조용히 통과시키면 비교가 무의미해진다.
 */
function assertExpectedTaskIds(hashes) {
  const actual = [...hashes.keys()]
  const missing = EXPECTED_TASK_IDS.filter((id) => !hashes.has(id))
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
async function runProbe(probe, baseline) {
  console.log(`\n[${probe.name}] ${probe.description}`)

  probe.apply()

  let after
  let restoreVerdict
  try {
    await pauseIfRequested()
    after = collectHashes()
  } finally {
    restoreAll()
    restoreVerdict = verifyTreeRestored()
  }

  // 프로브별로 복원 성공을 확인한다. 앞 프로브의 잔재가 남은 채 다음 프로브를 돌리면
  // 오염된 트리가 "전부 CHANGED" 기대를 자동으로 만족시켜 허위 통과가 나온다.
  // 판정은 `finally` 밖에서 한다 — `finally` 안에서 던지면 측정 단계의 원인 예외가 가려진다.
  if (!restoreVerdict.ok) {
    throw new Error(`${probe.name} 복원 실패 — 이후 프로브를 중단한다.\n${restoreVerdict.reason}`)
  }

  const rows = EXPECTED_TASK_IDS.map((taskId) => {
    const before = baseline.get(taskId)
    const now = after.get(taskId)
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

async function main() {
  console.log(`turbo 해시 계약 검증 (저장소 루트: ${REPO_ROOT})`)

  // 층 1: 자가 치유. 이전 실행이 SIGKILL로 죽어 남긴 잔재를 baseline 캡처 전에 지운다.
  // 삭제 전에 추적 여부를 확인한다 — 이 경로에 커밋된 파일이 있으면 baseline 캡처 전
  // 삭제가 baseline에 흡수되어 사후 검사가 통과하면서 파일이 사라진 채 끝난다.
  const staleProbe = join(REPO_ROOT, NEW_FILE_PROBE)
  if (existsSync(staleProbe)) {
    let tracked
    try {
      tracked = git(['ls-files', '--', NEW_FILE_PROBE]).trim() !== ''
    } catch (error) {
      console.error(`워킹 트리 상태를 읽지 못했다 (git 저장소가 아닌가?): ${error.message}`)
      return EXIT_GUARD
    }
    if (tracked) {
      console.error(
        `프로브 전용 예약 경로가 git에 추적되고 있어 검증을 중단한다: ${NEW_FILE_PROBE}`,
      )
      console.error(
        '이 경로는 스크립트가 소유한다. 해당 파일을 제거하거나 이름을 바꾼 뒤 다시 실행하라.',
      )
      return EXIT_GUARD
    }
    unlinkSync(staleProbe)
    console.log(`이전 실행의 프로브 잔재를 제거했다: ${NEW_FILE_PROBE}`)
  }

  // 층 2: 사전 차단. 추적 파일 프로브 대상이 더티면 아무것도 변조하지 않는다.
  let dirtyProbeTargets
  try {
    baselineStatus = captureStatus()
    dirtyProbeTargets = findDirtyProbeTargets()
  } catch (error) {
    console.error(`워킹 트리 상태를 읽지 못했다 (git 저장소가 아닌가?): ${error.message}`)
    return EXIT_GUARD
  }

  if (dirtyProbeTargets.length > 0) {
    console.error('프로브 대상 파일에 미커밋 변경이 있어 검증을 중단한다.')
    for (const path of dirtyProbeTargets) console.error(`  ${path}`)
    console.error(
      `해당 파일을 커밋·되돌린 뒤 다시 실행하라. 끝줄이 "${PROBE_MARKER}"라면 이전 실행의 잔재이므로 그 줄을 지우면 된다.`,
    )
    return EXIT_GUARD
  }

  // baseline 해시 수집 + 기대 taskId 단정.
  const baseline = collectHashes()
  assertExpectedTaskIds(baseline)
  console.log(`baseline 수집 완료 — 실존 태스크 ${baseline.size}개`)

  let allPassed = true
  probesAttempted = true
  for (const probe of PROBES) {
    const passed = await runProbe(probe, baseline)
    allPassed = allPassed && passed
  }

  console.log(allPassed ? '\n해시 계약 검증 통과' : '\n해시 계약 검증 실패')
  return allPassed ? EXIT_PASS : EXIT_FAIL
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`\n${error.message}`)
  process.exitCode = EXIT_FAIL
} finally {
  // 층 4: 사후 자기 검사. 정상 종료·단정 실패·예외 어느 경로로 왔든 트리가 원상태여야 한다.
  restoreAll()
  const verdict = verifyTreeRestored()
  if (verdict.ok) {
    if (probesAttempted) {
      console.log('\n워킹 트리 자기 검사 통과 — 실행 전후 상태 동일')
    }
  } else {
    console.error(`\n사후 자기 검사 실패 — ${verdict.reason}`)
    process.exitCode = EXIT_FAIL
  }
}
