import { describe, it } from 'vitest'
import fc from 'fast-check'
import { bonusOf } from './tables.js'
import { intInRangeArb } from '../property/arbitraries.testutil.js'
import { assertInRange } from '../property/invariants.js'

// bonusOf 룩업 clamp 계약을 property 축에서 검증한다. bonus[64] 값 범위는 [-4, 7]이고,
// bonusOf는 인덱스를 [0, 63]으로 clamp한 뒤 조회하므로 어떤 정수 score를 넣어도 결과가
// 항상 [-4, 7]에 있어야 한다. 골든 값이 아니라 실제 SUT(bonusOf) 출력만 범위 검사한다.
describe('bonusOf clamp property', () => {
  // T6.1 넓은 범위: 임의 정수 score에서 결과가 항상 [-4, 7] 안에 있다.
  it('넓은 범위 임의 score에서 결과가 [-4, 7] 안에 있다', () => {
    fc.assert(
      fc.property(intInRangeArb(-1000, 1000), (score) => {
        assertInRange(bonusOf(score), -4, 7, 'bonusOf')
      }),
    )
  })

  // T6.1 상한 방향: score > 63은 인덱스가 63으로 clamp되어 bonus[63]=7을 반환한다.
  // 상한 clamp가 동작함을 exact 경계 [7, 7]로 못박아 in-range를 vacuous하지 않게 증명한다.
  it('score > 63은 상한 clamp되어 [-4, 7] 안(=7)을 반환한다', () => {
    fc.assert(
      fc.property(intInRangeArb(64, 1_000_000), (score) => {
        assertInRange(bonusOf(score), 7, 7, 'bonusOf 상한 clamp → bonus[63]')
      }),
    )
  })

  // T6.1 하한 방향: score < 0은 인덱스가 0으로 clamp되어 bonus[0]=-4를 반환한다.
  // 하한 clamp가 동작함을 exact 경계 [-4, -4]로 못박는다.
  it('score < 0은 하한 clamp되어 [-4, 7] 안(=-4)을 반환한다', () => {
    fc.assert(
      fc.property(intInRangeArb(-1_000_000, -1), (score) => {
        assertInRange(bonusOf(score), -4, -4, 'bonusOf 하한 clamp → bonus[0]')
      }),
    )
  })
})
