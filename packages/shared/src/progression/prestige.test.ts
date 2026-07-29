import { describe, it, expect } from 'vitest'
import { invinciblePrestige, caretakerPrestige, classifyPrestige } from './prestige.js'
import { resolveHpMax, resolveMpMax } from './maxResolvers.js'
import { characterSchema } from '../schema/character.js'
import type { Character } from '../schema/character.js'

/**
 * invinciblePrestige/caretakerPrestige/classifyPrestige(승급 전이) 테스트.
 *
 * oracle command7.c:607-635. 무적(class<9→9, level=1, exp=0)과 초인(class===9→10,
 * level=127)의 순수 class/level/experience/vitals 전이만 검증한다. gold·dice는 미소유(train·
 * combat 소관). vitals는 D4 예외로 **풀회복**(clamp 아님) — 입력 현재치를 max 미만으로 두어
 * 풀회복과 클램프/보존을 판별한다.
 */

/** class·level·experience·vitals만 관심사인 최소 유효 Character. 나머지는 더미로 채운다. */
function makeChar(overrides: Partial<Character>): Character {
  const base: Character = {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 0,
    stats: [10, 10, 10, 10, 10],
    gold: 500,
    currentRoom: 1,
    hpCurrent: 5,
    mpCurrent: 5,
    level: 1,
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
  }
  return { ...base, ...overrides }
}

describe('invinciblePrestige — L100 일반직 → 무적 전환 (command7.c:607-615)', () => {
  it('class=9·level=1·experience=0으로 전이한다', () => {
    const before = makeChar({ class: 4, level: 100, experience: 123456, hpCurrent: 5, mpCurrent: 5 })
    const after = invinciblePrestige(before)
    expect(after.class).toBe(9)
    expect(after.level).toBe(1)
    expect(after.experience).toBe(0)
  })

  it('vitals를 새 캐릭터(class=9·level=1) 폐형 최대치로 풀회복한다 (clamp 아님)', () => {
    // 입력 hpCurrent=5는 새 최대치보다 낮으므로, 풀회복이면 max, 클램프면 5로 갈린다.
    const before = makeChar({ class: 4, level: 100, hpCurrent: 5, mpCurrent: 5 })
    const after = invinciblePrestige(before)
    expect(after.hpCurrent).toBe(resolveHpMax(after))
    expect(after.mpCurrent).toBe(resolveMpMax(after))
    // 무적은 초인 오버라이드(800/600) 대상이 아니라 폐형을 따른다 — 최대치 > 5 확인.
    expect(after.hpCurrent).toBeGreaterThan(5)
    expect(after.mpCurrent).toBeGreaterThan(5)
  })

  it('gold 등 나머지 필드는 스프레드 보존한다 (gold 미차감 — train 소관)', () => {
    const before = makeChar({ class: 4, level: 100, gold: 500 })
    const after = invinciblePrestige(before)
    expect(after.gold).toBe(500)
    expect(after._id).toBe(before._id)
    expect(after.stats).toEqual(before.stats)
  })

  it('prestige 전용 필드를 추가하지 않는다 (strictObject parse 통과)', () => {
    const before = makeChar({ class: 4, level: 100 })
    const after = invinciblePrestige(before)
    expect(() => characterSchema.parse(after)).not.toThrow()
  })

  it('새 Character를 반환하고 입력을 변이하지 않는다', () => {
    const before = makeChar({ class: 4, level: 100, experience: 999 })
    invinciblePrestige(before)
    expect(before.class).toBe(4)
    expect(before.level).toBe(100)
    expect(before.experience).toBe(999)
  })
})

describe('caretakerPrestige — L127 무적 → 초인 전환 (command7.c:618-635)', () => {
  it('class=10·level=127로 전이하고 experience는 유지한다', () => {
    const before = makeChar({ class: 9, level: 127, experience: 987654 })
    const after = caretakerPrestige(before)
    expect(after.class).toBe(10)
    expect(after.level).toBe(127)
    expect(after.experience).toBe(987654)
  })

  it('vitals를 초인 오버라이드 최대치(800/600)로 풀회복한다', () => {
    const before = makeChar({ class: 9, level: 127, hpCurrent: 5, mpCurrent: 5 })
    const after = caretakerPrestige(before)
    expect(after.hpCurrent).toBe(800)
    expect(after.mpCurrent).toBe(600)
    expect(after.hpCurrent).toBe(resolveHpMax(after))
    expect(after.mpCurrent).toBe(resolveMpMax(after))
  })

  it('gold 등 나머지 필드는 스프레드 보존한다 (gold 미차감 — train 소관)', () => {
    const before = makeChar({ class: 9, level: 127, gold: 500 })
    const after = caretakerPrestige(before)
    expect(after.gold).toBe(500)
  })

  it('prestige 전용 필드를 추가하지 않는다 (strictObject parse 통과)', () => {
    const before = makeChar({ class: 9, level: 127 })
    const after = caretakerPrestige(before)
    expect(() => characterSchema.parse(after)).not.toThrow()
  })

  it('새 Character를 반환하고 입력을 변이하지 않는다', () => {
    const before = makeChar({ class: 9, level: 127 })
    caretakerPrestige(before)
    expect(before.class).toBe(9)
    expect(before.level).toBe(127)
  })
})

describe('classifyPrestige — 승급 분기 판정', () => {
  it('L100 일반직(class<9)은 invincible이다', () => {
    expect(classifyPrestige(makeChar({ class: 4, level: 100 }))).toBe('invincible')
    expect(classifyPrestige(makeChar({ class: 1, level: 100 }))).toBe('invincible')
    expect(classifyPrestige(makeChar({ class: 8, level: 100 }))).toBe('invincible')
  })

  it('L127+ 무적(class===9)은 caretaker다', () => {
    expect(classifyPrestige(makeChar({ class: 9, level: 127 }))).toBe('caretaker')
    expect(classifyPrestige(makeChar({ class: 9, level: 200 }))).toBe('caretaker')
  })

  it('비승급 케이스는 none이다', () => {
    // L50 일반직 — 무적 레벨(100) 미달.
    expect(classifyPrestige(makeChar({ class: 4, level: 50 }))).toBe('none')
    // L126 무적 — 초인 레벨(127) 미달.
    expect(classifyPrestige(makeChar({ class: 9, level: 126 }))).toBe('none')
  })

  it('경계: L100 무적(class===9)은 none이다 (invincible은 class<9만, caretaker는 level>=127만)', () => {
    expect(classifyPrestige(makeChar({ class: 9, level: 100 }))).toBe('none')
  })

  it('경계: L99 일반직은 none, L100은 invincible이다', () => {
    expect(classifyPrestige(makeChar({ class: 4, level: 99 }))).toBe('none')
    expect(classifyPrestige(makeChar({ class: 4, level: 100 }))).toBe('invincible')
  })
})
