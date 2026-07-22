import { describe, it, expect } from 'vitest'
import type { CreatureInstance } from 'shared'
import { toCombatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'

/**
 * Combatant 어댑터 — 플레이어(PlayerCombatState)·몬스터(CreatureInstance)를 통일 operand로 노출한다.
 *
 * 명중·피해 계산이 kind 비대칭(플레이어 파생 스탯 vs 크리처 필드 read)을 흡수한 단일 인터페이스
 * (hpCurrent/armor/thaco/dexterity/flags/kind)로만 읽도록 한다. flags는 양측 hex string으로 통일해
 * F_ISSET(combatant.flags, bit) 단일 관용을 성립시킨다.
 */
function makePlayer(overrides: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'char-1',
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    class: 4,
    effectiveStrength: 16,
    armor: 8,
    thaco: 15,
    dexterity: 18,
    flags: '',
    alignment: 1,
    weapon: { ndice: 2, sdice: 6, pdice: 3, adjustment: 2, proficiency: 60 },
    nextAttackAt: 0,
    ...overrides,
  }
}

function makeCreature(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'crt-1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 30,
    hpcur: 24,
    mpmax: 0,
    mpcur: 0,
    dexterity: 12,
    gold: 5,
    special: 0,
    armor: 20,
    thaco: 18,
    ndice: 1,
    sdice: 6,
    pdice: 2,
    realm: [0, 0, 0, 0],
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '',
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

describe('toCombatant', () => {
  it('플레이어를 kind="player"로 노출한다', () => {
    const c = toCombatant(makePlayer())
    expect(c.kind).toBe('player')
  })

  it('크리처를 kind="creature"로 노출한다', () => {
    const c = toCombatant(makeCreature())
    expect(c.kind).toBe('creature')
  })

  it('플레이어 hpCurrent/armor/thaco/dexterity/flags를 노출한다', () => {
    const c = toCombatant(makePlayer({ hpCurrent: 42, armor: 8, thaco: 15, dexterity: 18, flags: '' }))
    expect(c.hpCurrent).toBe(42)
    expect(c.armor).toBe(8)
    expect(c.thaco).toBe(15)
    expect(c.dexterity).toBe(18)
    expect(c.flags).toBe('')
  })

  it('크리처 hpcur를 hpCurrent로 매핑하고 armor/thaco/dexterity/flags를 노출한다', () => {
    const c = toCombatant(makeCreature({ hpcur: 24, armor: 20, thaco: 18, dexterity: 12, flags: '0a' }))
    expect(c.hpCurrent).toBe(24)
    expect(c.armor).toBe(20)
    expect(c.thaco).toBe(18)
    expect(c.dexterity).toBe(12)
    expect(c.flags).toBe('0a')
  })

  it('양측 flags가 동일 hex string 표현이라 F_ISSET 단일 관용이 성립한다', () => {
    const player = toCombatant(makePlayer())
    const creature = toCombatant(makeCreature())
    expect(typeof player.flags).toBe('string')
    expect(typeof creature.flags).toBe('string')
  })

  it('플레이어 combatant는 원본 PlayerCombatState 참조를 담는다(피해 계산 소비)', () => {
    const state = makePlayer()
    const c = toCombatant(state)
    expect(c.kind === 'player' && c.state).toBe(state)
  })

  it('크리처 combatant는 원본 CreatureInstance 참조를 담는다(피해 계산 소비)', () => {
    const instance = makeCreature()
    const c = toCombatant(instance)
    expect(c.kind === 'creature' && c.instance).toBe(instance)
  })
})
