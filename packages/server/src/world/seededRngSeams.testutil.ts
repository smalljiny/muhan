import { makeSeededRng, nextIntInRange } from 'shared'
import type { SpawnRng } from './randomSpawn.js'
import type { CreatureRng } from './creatureFactory.js'

/**
 * 시드 결정적 스폰 seam 어댑터 — server 소유 `SpawnRng`·`CreatureRng` seam을 shared
 * `seededRng`(mulberry32)로 구현한다. 테스트가 재현 가능한 확률·loot 굴림을 주입할 때 쓴다
 * (server→shared 정방향 의존, 역방향/순환 없음).
 *
 * 미주입 시 조립 지점 기본 stub은 이 어댑터가 아니라 seam 정의부의 결정적 기본값이다 —
 * `SpawnRng`는 `defaultSpawnRng`(randomSpawn.ts: traffic 게이트 항상 실패로 비발화),
 * `CreatureRng`는 `defaultCreatureRng`(creatureFactory.ts: gold identity). 두 기본값은
 * neverFireRng가 아니라 각 seam 파일이 소유한 결정적 no-op 계열이다. 이 어댑터는 그 기본
 * 대신 실제 시드 굴림을 원하는 테스트가 명시 주입할 때만 등장한다.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽
 * glob에서 자동 제외된다(테스트 인프라, 프로덕션 코드 아님).
 */

/**
 * 시드 하나로 `SpawnRng` seam을 만든다. 세 메서드가 단일 rng 클로저를 공유하므로 호출마다
 * 상태가 전진해 결정적 시퀀스를 이룬다(같은 시드 → 같은 호출 순서 → 같은 출력).
 */
export function seededSpawnRng(seed: number): SpawnRng {
  const rng = makeSeededRng(seed)
  return {
    roll100: () => nextIntInRange(rng, 1, 100),
    pickIndex: (len: number) => nextIntInRange(rng, 0, len - 1),
    groupSize: (max: number) => nextIntInRange(rng, 1, max),
  }
}

/**
 * 시드 하나로 `CreatureRng` seam을 만든다. base gold를 받아 `[0, baseGold]` 정수를 낸다.
 * 같은 시드·같은 baseGold·같은 호출 순서 → 같은 출력.
 */
export function seededCreatureRng(seed: number): CreatureRng {
  const rng = makeSeededRng(seed)
  return (baseGold: number) => nextIntInRange(rng, 0, baseGold)
}
