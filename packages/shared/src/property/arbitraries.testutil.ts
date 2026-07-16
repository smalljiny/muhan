/**
 * fast-check arbitrary 범위 생성기 — test-only.
 *
 * 이 파일은 fast-check를 import하므로 dist·커버리지에서 제외한다(`*.testutil.ts` glob).
 * Story 5·6의 property 테스트가 아래 세 생성기를 소비한다.
 */

import fc from 'fast-check'
import type { Arbitrary } from 'fast-check'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import type { StatKey } from '../stats/tables.js'
import type { StatModifier } from '../stats/effectiveStat.js'

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

/** 능력치 키(strength·dexterity·constitution·intelligence·piety) 5종 중 하나. */
const statKeyValues: readonly StatKey[] = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'piety',
]

/** `StatKey` 유니온 arbitrary. StatModifier.stat 필드 도메인과 일치. */
export const statKeyArb: Arbitrary<StatKey> = fc.constantFrom(...statKeyValues)

/**
 * `StatModifier` 한 건 arbitrary. delta는 음수를 포함하는 넓은 범위 `[-100, 100]`로 잡아
 * 가산·감산·상쇄가 모두 표본에 나오게 한다. source·stat은 임의 유효값.
 */
export const statModifierArb: Arbitrary<StatModifier> = fc.record({
  source: fc.string(),
  stat: statKeyArb,
  delta: intInRangeArb(-100, 100),
})

/** `StatModifier[]` arbitrary(빈 배열 포함). effectiveStat 무clamp 가산 property가 소비. */
export const statModifiersArb: Arbitrary<readonly StatModifier[]> = fc.array(statModifierArb)

/**
 * 양수 delta(`[1, 100]`) StatModifier를 1건 이상 담는 배열 arbitrary. base에 더하면 결과가
 * 반드시 base를 초과하므로 effectiveStat의 무clamp(상한 미적용) 관측 property가 소비한다.
 */
export const positiveStatModifiersArb: Arbitrary<readonly StatModifier[]> = fc.array(
  fc.record({ source: fc.string(), stat: statKeyArb, delta: intInRangeArb(1, 100) }),
  { minLength: 1 },
)
