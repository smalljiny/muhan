/**
 * fast-check arbitrary 범위 생성기 — test-only.
 *
 * 이 파일은 fast-check를 import하므로 dist·커버리지에서 제외한다(`*.testutil.ts` glob).
 * Story 5·6의 property 테스트가 아래 세 생성기를 소비한다.
 */

import fc from 'fast-check'
import type { Arbitrary } from 'fast-check'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'

/** 닫힌 정수 구간 `[lo, hi]`(양끝 포함) arbitrary. */
export function intInRangeArb(lo: number, hi: number): Arbitrary<number> {
  return fc.integer({ min: lo, max: hi })
}

/** uint32 시드 arbitrary(`0 <= seed <= 0xffffffff`). makeSeededRng 입력 도메인과 일치. */
export const seedArb: Arbitrary<number> = fc.integer({ min: 0, max: 0xffffffff })

/**
 * `ComputeAcInput` 구조체 arbitrary. dexterity·equipArmor는 `intInRangeArb`로 범위를
 * 잡고 protection은 boolean으로 조합한다. 게임 입력 도메인의 대표 범위를 덮되 clamp·
 * MIN cap 경계(dex>63, equipArmor 극단)까지 관측되도록 넉넉히 잡는다.
 */
export const computeAcInputArb: Arbitrary<ComputeAcInput> = fc.record({
  dexterity: intInRangeArb(0, 127),
  equipArmor: intInRangeArb(-50, 400),
  protection: fc.boolean(),
})
