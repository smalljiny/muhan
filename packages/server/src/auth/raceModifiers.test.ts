import { describe, it, expect } from 'vitest'
import { RACE_STAT_MODIFIERS, applyRaceModifiers } from './raceModifiers.js'

/**
 * 종족 스탯 보정 순수 헬퍼 단위 스펙 — a7 오라클 §7 표를 [힘,민첩,맷집,지식,신앙심] 순서로 이식한다.
 *
 * 핵심 불변식: 포인트바이 스탯에 보정을 더한 뒤 3~18 재클램프를 하지 않는다(as-shipped) —
 * 극단 배분 시 유효 스탯이 18 초과·3 미만이 될 수 있고 그대로 저장한다(#80 bonus()가 read-time 클램프).
 */
describe('RACE_STAT_MODIFIERS 테이블 (a7 §7 오라클 이식)', () => {
  it('8종족 각각을 [힘,민첩,맷집,지식,신앙심] 순서로 담는다', () => {
    expect(RACE_STAT_MODIFIERS[1]).toEqual([1, 0, 0, 0, -1]) // DWARF 힘+1 신앙-1
    expect(RACE_STAT_MODIFIERS[2]).toEqual([-1, 0, -1, 2, 0]) // ELF 지식+2 맷집-1 힘-1
    expect(RACE_STAT_MODIFIERS[3]).toEqual([0, 0, -1, 1, 0]) // HALFELF 지식+1 맷집-1
    expect(RACE_STAT_MODIFIERS[4]).toEqual([-1, 1, 0, 0, 0]) // HOBBIT 민첩+1 힘-1
    expect(RACE_STAT_MODIFIERS[5]).toEqual([0, 0, 1, 0, 0]) // HUMAN 맷집+1
    expect(RACE_STAT_MODIFIERS[6]).toEqual([1, -1, 1, -1, 0]) // ORC 힘+1 맷집+1 민첩-1 지식-1
    expect(RACE_STAT_MODIFIERS[7]).toEqual([2, 0, 0, -1, -1]) // HALFGIANT 힘+2 지식-1 신앙-1
    expect(RACE_STAT_MODIFIERS[8]).toEqual([-1, 0, 0, 0, 1]) // GNOME 신앙+1 힘-1
  })
})

describe('applyRaceModifiers (포인트바이 후 종족 보정 적용)', () => {
  it('포인트바이 스탯에 종족 보정을 원소별로 더한다 (HUMAN 맷집+1)', () => {
    expect(applyRaceModifiers([10, 10, 10, 10, 10], 5)).toEqual([10, 10, 11, 10, 10])
  })

  it('ELF 보정을 정확히 더한다 (힘-1 맷집-1 지식+2)', () => {
    expect(applyRaceModifiers([12, 12, 12, 12, 6], 2)).toEqual([11, 12, 11, 14, 6])
  })

  it('보정 후 3~18을 벗어나도 재클램프하지 않는다 (as-shipped, 양방향 증거)', () => {
    // HALFGIANT [+2,0,0,-1,-1]: 힘 18→20(>18), 신앙 3→2(<3) 둘 다 미클램프.
    expect(applyRaceModifiers([18, 3, 3, 18, 3], 7)).toEqual([20, 3, 3, 17, 2])
  })

  it('입력 스탯 튜플을 변형하지 않고 새 튜플을 반환한다 (불변성)', () => {
    const input: [number, number, number, number, number] = [10, 10, 10, 10, 10]
    const out = applyRaceModifiers(input, 1)
    expect(input).toEqual([10, 10, 10, 10, 10])
    expect(out).not.toBe(input)
  })

  it('알 수 없는 종족 코드는 보정 없이 원본 복사본을 반환한다 (방어)', () => {
    const input: [number, number, number, number, number] = [10, 10, 10, 10, 10]
    const out = applyRaceModifiers(input, 99)
    expect(out).toEqual([10, 10, 10, 10, 10])
    expect(out).not.toBe(input)
  })
})
