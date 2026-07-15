import { describe, it, expect } from 'vitest'
import { makeSeededRng, nextIntInRange } from './seededRng.js'

// 시드 고정 PRNG(mulberry32)의 결정성·범위 계약을 검증한다. 의존 0 순수 함수이므로
// 골든 시퀀스 없이 비교 기반(같은 시드 동일·다른 시드 상이)으로 재현성을 확인한다.
describe('makeSeededRng', () => {
  it('같은 시드로 만든 두 인스턴스가 동일 시퀀스를 낸다', () => {
    const a = makeSeededRng(12345)
    const b = makeSeededRng(12345)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('다른 시드는 다른 시퀀스를 낸다', () => {
    const a = makeSeededRng(1)
    const b = makeSeededRng(2)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('출력이 항상 [0, 1) 범위다 (0 이상 1 미만)', () => {
    const rng = makeSeededRng(98765)
    for (let i = 0; i < 1000; i++) {
      const x = rng()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  // 동결된 골든 벡터. 비교 기반 테스트는 알고리즘이 조용히 바뀌어도 두 인스턴스가
  // 함께 변해 초록으로 남는다. 정본 mulberry32의 seed=12345 첫 5개 출력을 고정해
  // 우발적 상수·연산자 변경을 잡는다.
  it('정본 mulberry32 골든 시퀀스를 재현한다 (seed=12345)', () => {
    const rng = makeSeededRng(12345)
    const seq = Array.from({ length: 5 }, () => rng())
    expect(seq).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985,
      0.817934412509203, 0.5094283693470061,
    ])
  })

  it('음수 시드도 uint32로 강제돼 결정적이다', () => {
    const a = makeSeededRng(-1)
    const b = makeSeededRng(4294967295)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
  })
})

describe('nextIntInRange', () => {
  it('반환값이 [lo, hi] 범위(양끝 포함) 안에 있고 양끝을 실제로 관측한다', () => {
    const rng = makeSeededRng(555)
    const lo = 1
    const hi = 3
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 2000; i++) {
      const v = nextIntInRange(rng, lo, hi)
      expect(v).toBeGreaterThanOrEqual(lo)
      expect(v).toBeLessThanOrEqual(hi)
      expect(Number.isInteger(v)).toBe(true)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    // hi 도달 가능성 검증: off-by-one이면 max === hi를 관측하지 못한다.
    expect(min).toBe(lo)
    expect(max).toBe(hi)
  })

  it('같은 시드로 정수 시퀀스가 재현된다', () => {
    const a = makeSeededRng(42)
    const b = makeSeededRng(42)
    const seqA = Array.from({ length: 30 }, () => nextIntInRange(a, 0, 100))
    const seqB = Array.from({ length: 30 }, () => nextIntInRange(b, 0, 100))
    expect(seqA).toEqual(seqB)
  })

  it('lo == hi 경계에서 항상 그 값을 반환한다', () => {
    const rng = makeSeededRng(7)
    for (let i = 0; i < 50; i++) {
      expect(nextIntInRange(rng, 5, 5)).toBe(5)
    }
  })

  it('역전 범위(hi < lo)는 RangeError를 던진다', () => {
    const rng = makeSeededRng(7)
    expect(() => nextIntInRange(rng, 5, 1)).toThrow(RangeError)
  })
})
