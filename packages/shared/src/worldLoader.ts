import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
 * @throws 파일을 읽을 수 없거나 JSON 파싱에 실패하면 명시적 에러
 */
export function loadWorldFile<T = unknown>(
  relativePath: string,
  worldRoot: string = DEFAULT_WORLD_ROOT,
): T {
  const full = resolve(worldRoot, relativePath)

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
