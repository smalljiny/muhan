import { describe, it, expect } from 'vitest'
import { makeSeededRng, nextIntInRange } from 'shared'
import { randEnchant } from './enchant.js'

/**
 * randEnchant 확률 순수 함수 테스트 — 오라클 object.c rand_enchant의 확률표를 rng 주입으로 재현.
 *
 * 오라클 계약: m = mrand(1,100) 포함 구간 [1,100].
 *   m>98 → {99,100}    → +3 (2%)
 *   m>90 → {91..98}    → +2 (8%)
 *   m>50 → {51..90}    → +1 (40%)
 *   m≤50 → {1..50}     → 무변화 (50%)
 * 스펙 §2/a8의 "+3 3%"는 off-by-one 전사 오차(합 101%)다. 오라클 실값 2%를 구현한다.
 */
describe('randEnchant 경계 (고정 draw 스텁 주입)', () => {
  // rng 스텁: (min,max)=>draw. 각 경계 draw를 고정 반환해 분기 경계를 pin한다.
  const stub = (draw: number) => () => draw

  it('draw=50 → 무변화 (adjustment 0, enchanted false)', () => {
    expect(randEnchant(stub(50))).toEqual({ enchanted: false, adjustment: 0, pdiceDelta: 0 })
  })

  it('draw=51 → +1', () => {
    expect(randEnchant(stub(51))).toEqual({ enchanted: true, adjustment: 1, pdiceDelta: 1 })
  })

  it('draw=90 → +1 (>50 상단 경계)', () => {
    expect(randEnchant(stub(90))).toEqual({ enchanted: true, adjustment: 1, pdiceDelta: 1 })
  })

  it('draw=91 → +2 (>90 하단 경계)', () => {
    expect(randEnchant(stub(91))).toEqual({ enchanted: true, adjustment: 2, pdiceDelta: 2 })
  })

  it('draw=98 → +2 (>90 상단 경계, off-by-one 방지)', () => {
    expect(randEnchant(stub(98))).toEqual({ enchanted: true, adjustment: 2, pdiceDelta: 2 })
  })

  it('draw=99 → +3 (>98 하단 경계, off-by-one 방지)', () => {
    expect(randEnchant(stub(99))).toEqual({ enchanted: true, adjustment: 3, pdiceDelta: 3 })
  })

  it('draw=100 → +3 (포함 구간 상한)', () => {
    expect(randEnchant(stub(100))).toEqual({ enchanted: true, adjustment: 3, pdiceDelta: 3 })
  })

  it('draw=1 → 무변화 (포함 구간 하한)', () => {
    expect(randEnchant(stub(1))).toEqual({ enchanted: false, adjustment: 0, pdiceDelta: 0 })
  })

  it('rng는 (1,100) 포함 구간으로 호출된다', () => {
    let capturedMin = -1
    let capturedMax = -1
    const spy = (min: number, max: number): number => {
      capturedMin = min
      capturedMax = max
      return 50
    }
    randEnchant(spy)
    expect(capturedMin).toBe(1)
    expect(capturedMax).toBe(100)
  })
})

describe('randEnchant 분포 property (seeded Monte Carlo)', () => {
  it('N=100000 → +3≈2% +2≈8% +1≈40% 무≈50% 각 ±1.0%p 이내', () => {
    // 단일 시드 상태를 N번 공유 — 매 호출 새 rng 생성은 결정성을 깬다.
    const r = makeSeededRng(0x1234abcd)
    const rng = (min: number, max: number): number => nextIntInRange(r, min, max)

    const N = 100000
    let c0 = 0
    let c1 = 0
    let c2 = 0
    let c3 = 0
    for (let i = 0; i < N; i++) {
      const { adjustment } = randEnchant(rng)
      if (adjustment === 3) c3++
      else if (adjustment === 2) c2++
      else if (adjustment === 1) c1++
      else c0++
    }

    const pct = (n: number): number => (n / N) * 100
    expect(pct(c3)).toBeGreaterThanOrEqual(1.0)
    expect(pct(c3)).toBeLessThanOrEqual(3.0)
    expect(pct(c2)).toBeGreaterThanOrEqual(7.0)
    expect(pct(c2)).toBeLessThanOrEqual(9.0)
    expect(pct(c1)).toBeGreaterThanOrEqual(39.0)
    expect(pct(c1)).toBeLessThanOrEqual(41.0)
    expect(pct(c0)).toBeGreaterThanOrEqual(49.0)
    expect(pct(c0)).toBeLessThanOrEqual(51.0)

    // 합은 정확히 N (모든 draw가 4분기 중 하나로 분류됨)
    expect(c0 + c1 + c2 + c3).toBe(N)
  })
})
