import { describe, it, expect } from 'vitest'
import {
  // object 타입 상수(0~14)
  SHARP,
  THRUST,
  BLUNT,
  POLE,
  MISSILE,
  ARMOR,
  POTION,
  SCROLL,
  WAND,
  CONTAINER,
  MONEY,
  KEY,
  LIGHTSOURCE,
  MISC,
  CONTAINER2,
  isWeapon,
  // 착용 슬롯 상수(wearflag 1~20)
  BODY,
  ARMS,
  LEGS,
  NECK1,
  NECK2,
  HANDS,
  HEAD,
  FEET,
  FINGER1,
  FINGER2,
  FINGER3,
  FINGER4,
  FINGER5,
  FINGER6,
  FINGER7,
  FINGER8,
  HELD,
  SHIELD,
  FACE,
  WIELD,
  MAXWEAR,
  routeWearCommand,
  resolveSlot,
} from './taxonomy.js'

/**
 * object 타입 taxonomy·착용 슬롯 매핑 회귀 가드 — 오라클(mtype.h)의 타입 0~14와
 * 착용 wearflag 1~20이 byte-fidelity 값과 일치하는지 고정한다.
 */
describe('object 타입 상수', () => {
  it('타입 0~14가 mtype.h 순서대로 정의된다', () => {
    expect(SHARP).toBe(0)
    expect(THRUST).toBe(1)
    expect(BLUNT).toBe(2)
    expect(POLE).toBe(3)
    expect(MISSILE).toBe(4)
    expect(ARMOR).toBe(5)
    expect(POTION).toBe(6)
    expect(SCROLL).toBe(7)
    expect(WAND).toBe(8)
    expect(CONTAINER).toBe(9)
    expect(MONEY).toBe(10)
    expect(KEY).toBe(11)
    expect(LIGHTSOURCE).toBe(12)
    expect(MISC).toBe(13)
    expect(CONTAINER2).toBe(14)
  })
})

describe('isWeapon', () => {
  it('타입 0~4(SHARP~MISSILE)는 무기다', () => {
    expect(isWeapon(SHARP)).toBe(true)
    expect(isWeapon(THRUST)).toBe(true)
    expect(isWeapon(BLUNT)).toBe(true)
    expect(isWeapon(POLE)).toBe(true)
    expect(isWeapon(MISSILE)).toBe(true)
  })

  it('경계값: 4(MISSILE)=참, 5(ARMOR)=거짓', () => {
    expect(isWeapon(4)).toBe(true)
    expect(isWeapon(5)).toBe(false)
  })

  it('음수·상위 타입은 무기가 아니다', () => {
    expect(isWeapon(-1)).toBe(false)
    expect(isWeapon(CONTAINER2)).toBe(false)
  })
})

describe('착용 슬롯 상수', () => {
  it('wearflag 1~20이 mtype.h 순서대로 정의된다', () => {
    expect(BODY).toBe(1)
    expect(ARMS).toBe(2)
    expect(LEGS).toBe(3)
    expect(NECK1).toBe(4)
    expect(NECK2).toBe(5)
    expect(HANDS).toBe(6)
    expect(HEAD).toBe(7)
    expect(FEET).toBe(8)
    expect(FINGER1).toBe(9)
    expect(FINGER2).toBe(10)
    expect(FINGER3).toBe(11)
    expect(FINGER4).toBe(12)
    expect(FINGER5).toBe(13)
    expect(FINGER6).toBe(14)
    expect(FINGER7).toBe(15)
    expect(FINGER8).toBe(16)
    expect(HELD).toBe(17)
    expect(SHIELD).toBe(18)
    expect(FACE).toBe(19)
    expect(WIELD).toBe(20)
  })

  it('MAXWEAR는 20이다', () => {
    expect(MAXWEAR).toBe(20)
  })
})

describe('routeWearCommand', () => {
  it('WIELD(20)는 ready로 라우팅된다', () => {
    expect(routeWearCommand(WIELD)).toBe('ready')
  })

  it('HELD(17)는 hold로 라우팅된다', () => {
    expect(routeWearCommand(HELD)).toBe('hold')
  })

  it('그 외 wearflag는 wear로 라우팅된다', () => {
    expect(routeWearCommand(BODY)).toBe('wear')
    expect(routeWearCommand(NECK1)).toBe('wear')
    expect(routeWearCommand(FINGER1)).toBe('wear')
    expect(routeWearCommand(SHIELD)).toBe('wear')
  })
})

describe('resolveSlot', () => {
  it('단일 부위: 슬롯 = wearflag−1, 여유 시 그 인덱스 반환', () => {
    expect(resolveSlot(BODY, new Set())).toBe(0)
    expect(resolveSlot(WIELD, new Set())).toBe(19)
    expect(resolveSlot(HEAD, new Set())).toBe(HEAD - 1)
  })

  it('단일 부위: 점유 시 null 반환', () => {
    expect(resolveSlot(BODY, new Set([0]))).toBeNull()
    expect(resolveSlot(WIELD, new Set([19]))).toBeNull()
  })

  it('NECK(wearflag 4): 슬롯 3·4 중 first-free', () => {
    expect(resolveSlot(NECK1, new Set())).toBe(3)
    // 슬롯 3 점유 → 4 반환(first-free)
    expect(resolveSlot(NECK1, new Set([3]))).toBe(4)
  })

  it('NECK: 슬롯 3·4 둘 다 점유면 null', () => {
    expect(resolveSlot(NECK1, new Set([3, 4]))).toBeNull()
  })

  it('FINGER(wearflag 9): 슬롯 8~15 중 first-free', () => {
    expect(resolveSlot(FINGER1, new Set())).toBe(8)
    // 8·9·10 점유 → 11 반환(first-free)
    expect(resolveSlot(FINGER1, new Set([8, 9, 10]))).toBe(11)
  })

  it('FINGER: 슬롯 8~15 전부 점유면 null', () => {
    expect(resolveSlot(FINGER1, new Set([8, 9, 10, 11, 12, 13, 14, 15]))).toBeNull()
  })
})
