import { describe, it, expect } from 'vitest'
import { resolveHpMax, resolveMpMax, clampVital } from './maxResolvers.js'
import { computeHpMax, computeMpMax } from '../stats/derived.js'
import type { EffectiveStatContext } from '../stats/context.js'

/**
 * class 인덱스(tables.ts:97-98 정본): 2=barbarian(권법가), 4=fighter(검사), 5=mage(도술사),
 * 9=invincible, 10=caretaker(초인). 초인 오버라이드는 HP 800·MP 600 고정(레벨 무관).
 */

/** computeHpMax/computeMpMax를 직접 호출하기 위한 폐형 입력 조립(판독 6필드는 더미). */
function closedFormContext(characterClass: number, level: number): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    characterClass,
    level,
    weaponAdjustment: 0,
    weaponProficiency: 0,
  }
}

describe('resolveHpMax', () => {
  it('일반직(fighter=4·mage=5·barbarian=2)에서 computeHpMax 폐형값과 동일값을 위임 반환한다', () => {
    for (const characterClass of [4, 5, 2]) {
      for (const level of [10, 50, 100]) {
        expect(resolveHpMax({ class: characterClass, level })).toBe(
          computeHpMax(closedFormContext(characterClass, level)),
        )
      }
    }
  })

  it('class===10(CARETAKER)이면 레벨과 무관하게 800 고정을 반환한다', () => {
    for (const level of [1, 50, 127]) {
      expect(resolveHpMax({ class: 10, level })).toBe(800)
    }
  })

  it('class===9(INVINCIBLE)은 오버라이드가 아니라 폐형값(computeHpMax)을 반환한다', () => {
    for (const level of [1, 50, 127]) {
      expect(resolveHpMax({ class: 9, level })).toBe(computeHpMax(closedFormContext(9, level)))
      // 9와 10 경계 검증: 초인만 800으로 갈린다.
      expect(resolveHpMax({ class: 9, level })).not.toBe(800)
    }
  })
})

describe('resolveMpMax', () => {
  it('일반직(fighter=4·mage=5·barbarian=2)에서 computeMpMax 폐형값과 동일값을 위임 반환한다', () => {
    for (const characterClass of [4, 5, 2]) {
      for (const level of [10, 50, 100]) {
        expect(resolveMpMax({ class: characterClass, level })).toBe(
          computeMpMax(closedFormContext(characterClass, level)),
        )
      }
    }
  })

  it('class===10(CARETAKER)이면 레벨과 무관하게 600 고정을 반환한다', () => {
    for (const level of [1, 50, 127]) {
      expect(resolveMpMax({ class: 10, level })).toBe(600)
    }
  })

  it('class===9(INVINCIBLE)은 오버라이드가 아니라 폐형값(computeMpMax)을 반환한다', () => {
    for (const level of [1, 50, 127]) {
      expect(resolveMpMax({ class: 9, level })).toBe(computeMpMax(closedFormContext(9, level)))
      expect(resolveMpMax({ class: 9, level })).not.toBe(600)
    }
  })
})

describe('clampVital', () => {
  it('current가 max를 초과하면 max로 내려간다', () => {
    expect(clampVital(950, 800)).toBe(800)
    expect(clampVital(1, 0)).toBe(0)
  })

  it('current가 max 이하면 그대로 유지한다', () => {
    expect(clampVital(500, 800)).toBe(500)
    expect(clampVital(0, 800)).toBe(0)
  })

  it('경계: current===max면 그대로 반환한다', () => {
    expect(clampVital(800, 800)).toBe(800)
  })
})
