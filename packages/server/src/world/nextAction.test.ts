import { describe, it, expect } from 'vitest'
import type { CreatureInstance } from 'shared'
import { cadenceSec, scheduleNextAction, isDue } from './nextAction.js'

function makeCreature(instanceId: string, dexterity: number, nextActionAt?: number): CreatureInstance {
  return {
    instanceId,
    templateId: null,
    name: '몬스터',
    level: 1,
    hpmax: 5,
    hpcur: 5,
    mpmax: 0,
    mpcur: 0,
    dexterity,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '0000000000000000',
    enemies: [],
    inventory: [],
    nextActionAt,
  }
}

describe('cadenceSec — 민첩 연동 공격 주기(A9 §7 LT_ATTCK)', () => {
  it('민첩<20이면 3초', () => {
    expect(cadenceSec(19)).toBe(3)
    expect(cadenceSec(0)).toBe(3)
  })
  it('민첩>=20이면 2초', () => {
    expect(cadenceSec(20)).toBe(2)
    expect(cadenceSec(25)).toBe(2)
  })
})

describe('scheduleNextAction — nextActionAt = now + cadence(dex)', () => {
  it('민첩<20 크리처는 now+3으로 스케줄된다', () => {
    const c = makeCreature('1:c0', 14)
    scheduleNextAction(c, 100)
    expect(c.nextActionAt).toBe(103)
  })
  it('민첩>=20 크리처는 now+2로 스케줄된다', () => {
    const c = makeCreature('1:c0', 22)
    scheduleNextAction(c, 100)
    expect(c.nextActionAt).toBe(102)
  })
})

describe('isDue — nextActionAt 도래 판정', () => {
  it('nextActionAt <= now면 도래', () => {
    expect(isDue(makeCreature('1:c0', 14, 100), 100)).toBe(true)
    expect(isDue(makeCreature('1:c0', 14, 99), 100)).toBe(true)
  })
  it('nextActionAt > now면 미도래', () => {
    expect(isDue(makeCreature('1:c0', 14, 101), 100)).toBe(false)
  })
  it('nextActionAt 미설정이면 도래로 취급한다(첫 활성 틱 초기화 대상)', () => {
    expect(isDue(makeCreature('1:c0', 14, undefined), 100)).toBe(true)
  })
})
