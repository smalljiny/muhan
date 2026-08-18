import { describe, it, expect } from 'vitest'
import type { ObjectInstance } from 'shared'
import { projectEquipStats, type EquippedPair } from './equipStats.js'
import type { ObjectTemplate } from './objectTemplate.js'
import { makeObjectInstance, makeObjectTemplate } from './objectFixtures.testutil.js'

/**
 * 이 파일의 인스턴스 기본값은 **착용 상태**다 — projectEquipStats가 착용품만 집계하므로
 * 공용 픽스처의 중립 기본값(`equipped: false`)을 케이스마다 뒤집으면 의도가 흐려진다.
 */
function makeInstance(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return makeObjectInstance({ equipped: true, ...overrides })
}

/** 착용 쌍 팩토리. */
function pair(inst: Partial<ObjectInstance>, tmpl: Partial<ObjectTemplate>): EquippedPair {
  return { instance: makeInstance(inst), template: makeObjectTemplate(tmpl) }
}

describe('projectEquipStats', () => {
  it('세 기여 필드(equipArmor·weaponAdjustment·weaponProficiency)를 모두 반환한다', () => {
    const result = projectEquipStats([], 30)
    expect(result).toHaveProperty('equipArmor')
    expect(result).toHaveProperty('weaponAdjustment')
    expect(result).toHaveProperty('weaponProficiency')
  })

  it('equipArmor는 착용 아이템 armor의 합이다', () => {
    const equipped = [
      pair({ _id: 'a', slot: 0 }, { armor: 5 }),
      pair({ _id: 'b', slot: 1 }, { armor: 3 }),
    ]
    const result = projectEquipStats(equipped, 0)
    expect(result.equipArmor).toBe(8)
  })

  it('저주 장비(음수 armor)와 양수 armor가 섞이면 합의 부호가 유지된다', () => {
    const equipped = [
      pair({ _id: 'a', slot: 0 }, { armor: 4 }),
      pair({ _id: 'b', slot: 1 }, { armor: -10 }),
    ]
    const result = projectEquipStats(equipped, 0)
    expect(result.equipArmor).toBe(-6)
  })

  it('미착용(equipped=false) 아이템은 armor·weaponAdjustment에 기여하지 않는다', () => {
    // 오라클 compute_ac는 ready[](착용 슬롯)만 순회한다. 호출자가 전 인벤을 넘겨도
    // 미착용 아이템(백팩·stale slot)이 AC/THAC0를 오염시키지 못하게 seam이 방어한다.
    const items = [
      pair({ _id: 'worn', slot: 0, equipped: true }, { armor: 5 }),
      pair({ _id: 'backpack', slot: 1, equipped: false }, { armor: 100 }), // 미착용 고armor
      pair({ _id: 'stale-wield', slot: 19, equipped: false }, { type: 0, adjustment: 50 }), // 미착용 WIELD slot
    ]
    const result = projectEquipStats(items, 0)
    expect(result.equipArmor).toBe(5) // 착용된 것만 합산 (100 제외)
    expect(result.weaponAdjustment).toBe(0) // 미착용 WIELD slot 무기는 무시
  })

  it('weaponAdjustment는 WIELD 슬롯(19) 착용 무기의 adjustment다', () => {
    const equipped = [pair({ _id: 'w', slot: 19 }, { type: 0, adjustment: 3 })]
    const result = projectEquipStats(equipped, 0)
    expect(result.weaponAdjustment).toBe(3)
  })

  it('WIELD 슬롯 착용 아이템이 없으면 weaponAdjustment는 0이다', () => {
    const equipped = [pair({ _id: 'a', slot: 0 }, { armor: 5, adjustment: 7 })]
    const result = projectEquipStats(equipped, 0)
    expect(result.weaponAdjustment).toBe(0)
  })

  it('HELD 슬롯(16) 무기는 WIELD로 오인하지 않고, WIELD 것만 반영한다', () => {
    const equipped = [
      pair({ _id: 'held', slot: 16 }, { type: 0, adjustment: 9 }),
      pair({ _id: 'wield', slot: 19 }, { type: 0, adjustment: 2 }),
    ]
    const result = projectEquipStats(equipped, 0)
    expect(result.weaponAdjustment).toBe(2)
  })

  it('WIELD 무기와 방패(SHIELD)의 armor도 equipArmor 합에 포함된다', () => {
    const equipped = [
      pair({ _id: 'body', slot: 0 }, { armor: 2 }),
      pair({ _id: 'wield', slot: 19 }, { type: 0, armor: 1, adjustment: 3 }),
      pair({ _id: 'shield', slot: 17 }, { armor: 4 }),
    ]
    const result = projectEquipStats(equipped, 0)
    expect(result.equipArmor).toBe(7)
    expect(result.weaponAdjustment).toBe(3)
  })

  it('weaponProficiency 인자를 그대로 투영한다(빈 배열에서도)', () => {
    const result = projectEquipStats([], 77)
    expect(result.weaponProficiency).toBe(77)
  })

  it('빈 배열이면 equipArmor·weaponAdjustment는 0, weaponProficiency는 인자값이다', () => {
    const result = projectEquipStats([], 55)
    expect(result).toEqual({ equipArmor: 0, weaponAdjustment: 0, weaponProficiency: 55 })
  })

  it('입력 배열을 변형하지 않는다(immutability)', () => {
    const equipped = [pair({ _id: 'a', slot: 19 }, { armor: 5, adjustment: 3 })]
    const snapshot = structuredClone(equipped)
    projectEquipStats(equipped, 10)
    expect(equipped).toEqual(snapshot)
  })
})
