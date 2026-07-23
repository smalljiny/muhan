import { describe, it, expect } from 'vitest'
import { bonusOf, emptySpellStore, setKnown, type CreatureInstance } from 'shared'
import type { PlayerCombatState } from '../combat/playerState.js'
import { F_SET } from '../world/hexFlags.js'
import { toCaster } from './caster.js'

/**
 * Caster 계약 경계 테스트 — 몹·플레이어 공유 추상의 6필드와 write-through를 못박는다.
 *
 * 이 계약은 #85(realm 성장·학습 write)·#86(scroll/potion/wand 본체)이 공유하므로,
 * "정확히 6필드"·"mpCurrent 라이브 write-through"를 런타임으로 잠근다(개별 필드 검증만으로는
 * 누출 필드를 못 잡는다).
 */

function makeCreature(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'crt-1',
    templateId: null,
    name: '화룡',
    level: 8,
    hpmax: 80,
    hpcur: 60,
    mpmax: 40,
    mpcur: 40,
    dexterity: 12,
    gold: 5,
    special: 0,
    armor: 20,
    thaco: 18,
    ndice: 1,
    sdice: 6,
    pdice: 2,
    realm: [10, 20, 30, 40],
    spells: '0'.repeat(32),
    class: 5,
    intelligence: 16,
    piety: 0,
    flags: '',
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

function makePlayerState(overrides: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'char-1',
    hpCurrent: 42,
    mpCurrent: 30,
    level: 7,
    class: 4,
    effectiveStrength: 16,
    effectiveIntelligence: 14,
    armor: 12,
    thaco: 15,
    dexterity: 18,
    spells: emptySpellStore(),
    realm: [0, 0, 0, 0],
    flags: '',
    alignment: 1,
    weapon: null,
    nextAttackAt: 0,
    ...overrides,
  }
}

describe('Caster 계약 (정확히 6필드)', () => {
  it('creature 어댑터는 정확히 6개 키만 노출한다(계약 봉인 — 필드 누출 차단)', () => {
    const caster = toCaster(makeCreature())
    expect(Object.keys(caster).sort()).toEqual([
      'class',
      'intBonus',
      'knows',
      'level',
      'mpCurrent',
      'realm',
    ])
  })

  it('player 어댑터도 정확히 6개 키만 노출한다', () => {
    const caster = toCaster(makePlayerState())
    expect(Object.keys(caster).sort()).toEqual([
      'class',
      'intBonus',
      'knows',
      'level',
      'mpCurrent',
      'realm',
    ])
  })
})

describe('toCaster(CreatureInstance)', () => {
  it('level·class를 creature 실값으로 이식한다', () => {
    const caster = toCaster(makeCreature({ level: 8, class: 5 }))
    expect(caster.level).toBe(8)
    expect(caster.class).toBe(5)
  })

  it('realm을 creature.realm(길이 4)으로 이식한다', () => {
    const caster = toCaster(makeCreature({ realm: [10, 20, 30, 40] }))
    expect(caster.realm).toEqual([10, 20, 30, 40])
    expect(caster.realm).toHaveLength(4)
  })

  it('intBonus를 bonusOf(creature.intelligence)로 사전 계산한다', () => {
    const caster = toCaster(makeCreature({ intelligence: 16 }))
    expect(caster.intBonus).toBe(bonusOf(16))
  })

  it('mpCurrent를 creature.mpcur로 읽는다', () => {
    const caster = toCaster(makeCreature({ mpcur: 40 }))
    expect(caster.mpCurrent).toBe(40)
  })

  it('knows는 creature.spells 비트셋을 F_ISSET으로 판독한다', () => {
    const creature = makeCreature({ spells: F_SET('0'.repeat(32), 6) })
    const caster = toCaster(creature)
    expect(caster.knows(6)).toBe(true)
    expect(caster.knows(7)).toBe(false)
  })

  it('mpCurrent 소비가 라이브 creature.mpcur로 write-through 된다', () => {
    const creature = makeCreature({ mpcur: 40 })
    const caster = toCaster(creature)
    caster.mpCurrent -= 5
    expect(creature.mpcur).toBe(35)
    expect(caster.mpCurrent).toBe(35)
  })
})

describe('toCaster(PlayerCombatState)', () => {
  it('level·class를 player 실값으로 이식한다', () => {
    const caster = toCaster(makePlayerState({ level: 7, class: 4 }))
    expect(caster.level).toBe(7)
    expect(caster.class).toBe(4)
  })

  it('realm을 state.realm 실 누적경험치로 이식한다(#85 — 더 이상 [0,0,0,0] 스텁 아님)', () => {
    const caster = toCaster(makePlayerState({ realm: [11, 22, 33, 44] }))
    expect(caster.realm).toEqual([11, 22, 33, 44])
    expect(caster.realm).toHaveLength(4)
  })

  it('빈 realm 플레이어는 [0,0,0,0]을 그대로 반영한다', () => {
    const caster = toCaster(makePlayerState({ realm: [0, 0, 0, 0] }))
    expect(caster.realm).toEqual([0, 0, 0, 0])
  })

  it('intBonus를 bonusOf(player.effectiveIntelligence)로 사전 계산한다', () => {
    const caster = toCaster(makePlayerState({ effectiveIntelligence: 14 }))
    expect(caster.intBonus).toBe(bonusOf(14))
  })

  it('knows는 state.spells 비트마스크를 isKnown으로 실판독한다(#85 — 더 이상 false 스텁 아님)', () => {
    const caster = toCaster(makePlayerState({ spells: setKnown(emptySpellStore(), 6) }))
    expect(caster.knows(6)).toBe(true)
    expect(caster.knows(7)).toBe(false)
    expect(caster.knows(55)).toBe(false)
  })

  it('빈 spell store 플레이어는 어느 주문도 보유하지 않는다', () => {
    const caster = toCaster(makePlayerState({ spells: emptySpellStore() }))
    expect(caster.knows(0)).toBe(false)
    expect(caster.knows(55)).toBe(false)
  })

  it('mpCurrent 소비가 라이브 state.mpCurrent로 write-through 된다', () => {
    const state = makePlayerState({ mpCurrent: 30 })
    const caster = toCaster(state)
    caster.mpCurrent -= 5
    expect(state.mpCurrent).toBe(25)
    expect(caster.mpCurrent).toBe(25)
  })
})
