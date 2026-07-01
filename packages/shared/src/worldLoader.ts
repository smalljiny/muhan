import { readFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 이 모듈(packages/shared/src 또는 dist) 기준으로 저장소 루트의 data/world를 해석한다.
// src·dist 모두 packages/shared 한 단계 아래이므로 동일하게 ../../../data/world → repo/data/world.
const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORLD_ROOT = resolve(HERE, '../../../data/world')

/**
 * `data/world` 아래 JSON 산출물을 읽어 파싱한다.
 *
 * @param relativePath `data/world` 루트 기준 상대 경로 (예: `rooms/r00000.json`)
 * @param worldRoot 루트 오버라이드 (기본: 저장소 `data/world`) — 테스트 격리에 사용
 * @throws worldRoot 경계를 벗어나거나(절대경로·`../` 이탈), 파일을 읽을 수 없거나 JSON 파싱에 실패하면 명시적 에러
 */
export function loadWorldFile<T = unknown>(
  relativePath: string,
  worldRoot: string = DEFAULT_WORLD_ROOT,
): T {
  const root = resolve(worldRoot)
  const full = resolve(root, relativePath)

  // worldRoot 경계 강제 — 절대경로·`../` 이탈을 차단하는 신뢰 경계.
  // 후속 에픽에서 서버 라우트가 사용자 입력 경로를 이 로더로 넘길 수 있으므로 기반부터 봉인한다.
  if (isAbsolute(relativePath) || relative(root, full).split(sep)[0] === '..') {
    throw new Error(`world 경로가 worldRoot를 벗어났습니다: ${relativePath}`)
  }

  let raw: string
  try {
    raw = readFileSync(full, 'utf8')
  } catch (err) {
    throw new Error(`world 파일을 읽을 수 없습니다: ${relativePath} (${full})`, { cause: err })
  }

  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`world 파일 JSON 파싱 실패: ${relativePath}`, { cause: err })
  }
}
