import { describe, it } from 'vitest'
import fc from 'fast-check'
import { effectiveStat } from './effectiveStat.js'
import {
  intInRangeArb,
  positiveStatModifiersArb,
  statModifiersArb,
} from '../property/arbitraries.testutil.js'
import { assertInRange } from '../property/invariants.js'

// effectiveStat의 무clamp 가산 계약을 property 축에서 검증한다. 임의 base·modifier 집합에
// 대해 결과가 정확히 base + Σ delta이며, [3, 18] 같은 상한 clamp가 없어 유효값이 18을
// 초과할 수 있어야 한다.
describe('effectiveStat 무clamp 가산 property', () => {
  // T6.2 가산 계약: 결과가 정확히 base + Σ delta다. delta 합을 SUT 구현과 독립적으로
  // 별도 reduce로 계산해 기대값을 잡고, assertInRange의 exact 경계 [expected, expected]로
  // 동등성을 검사한다(clamp가 있으면 극단 입력에서 이 등식이 깨진다).
  it('결과가 base + Σ delta와 정확히 같다', () => {
    fc.assert(
      fc.property(intInRangeArb(-1000, 1000), statModifiersArb, (base, mods) => {
        const deltaSum = mods.reduce((sum, mod) => sum + mod.delta, 0)
        const expected = base + deltaSum
        assertInRange(effectiveStat(base, mods), expected, expected, 'effectiveStat 가산')
      }),
    )
  })

  // T6.2 무clamp 관측: base=18에 1건 이상의 양수 delta를 더하면 결과가 항상 18을 초과한다.
  // [3, 18] 상한 clamp가 적용됐다면 이 property는 반례(<=18)에서 실패한다.
  it('base=18 + 양수 delta는 항상 18을 초과한다 (무clamp)', () => {
    fc.assert(
      fc.property(positiveStatModifiersArb, (mods) => {
        // 결과 하한은 18 + (최소 1건 × delta>=1) = 19. 상한 clamp가 없으므로 상한은 열려 있다.
        assertInRange(effectiveStat(18, mods), 19, Number.MAX_SAFE_INTEGER, 'effectiveStat 무clamp')
      }),
    )
  })
})
