import { describe, it, expect } from 'vitest'
import { seededSpawnRng, seededCreatureRng } from './seededRngSeams.testutil.js'

/**
 * 시드 결정적 스폰 seam 어댑터 계약 테스트 — server 소유 `SpawnRng`·`CreatureRng` seam을
 * shared `seededRng`로 구현한 어댑터가 (1) 각 메서드 범위를 준수하고 (2) 같은 시드에서 동일
 * 호출 시퀀스가 동일 출력을 재현함을 실증한다.
 *
 * 결정성 검증은 리터럴 mulberry32 출력을 단정하지 않고 같은 시드 두 인스턴스의 출력을 대조한다
 * (알고리즘 재튜닝에 결합되지 않는 강건한 재현 검사).
 */

describe('seededSpawnRng', () => {
  it('roll100()은 [1,100] 범위이고 양끝 근처를 관측한다', () => {
    const rng = seededSpawnRng(12345)
    const samples = Array.from({ length: 5000 }, () => rng.roll100())
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    expect(min).toBeGreaterThanOrEqual(1)
    expect(max).toBeLessThanOrEqual(100)
    // 시드 고정이라 결정적 — 5000 샘플이면 양끝에 근접 관측.
    expect(min).toBeLessThanOrEqual(2)
    expect(max).toBeGreaterThanOrEqual(99)
  })

  it('pickIndex(len)은 [0, len-1] 범위다', () => {
    const rng = seededSpawnRng(777)
    const len = 10
    const samples = Array.from({ length: 5000 }, () => rng.pickIndex(len))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...samples)).toBeLessThanOrEqual(len - 1)
    // 상·하한 도달 관측.
    expect(Math.min(...samples)).toBe(0)
    expect(Math.max(...samples)).toBe(len - 1)
  })

  it('groupSize(max)는 [1, max] 범위이고 상·하한을 관측한다', () => {
    const rng = seededSpawnRng(42)
    const max = 5
    const samples = Array.from({ length: 5000 }, () => rng.groupSize(max))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...samples)).toBeLessThanOrEqual(max)
    // 상·하한 도달 관측.
    expect(Math.min(...samples)).toBe(1)
    expect(Math.max(...samples)).toBe(max)
  })

  it('같은 시드 두 인스턴스는 동일 혼합 호출 시퀀스에서 동일 출력을 재현한다', () => {
    const a = seededSpawnRng(9001)
    const b = seededSpawnRng(9001)
    const seqA: number[] = []
    const seqB: number[] = []
    for (let i = 0; i < 100; i += 1) {
      seqA.push(a.roll100(), a.pickIndex(10), a.groupSize(5))
      seqB.push(b.roll100(), b.pickIndex(10), b.groupSize(5))
    }
    expect(seqA).toEqual(seqB)
  })

  it('다른 시드는 서로 다른 시퀀스를 낸다', () => {
    const a = seededSpawnRng(1)
    const b = seededSpawnRng(2)
    const seqA = Array.from({ length: 50 }, () => a.roll100())
    const seqB = Array.from({ length: 50 }, () => b.roll100())
    expect(seqA).not.toEqual(seqB)
  })
})

describe('seededCreatureRng', () => {
  it('(baseGold)는 [0, baseGold] 범위이고 양끝 근처를 관측한다', () => {
    const rng = seededCreatureRng(55555)
    const baseGold = 1000
    const samples = Array.from({ length: 5000 }, () => rng(baseGold))
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(baseGold)
    // 시드 고정 — 양끝 근접 관측.
    expect(min).toBeLessThanOrEqual(2)
    expect(max).toBeGreaterThanOrEqual(baseGold - 2)
  })

  it('같은 시드·같은 baseGold는 동일 출력 시퀀스를 재현한다', () => {
    const a = seededCreatureRng(2026)
    const b = seededCreatureRng(2026)
    const seqA = Array.from({ length: 100 }, () => a(1000))
    const seqB = Array.from({ length: 100 }, () => b(1000))
    expect(seqA).toEqual(seqB)
  })

  it('다른 시드는 서로 다른 출력 시퀀스를 낸다', () => {
    const a = seededCreatureRng(1)
    const b = seededCreatureRng(2)
    const seqA = Array.from({ length: 50 }, () => a(1000))
    const seqB = Array.from({ length: 50 }, () => b(1000))
    expect(seqA).not.toEqual(seqB)
  })
})
