import { describe, it, expect, vi } from 'vitest'
import { neededExp, type Character } from 'shared'
import { setFlag } from '../world/door.js'
import { train, RTRAIN } from './train.js'

/**
 * train(연마) 3게이트 명시 레벨업 테스트.
 *
 * 다층 guard(location→exp→gold) 규율: 각 guard 테스트는 선행 guard를 모두 통과하는 입력으로
 * 구성한다(testing.md "다층 Guard 테스트 원칙"). class-bit 역순 버그 적발을 위해 비대칭 class2
 * 케이스를 포함한다.
 */

/** 지정 비트들을 세팅한 방 flags(number[] 바이트 배열)를 만든다. */
function roomFlags(...bits: number[]): number[] {
  const flags: number[] = [0]
  for (const b of bits) setFlag(flags, b)
  return flags
}

/** 유효 Character 픽스처. class·level·exp·gold를 오버라이드로 조정한다. */
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    level: 1,
    hpCurrent: 55,
    mpCurrent: 40,
    experience: 0,
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

/** class N의 훈련방(base RTRAIN + class-bit 역순 매칭)을 만든다. */
function trainingRoomForClass(cls: number): number[] {
  const bits = [RTRAIN] // base bit 3
  const idx = cls - 1
  // bit[i] = (idx & (1<<i)); room bit for i = RTRAIN+3-i (역순): i=0→6, i=1→5, i=2→4.
  for (let i = 0; i < 3; i++) {
    if ((idx & (1 << i)) !== 0) bits.push(RTRAIN + 3 - i)
  }
  return roomFlags(...bits)
}

describe('train — location gate', () => {
  it('RTRAIN 미설정 방 → not-training-room 거부', () => {
    const char = makeChar({ class: 1 })
    const room = { flags: roomFlags() } // 아무 비트도 없음
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result).toEqual({ ok: false, reason: 'not-training-room' })
  })

  it('CARETAKER(10) → caretaker-forbidden (훈련방이어도 거부)', () => {
    const char = makeChar({ class: 10, level: 127 })
    const room = { flags: trainingRoomForClass(10) }
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result).toEqual({ ok: false, reason: 'caretaker-forbidden' })
  })

  it('비대칭 class2: 방이 bit6만 set(+base bit3) & bit4·5 clear면 통과', () => {
    // class2 → idx=1 → bit0=1,bit1=0,bit2=0 → room bit6 set, bit5·4 clear.
    const room = { flags: roomFlags(RTRAIN, 6) }
    const char = makeChar({ class: 2, level: 1, experience: 0, gold: 0 })
    const result = train(char, room, { markDirty: vi.fn() })
    // location 통과(class-mismatch 아님). exp/gold gate에서 걸리므로 not-training/class-mismatch가 아니어야.
    expect(result).not.toEqual({ ok: false, reason: 'class-mismatch' })
    expect(result).not.toEqual({ ok: false, reason: 'not-training-room' })
  })

  it('비대칭 class2: bit4가 set된 방(역순 버그면 통과할)이면 class-mismatch', () => {
    // 잘못된 방: base bit3 set + bit4 set (bit6 clear). 정순 버그라면 i=0→bit4로 매칭돼 통과.
    // 정본(역순)에서는 i=0→bit6=0 !== bit[0]=1 → fail.
    const room = { flags: roomFlags(RTRAIN, 4) }
    const char = makeChar({ class: 2, level: 1, experience: 0, gold: 0 })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result).toEqual({ ok: false, reason: 'class-mismatch' })
  })

  it('무적(class9): base RTRAIN 있으면 class-bit 무관하게 통과', () => {
    // class9 → class>8 → class-bit 서브매칭 면제. base RTRAIN만 필요.
    const room = { flags: roomFlags(RTRAIN) } // class 비트 전혀 없음
    const char = makeChar({ class: 9, level: 1, experience: 0, gold: 0 })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result).not.toEqual({ ok: false, reason: 'class-mismatch' })
    expect(result).not.toEqual({ ok: false, reason: 'not-training-room' })
  })

  it('무적(class9): base RTRAIN 없으면 not-training-room', () => {
    const room = { flags: roomFlags(6, 5, 4) } // base bit3 없음
    const char = makeChar({ class: 9, level: 1 })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result).toEqual({ ok: false, reason: 'not-training-room' })
  })
})

describe('train — exp·gold gate', () => {
  it('exp 부족 → insufficient-exp, level·gold 불변', () => {
    const room = { flags: trainingRoomForClass(1) }
    // level 2: expneeded=neededExp(2) 큼. experience=0 < expneeded. gold 충분.
    const char = makeChar({ class: 1, level: 2, experience: 0, gold: 1_000_000_000 })
    const markDirty = vi.fn()
    const result = train(char, room, { markDirty })
    expect(result).toEqual({ ok: false, reason: 'insufficient-exp' })
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('gold 부족 → insufficient-gold, level·gold 불변', () => {
    const room = { flags: trainingRoomForClass(1) }
    const level = 2
    const expNeeded = neededExp(level)
    const goldNeeded = Math.trunc(expNeeded / 20)
    // location·exp 통과(experience 충분), gold만 부족.
    const char = makeChar({ class: 1, level, experience: expNeeded, gold: goldNeeded - 1 })
    const markDirty = vi.fn()
    const result = train(char, room, { markDirty })
    expect(result).toEqual({ ok: false, reason: 'insufficient-gold' })
    expect(markDirty).not.toHaveBeenCalled()
  })
})

describe('train — 3게이트 통과 + 배치', () => {
  it('3게이트 통과: gold가 goldneeded 차감되고 레벨 오름, 입력 무변이', () => {
    const room = { flags: trainingRoomForClass(1) }
    const level = 2
    const expNeeded = neededExp(level)
    const goldNeeded = Math.trunc(expNeeded / 20)
    // 정확히 1레벨분 exp: experience == neededExp(2), 다음 임계(neededExp(3))에는 못 미침.
    const char = makeChar({ class: 1, level, experience: expNeeded, gold: goldNeeded })
    const markDirty = vi.fn()
    const before = structuredClone(char)
    const result = train(char, room, { markDirty })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.prestige).toBe('none')
    expect(result.levelsGained).toBe(1)
    expect(result.character.level).toBe(level + 1)
    // gold 정확히 goldNeeded 차감(upLevel spread가 원 gold를 되살리는 버그 적발).
    expect(result.character.gold).toBe(goldNeeded - goldNeeded)
    // 입력 무변이.
    expect(char).toEqual(before)
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('배치 다중 레벨: 여러 레벨분 exp면 여러 레벨 상승', () => {
    const room = { flags: trainingRoomForClass(1) }
    const startLevel = 2
    // level 2에서 시작, experience를 level 4 임계 이상으로 → 2→3→4 상승 시도.
    const bigExp = neededExp(5)
    const bigGold = 1_000_000_000
    const char = makeChar({ class: 1, level: startLevel, experience: bigExp, gold: bigGold })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // experience는 불변 임계. expneeded(newLevel) > experience가 되면 정지.
    expect(result.character.level).toBeGreaterThan(startLevel)
    expect(result.levelsGained).toBe(result.character.level - startLevel)
    // experience >= neededExp(finalLevel-1)이지만 < neededExp(finalLevel) 이어야 정지 조건.
    expect(neededExp(result.character.level)).toBeGreaterThan(char.experience)
  })

  it('배치: normal은 L100서 정지(초과 안 함)', () => {
    const room = { flags: trainingRoomForClass(1) }
    const startLevel = 98
    const char = makeChar({
      class: 1,
      level: startLevel,
      experience: 200_000_000, // 충분히 큰 exp
      gold: 1_000_000_000,
    })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.prestige).toBe('none')
    expect(result.character.level).toBe(100)
    expect(result.character.class).toBe(1) // 승급 안 함(이번 호출)
  })
})

describe('train — prestige 우선 분기', () => {
  it('L100 일반직 → invincible 전이(prestige 우선, 배치 미실행)', () => {
    const room = { flags: trainingRoomForClass(1) }
    const level = 100
    const expNeeded = neededExp(level)
    const goldNeeded = Math.trunc(expNeeded / 20)
    const char = makeChar({
      class: 1,
      level,
      experience: expNeeded,
      gold: goldNeeded + 500,
    })
    const markDirty = vi.fn()
    const result = train(char, room, { markDirty })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.prestige).toBe('invincible')
    expect(result.levelsGained).toBe(0)
    expect(result.character.class).toBe(9)
    expect(result.character.level).toBe(1)
    expect(result.character.experience).toBe(0)
    expect(result.character.gold).toBe(500) // goldNeeded 차감
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('무적 L127+ → caretaker 전이(prestige 우선)', () => {
    const room = { flags: trainingRoomForClass(9) } // class9 훈련방(base RTRAIN)
    const level = 127
    const expNeeded = neededExp(level)
    const goldNeeded = Math.trunc(expNeeded / 20)
    const char = makeChar({
      class: 9,
      level,
      experience: expNeeded,
      gold: goldNeeded + 100,
    })
    const result = train(char, room, { markDirty: vi.fn() })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.prestige).toBe('caretaker')
    expect(result.character.class).toBe(10)
    expect(result.character.level).toBe(127)
    expect(result.character.gold).toBe(100) // goldNeeded 차감
  })
})

describe('train — markDirty 스냅샷 계약', () => {
  it('성공 시 markDirty가 스냅샷(라이브 아님)으로 1회 호출', () => {
    const room = { flags: trainingRoomForClass(1) }
    const level = 2
    const expNeeded = neededExp(level)
    const goldNeeded = Math.trunc(expNeeded / 20)
    const char = makeChar({ class: 1, level, experience: expNeeded, gold: goldNeeded + 10 })
    let captured: unknown
    const markDirty = vi.fn((_collection: string, _id: string, snapshot: unknown) => {
      captured = snapshot
    })
    const result = train(char, room, { markDirty })
    expect(markDirty).toHaveBeenCalledWith('characters', 'char-1', expect.anything())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const snap = captured as Character
    const snapshotGoldBefore = snap.gold
    // 반환 character를 이후 변이해도 스냅샷은 영향 없어야(distinct 참조).
    ;(result.character as { gold: number }).gold = 999_999
    expect(snap.gold).toBe(snapshotGoldBefore)
  })
})
