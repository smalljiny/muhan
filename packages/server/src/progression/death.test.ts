import { describe, it, expect } from 'vitest'
import { neededExp, resolveHpMax, resolveMpMax, type Character } from 'shared'
import { applyPlayerDeath } from './death.js'

/**
 * PvE 사망 페널티 seam(applyPlayerDeath) 단위 테스트.
 *
 * 발화자 없는 순수 소비자(creatureDeath.ts 선례) — exp 손실·레벨 유지(D7 발산)·부활·상태 회복을
 * 검증한다. 손실 테스트(1·2)와 하한 테스트(3)는 입력 exp를 격리해 expFloor 클램프가 손실 단언을
 * 무성으로 덮어쓰지 않게 한다(loss 테스트는 floor보다 충분히 큰 exp, floor 테스트는 floor 근처 exp).
 */

/** 유효 Character 픽스처. class·level·exp·room·vitals를 오버라이드로 조정한다. */
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 500,
    level: 10,
    hpCurrent: 5,
    mpCurrent: 3,
    experience: 100_000,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  }
}

describe('applyPlayerDeath — exp 손실(레벨 유지)', () => {
  it('criterion 1: level<20 사망은 exp의 5%(trunc(exp/20))를 깎고 레벨을 유지한다', () => {
    // level=10, exp=100000 → loss=trunc(100000/20)=5000 → 95000. floor=neededExp(8)=1024 미개입.
    const char = makeChar({ level: 10, experience: 100_000 })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(95_000)
    expect(result.level).toBe(10)
  })

  it('criterion 2a: level≥20 & exp/15>10만이면 손실이 10만으로 캡된다', () => {
    // level=20, exp=2,000,000 → exp/15=133333>100000 → loss 100000 → 1,900,000. floor 미개입.
    const char = makeChar({ level: 20, experience: 2_000_000 })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(1_900_000)
    expect(result.level).toBe(20)
  })

  it('criterion 2b: level≥20 & exp/15≤10만이면 trunc(exp/15)를 깎는다', () => {
    // level=20, exp=1,000,000 → trunc(exp/15)=66666 → 933,334. floor=neededExp(18)=6144 미개입.
    const char = makeChar({ level: 20, experience: 1_000_000 })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(933_334)
    expect(result.level).toBe(20)
  })
})

describe('applyPlayerDeath — exp 하한(down_level 미호출)', () => {
  it('criterion 3: 손실이 exp를 임계 아래로 내리면 하한 neededExp(level-2)으로 되끌어올리고 레벨 강등 없음', () => {
    // level=10, exp=neededExp(8)=1024 → loss=trunc(1024/20)=51 → 973 < 1024 → 하한 1024로 복원.
    const floor = neededExp(8)
    const char = makeChar({ level: 10, experience: floor })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(floor)
    expect(result.level).toBe(10) // down_level 미호출 — 레벨 불변
  })
})

describe('applyPlayerDeath — level≤2 경계(OOB 가드)', () => {
  it('criterion 4a: level=1 입력에서 하한이 0으로 가드되어 OOB 없이 처리된다', () => {
    // level=1, exp=100 → loss=trunc(100/20)=5 → 95. floor=0(level-2=-1 가드). 레벨 불변.
    const char = makeChar({ level: 1, experience: 100 })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(95)
    expect(result.level).toBe(1)
  })

  it('criterion 4b: level=2 입력에서 하한이 0으로 가드된다', () => {
    // level=2, exp=100 → loss=5 → 95. floor=0(level-2=0 가드). 레벨 불변.
    const char = makeChar({ level: 2, experience: 100 })
    const result = applyPlayerDeath(char)
    expect(result.experience).toBe(95)
    expect(result.level).toBe(2)
  })
})

describe('applyPlayerDeath — 부활·회복', () => {
  it('criterion 5a: 주입 reviveRoom으로 부활하고 hp/mp가 풀회복된다', () => {
    const char = makeChar({ level: 15, hpCurrent: 2, mpCurrent: 1, currentRoom: 777 })
    const result = applyPlayerDeath(char, { reviveRoom: 42 })
    expect(result.currentRoom).toBe(42)
    expect(result.hpCurrent).toBe(resolveHpMax(char))
    expect(result.mpCurrent).toBe(resolveMpMax(char))
  })

  it('criterion 5b: reviveRoom 미지정 시 기본 1008로 부활한다', () => {
    const char = makeChar({ currentRoom: 777 })
    const result = applyPlayerDeath(char)
    expect(result.currentRoom).toBe(1008)
    expect(result.hpCurrent).toBe(resolveHpMax(char))
    expect(result.mpCurrent).toBe(resolveMpMax(char))
  })

  it('reviveRoom=0(유효 방 번호)을 || 대신 ??로 존중한다', () => {
    const char = makeChar()
    const result = applyPlayerDeath(char, { reviveRoom: 0 })
    expect(result.currentRoom).toBe(0)
  })
})

describe('applyPlayerDeath — 순수성(입력 무변이)', () => {
  it('criterion 7: 입력 char를 변형하지 않고 distinct 참조를 반환한다', () => {
    const char = makeChar({ level: 10, experience: 100_000, currentRoom: 500, hpCurrent: 5, mpCurrent: 3 })
    const snapshot = { ...char }
    const result = applyPlayerDeath(char)
    expect(result).not.toBe(char) // distinct 참조
    expect(char).toEqual(snapshot) // 입력 필드 전부 불변
    // 출력 측 정체성 필드 보존(docstring 주장: class·level·race·stats·gold 불변).
    expect(result.level).toBe(char.level)
    expect(result.class).toBe(char.class)
    expect(result.race).toBe(char.race)
    expect(result.stats).toEqual(char.stats)
    expect(result.gold).toBe(char.gold)
  })
})
