import { describe, it } from 'vitest'
import fc from 'fast-check'
import { computeAc } from './computeAc.js'
import { computeAcInputArb, intInRangeArb } from '../property/arbitraries.testutil.js'
import { assertInRange, assertMonotonic } from '../property/invariants.js'

// compute_ac(방어도) oracle에 property 프레임워크를 shared 축에서 시연한다.
// 재사용 arbitraries(computeAcInputArb·intInRangeArb)와 invariants(assertInRange·
// assertMonotonic)를 소비해, 특정 값 골든이 아니라 전 입력 도메인에 걸친 계약
// (범위·단조성)을 실제 SUT(computeAc)로 검증한다.
describe('computeAc property', () => {
  // T6.1 범위: 모든 입력에서 결과가 [-127, 127] clamp 계약을 만족한다.
  // assertInRange를 소비하며, 기대값을 공식으로 재계산하지 않고(tautology 금지)
  // 실제 computeAc 출력만 범위 검사한다.
  it('모든 입력에서 결과가 [-127, 127] 안에 있다', () => {
    fc.assert(
      fc.property(computeAcInputArb, (input) => {
        assertInRange(computeAc(input), -127, 127, 'computeAc')
      }),
    )
  })

  // T6.2 equipArmor 단조성: equipArmor 증가 ⇒ AC 비증가.
  // 고정 필드(dexterity·protection)도 arbitrary로 잡되 쌍 안에서 동일하게 유지해,
  // clamp되지 않은 영역까지 fast-check가 탐색하도록 한다(vacuity 방지). armor lo<hi ⇒
  // computeAc(lo) >= computeAc(hi) 이므로 [computeAc(lo), computeAc(hi)]는 non-increasing.
  it('equipArmor가 커지면 AC가 비증가한다', () => {
    fc.assert(
      fc.property(
        intInRangeArb(-50, 400),
        intInRangeArb(-50, 400),
        intInRangeArb(0, 127),
        fc.boolean(),
        (armorA, armorB, dexterity, protection) => {
          const lo = Math.min(armorA, armorB)
          const hi = Math.max(armorA, armorB)
          assertMonotonic(
            [
              computeAc({ dexterity, equipArmor: lo, protection }),
              computeAc({ dexterity, equipArmor: hi, protection }),
            ],
            'non-increasing',
            'acByArmor',
          )
        },
      ),
    )
  })

  // T6.2 dexterity 단조성: dexterity 증가 ⇒ bonus 비감소 ⇒ -5*bonus 비증가 ⇒ AC 비증가.
  // 즉 dex1 <= dex2 ⇒ computeAc(dex1) >= computeAc(dex2) (다른 필드 고정).
  // 고정 필드(equipArmor·protection)도 쌍 안에서 동일하게 유지한다.
  it('dexterity가 커지면 AC가 비증가한다', () => {
    fc.assert(
      fc.property(
        intInRangeArb(0, 127),
        intInRangeArb(0, 127),
        intInRangeArb(-50, 400),
        fc.boolean(),
        (dexA, dexB, equipArmor, protection) => {
          const lo = Math.min(dexA, dexB)
          const hi = Math.max(dexA, dexB)
          assertMonotonic(
            [
              computeAc({ dexterity: lo, equipArmor, protection }),
              computeAc({ dexterity: hi, equipArmor, protection }),
            ],
            'non-increasing',
            'acByDex',
          )
        },
      ),
    )
  })
})
