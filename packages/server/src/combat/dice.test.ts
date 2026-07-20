import { describe, it, expect } from 'vitest'
import { dice, mdice } from './dice.js'
import { maxRollRng, minRollRng, seqRng } from './dice.testutil.js'

/**
 * dice/mdice 프리미티브 단위 테스트 — 오라클 `dice(n,s,p)=p+Σⁿ mrand(1,s)`(misc.c:454),
 * `mdice(a)=dice(a.ndice,a.sdice,a.pdice)`(mtype.h:588)를 결정적 rng 주입으로 검증한다.
 */
describe('dice', () => {
  it('dice(2,6,3) === 3+r1+r2 (주입 시퀀스 그대로 합산)', () => {
    // seqRng가 [4, 5]를 순서대로 반환 → 3 + 4 + 5 = 12.
    const rng = seqRng([4, 5])
    expect(dice(2, 6, 3, rng)).toBe(12)
  })

  it('rng를 정확히 (1, s)로 n번 호출한다', () => {
    const calls: Array<[number, number]> = []
    const spy = (min: number, max: number): number => {
      calls.push([min, max])
      return min
    }
    dice(3, 6, 0, spy)
    expect(calls).toEqual([
      [1, 6],
      [1, 6],
      [1, 6],
    ])
  })

  it('max-반환 rng → dice(n,s,p) === p + n*s (mrand [min,max] 상한 inclusive)', () => {
    expect(dice(4, 5, 2, maxRollRng)).toBe(2 + 4 * 5)
  })

  it('min-반환 rng → dice(n,s,p) === p + n*1 (mrand [min,max] 하한 inclusive)', () => {
    expect(dice(4, 5, 2, minRollRng)).toBe(2 + 4 * 1)
  })

  it('dice(0, s, p) === p (빈 합, rng 미호출)', () => {
    let called = false
    const spy = (min: number): number => {
      called = true
      return min
    }
    expect(dice(0, 6, 7, spy)).toBe(7)
    expect(called).toBe(false)
  })

  it('음수 pdice도 그대로 base로 더한다 (p는 임의 정수)', () => {
    expect(dice(2, 6, -3, minRollRng)).toBe(-3 + 2)
  })

  it('rng가 비정수를 반환하면 정수 계약 위반으로 throw한다', () => {
    const floatRng = (): number => 1.5
    expect(() => dice(2, 6, 0, floatRng)).toThrow()
  })
})

describe('mdice', () => {
  it('엔티티의 ndice/sdice/pdice를 dice로 위임한다', () => {
    const entity = { ndice: 4, sdice: 5, pdice: 2 }
    // maxRollRng → 2 + 4*5 = 22, dice(4,5,2)와 동일해야 한다.
    expect(mdice(entity, maxRollRng)).toBe(dice(4, 5, 2, maxRollRng))
  })

  it('mdice는 dice(ndice,sdice,pdice,rng)와 정확히 같은 값을 낸다 (시퀀스)', () => {
    const entity = { ndice: 2, sdice: 6, pdice: 3 }
    const rng = seqRng([4, 5])
    expect(mdice(entity, rng)).toBe(12)
  })
})
