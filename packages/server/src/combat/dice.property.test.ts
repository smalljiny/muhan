import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { intInRangeArb } from 'shared/property/arbitraries.testutil'
import { dice, mdice } from './dice.js'
import { maxRollRng, minRollRng } from './dice.testutil.js'

/**
 * dice 공식 property 테스트 — 바이트 검증 공식 `dice(n,s,p)=p+Σⁿ mrand(1,s)`를 임의 (n,s,p)에서
 * 실증한다. 핵심은 RNG의 *호출 인자*를 고정하는 것 — 인자를 무시하는 시퀀스 RNG는 off-by-one을
 * 놓친다. args-sensitive RNG 2종을 주입한다:
 *   - maxRollRng((_,max)=>max): mrand(1,s) 상한 → dice === p + n*s (2nd 인자가 s임을 고정)
 *   - minRollRng((min)=>min):   mrand(1,s) 하한 → dice === p + n*1 (1st 인자가 1임을 고정)
 * 두 property가 함께 mrand가 정확히 (1, s)로 n번 호출됨을 pin한다.
 */
describe('dice 공식 property (바이트 검증)', () => {
  const nArb = intInRangeArb(0, 12)
  const sArb = intInRangeArb(1, 500)
  const pArb = intInRangeArb(-20, 5700)

  it('max-반환 rng → dice(n,s,p) === p + n*s (상한 inclusive, 2nd 인자=s)', () => {
    fc.assert(
      fc.property(nArb, sArb, pArb, (n, s, p) => {
        expect(dice(n, s, p, maxRollRng)).toBe(p + n * s)
      }),
    )
  })

  it('min-반환 rng → dice(n,s,p) === p + n (하한 inclusive, 1st 인자=1)', () => {
    fc.assert(
      fc.property(nArb, sArb, pArb, (n, s, p) => {
        expect(dice(n, s, p, minRollRng)).toBe(p + n)
      }),
    )
  })

  it('mdice(entity) === dice(ndice,sdice,pdice) (임의 구조·rng)', () => {
    fc.assert(
      fc.property(nArb, sArb, pArb, (ndice, sdice, pdice) => {
        const entity = { ndice, sdice, pdice }
        expect(mdice(entity, maxRollRng)).toBe(dice(ndice, sdice, pdice, maxRollRng))
      }),
    )
  })
})
