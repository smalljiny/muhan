import { describe, it, expect } from 'vitest'
import { assertInRange, assertMonotonic } from './invariants.js'

// property 공통 불변식 assert의 계약을 검증한다. 순수 함수(fast-check 무의존)이므로
// 통과 케이스(무동작)·위반 케이스(반례 포함 throw)를 직접 대조한다.
describe('assertInRange', () => {
  it('범위 안이면 throw하지 않는다', () => {
    expect(() => assertInRange(5, 0, 10, 'x')).not.toThrow()
  })

  it('경계값(lo·hi)은 범위 안으로 취급해 throw하지 않는다', () => {
    expect(() => assertInRange(0, 0, 10, 'x')).not.toThrow()
    expect(() => assertInRange(10, 0, 10, 'x')).not.toThrow()
  })

  it('x < lo이면 throw하고 메시지에 반례 값·lo·hi·label을 담는다', () => {
    let caught: Error | undefined
    try {
      assertInRange(-3, 0, 10, 'dexterity')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = caught?.message ?? ''
    expect(msg).toContain('-3')
    expect(msg).toContain('0')
    expect(msg).toContain('10')
    expect(msg).toContain('dexterity')
  })

  it('x > hi이면 throw하고 메시지에 반례 값·lo·hi·label을 담는다', () => {
    let caught: Error | undefined
    try {
      assertInRange(42, 0, 10, 'equipArmor')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = caught?.message ?? ''
    expect(msg).toContain('42')
    expect(msg).toContain('0')
    expect(msg).toContain('10')
    expect(msg).toContain('equipArmor')
  })
})

describe('assertMonotonic non-increasing', () => {
  it('비증가 배열이면 throw하지 않는다', () => {
    expect(() => assertMonotonic([5, 5, 3, 1, 0], 'non-increasing', 'ac')).not.toThrow()
  })

  it('증가 지점이 있으면 throw하고 메시지에 위반 인덱스·값·label을 담는다', () => {
    let caught: Error | undefined
    try {
      assertMonotonic([5, 3, 7, 1], 'non-increasing', 'acByArmor')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = caught?.message ?? ''
    // 위반 인덱스 2(값 3 → 7이 증가)
    expect(msg).toContain('2')
    expect(msg).toContain('3')
    expect(msg).toContain('7')
    expect(msg).toContain('acByArmor')
  })
})

describe('assertMonotonic non-decreasing', () => {
  it('비감소 배열이면 throw하지 않는다', () => {
    expect(() => assertMonotonic([0, 1, 1, 3, 5], 'non-decreasing', 'ac')).not.toThrow()
  })

  it('감소 지점이 있으면 throw하고 메시지에 위반 인덱스·값·label을 담는다', () => {
    let caught: Error | undefined
    try {
      // 인덱스·prev·curr를 모두 다른 값(2·7·3)으로 골라 메시지의 세 필드를 판별력 있게 검증한다.
      assertMonotonic([0, 7, 3, 9], 'non-decreasing', 'thaco')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = caught?.message ?? ''
    // 위반 인덱스 2(값 7 → 3이 감소)
    expect(msg).toContain('2')
    expect(msg).toContain('7')
    expect(msg).toContain('3')
    expect(msg).toContain('thaco')
  })
})

describe('assertMonotonic 경계', () => {
  it('빈 배열은 단조성이 자명 충족이라 throw하지 않는다', () => {
    expect(() => assertMonotonic([], 'non-increasing', 'e')).not.toThrow()
    expect(() => assertMonotonic([], 'non-decreasing', 'e')).not.toThrow()
  })

  it('단일 원소 배열은 단조성이 자명 충족이라 throw하지 않는다', () => {
    expect(() => assertMonotonic([7], 'non-increasing', 's')).not.toThrow()
    expect(() => assertMonotonic([7], 'non-decreasing', 's')).not.toThrow()
  })

  it('동값 연속(평탄)은 non-increasing·non-decreasing 양쪽을 충족한다', () => {
    expect(() => assertMonotonic([4, 4, 4, 4], 'non-increasing', 'flat')).not.toThrow()
    expect(() => assertMonotonic([4, 4, 4, 4], 'non-decreasing', 'flat')).not.toThrow()
  })
})
