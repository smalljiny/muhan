import { describe, it, expect } from 'vitest'
import { SPELL_NO, type Character, type CreatureInstance, type RoomNode } from 'shared'
import { SpellDispatch } from './dispatch.js'
import {
  resistBuff,
  projectResistFlags,
  registerResistBuffs,
  RESIST_SPELLS,
  type BuffEffectHandler,
  type BuffEffectRequest,
} from './buffEffects.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import { offensiveSpell } from './offensiveSpell.js'
import { toCombatant } from '../combat/combatant.js'
import { F_ISSET, F_SET, PRFIRE, PRMAGI, PRCOLD, PSSHLD, MRMAGI } from '../world/hexFlags.js'
import { setFlag } from '../world/door.js'
import { RPMEXT } from '../world/roomFlags.js'
import { MAGE, FIGHTER } from '../combat/constants.js'
import { seqRng } from '../combat/dice.testutil.js'
import type { DamageLedger } from '../combat/enmity.js'

/**
 * buffEffects 단위·통합 테스트 — G5 저항 버프 4주문(T7.4 플래그 set·until, T7.3 #84 저항 감산 회귀).
 * dur은 computeBuffDur를 우회해 독립 산출값(anti-tautology)으로 고정한다.
 */

const ZERO16 = '0000000000000000'

function makeCaster(over: Partial<Caster> = {}): Caster {
  return {
    mpCurrent: 100,
    level: 10,
    realm: [0, 0, 0, 0],
    class: MAGE,
    intBonus: 0,
    knows: () => true,
    ...over,
  }
}

function makeCharacter(over: Partial<Character> = {}): Character {
  return {
    _id: 'c-1',
    name: '테스토스',
    class: FIGHTER,
    race: 1,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    hpCurrent: 20,
    mpCurrent: 20,
    level: 10,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: 'a-1',
    status: 'active',
    ...over,
  }
}

function makeRoom(flags: number[] = [0, 0, 0, 0, 0, 0, 0, 0]): RoomNode {
  return {
    roomId: 50,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags,
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

function makeCtx(opts: { gated?: boolean; now?: number; room?: RoomNode } = {}): CastContext {
  return {
    gated: opts.gated ?? true,
    rng: seqRng([]),
    room: opts.room ?? makeRoom(),
    now: opts.now ?? 1000,
    fireCreatureDeath: () => {},
    firePlayerDeath: () => {},
    ledger: new Map<string, number>() as DamageLedger,
  }
}

function req(over: Partial<BuffEffectRequest> = {}): BuffEffectRequest {
  return {
    caster: makeCaster(),
    target: makeCharacter(),
    ctx: makeCtx(),
    ...over,
  }
}

// ── T7.4 저항 버프 effect: until 기록(independent dur) ──────────────────────────
describe('resistBuff — buffs until 기록(A6 §6 표준 버프)', () => {
  it('CAST 기본: until = now + MAX(300, 1200+B*600)', () => {
    // SRFIRE, B=2, gated, rpmext 없음 → MAX(300, 1200+2*600)=2400. now=1000 → until=3400.
    const next = resistBuff(
      req({ caster: makeCaster({ intBonus: 2 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SRFIRE,
    )
    expect(next.buffs?.[String(SPELL_NO.SRFIRE)]).toEqual({ until: 3400 })
  })

  it('B=0: until = now + 1200 (하한 안 걸림)', () => {
    // SRMAGI, B=0 → MAX(300,1200)=1200. now=500 → until=1700.
    const next = resistBuff(
      req({ caster: makeCaster({ intBonus: 0 }), ctx: makeCtx({ now: 500 }) }),
      SPELL_NO.SRMAGI,
    )
    expect(next.buffs?.[String(SPELL_NO.SRMAGI)]).toEqual({ until: 1700 })
  })

  it('비-CAST(gated=false): until = now + 1200 고정(NON_CAST_BUFF_DUR)', () => {
    // 아이템 경로: B와 무관하게 1200 고정. B=5여도 dur=1200. now=1000 → until=2200.
    const next = resistBuff(
      req({ caster: makeCaster({ intBonus: 5 }), ctx: makeCtx({ gated: false, now: 1000 }) }),
      SPELL_NO.SRCOLD,
    )
    expect(next.buffs?.[String(SPELL_NO.SRCOLD)]).toEqual({ until: 2200 })
  })

  it('RPMEXT 방: +800 가산', () => {
    // SSSHLD, B=0, RPMEXT 방 → 1200+800=2000. now=1000 → until=3000.
    const flags = [0, 0, 0, 0, 0, 0, 0, 0]
    setFlag(flags, RPMEXT)
    const next = resistBuff(
      req({ caster: makeCaster({ intBonus: 0 }), ctx: makeCtx({ now: 1000, room: makeRoom(flags) }) }),
      SPELL_NO.SSSHLD,
    )
    expect(next.buffs?.[String(SPELL_NO.SSSHLD)]).toEqual({ until: 3000 })
  })

  it('입력 Character·buffs를 변형하지 않는다(immutability)', () => {
    const target = makeCharacter({ buffs: { [String(SPELL_NO.SRCOLD)]: { until: 42 } } })
    const next = resistBuff(req({ target }), SPELL_NO.SRFIRE)
    // 원본 불변.
    expect(target.buffs).toEqual({ [String(SPELL_NO.SRCOLD)]: { until: 42 } })
    // 기존 엔트리 병합 + 새 엔트리.
    expect(next.buffs?.[String(SPELL_NO.SRCOLD)]).toEqual({ until: 42 })
    expect(next.buffs?.[String(SPELL_NO.SRFIRE)]).toBeDefined()
  })
})

// ── T7.4 저항 플래그 투영(projectResistFlags) ───────────────────────────────────
describe('projectResistFlags — 활성 저항 버프 → P-flag hex 투영', () => {
  const cases: ReadonlyArray<readonly [number, number]> = [
    [SPELL_NO.SRFIRE, PRFIRE],
    [SPELL_NO.SRMAGI, PRMAGI],
    [SPELL_NO.SRCOLD, PRCOLD],
    [SPELL_NO.SSSHLD, PSSHLD],
  ]

  for (const [spellNo, bit] of cases) {
    it(`주문 ${spellNo} 활성 → 비트 ${bit} set`, () => {
      const c = resistBuff(req({ ctx: makeCtx({ now: 1000 }) }), spellNo)
      const hex = projectResistFlags(c, 1000)
      expect(F_ISSET(hex, bit)).toBe(true)
    })
  }

  it('만료된 버프는 플래그를 세팅하지 않는다', () => {
    // until=1000, now=1001 → 만료(tick>until). 플래그 미투영.
    const c = resistBuff(req({ ctx: makeCtx({ now: 500 }) }), SPELL_NO.SRFIRE)
    // 500 + 1200 = 1700 until. now=1701이면 만료.
    const hex = projectResistFlags(c, 1701)
    expect(F_ISSET(hex, PRFIRE)).toBe(false)
  })

  it('버프 없는 Character는 저항 비트가 전부 off', () => {
    const hex = projectResistFlags(makeCharacter(), 1000)
    expect(F_ISSET(hex, PRFIRE)).toBe(false)
    expect(F_ISSET(hex, PRMAGI)).toBe(false)
    expect(F_ISSET(hex, PRCOLD)).toBe(false)
    expect(F_ISSET(hex, PSSHLD)).toBe(false)
  })
})

// ── T7.2 자체 SpellDispatch 등록 ────────────────────────────────────────────────
describe('registerResistBuffs — 자체 디스패치 인스턴스', () => {
  it('resistBuff family 4주문을 등록한다(SBRWAT 제외)', () => {
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerResistBuffs(dispatch)
    for (const spellNo of [SPELL_NO.SRFIRE, SPELL_NO.SRMAGI, SPELL_NO.SRCOLD, SPELL_NO.SSSHLD]) {
      expect(typeof dispatch.resolve(spellNo)).toBe('function')
    }
  })

  it('SBRWAT(수생술, family=buff → Story 9)는 등록되지 않는다', () => {
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerResistBuffs(dispatch)
    expect(dispatch.resolve(SPELL_NO.SBRWAT)).toBeUndefined()
    expect(RESIST_SPELLS).not.toContain(SPELL_NO.SBRWAT)
    expect(RESIST_SPELLS).toHaveLength(4)
  })

  it('등록 핸들러가 대상에 버프를 건다', () => {
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerResistBuffs(dispatch)
    const handler = dispatch.resolve(SPELL_NO.SRFIRE)!
    const next = handler(req({ ctx: makeCtx({ now: 1000 }) }))
    expect(next.buffs?.[String(SPELL_NO.SRFIRE)]).toBeDefined()
  })
})

// ── T7.3 #84 마법저항 감산 회귀 가드(MRMAGI creature 대상) ────────────────────────
describe('offensiveSpell 회귀 — MRMAGI creature 저항 감산 무파괴', () => {
  function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
    return {
      instanceId: 'crt-1',
      templateId: null,
      name: '고블린',
      level: 3,
      hpmax: 100,
      hpcur: 100,
      mpmax: 0,
      mpcur: 0,
      dexterity: 12,
      gold: 0,
      special: 0,
      armor: 0,
      thaco: 10,
      ndice: 1,
      sdice: 6,
      pdice: 0,
      realm: [0, 0, 0, 0],
      spells: ZERO16.repeat(2),
      class: 0,
      intelligence: 25,
      piety: 25,
      flags: ZERO16,
      enemies: [],
      inventory: [],
      ...over,
    }
  }

  // 1d10+0(bns=0, gated=false) → seqRng([10])로 dmg=10 고정.
  const osp = { spellNo: 29, realm: 2, mp: 7, ndice: 1, sdice: 10, pdice: 0, bonusType: 2 } as const

  it('MRMAGI 보유 creature는 데미지가 감산된다(piety+int>=50 → 완전 무효)', () => {
    // dmg=10(dice 1d1+9). MRMAGI + piety(25)+int(25)=50 → dmg -= trunc(10*2*50/100)=10 → 0.
    const target = toCombatant(makeCreature({ flags: F_SET(ZERO16, MRMAGI) }))
    const ctx = makeCtx({ gated: false })
    const out = offensiveSpell(
      { caster: makeCaster(), casterId: 'p-1', target, ctx: { ...ctx, rng: seqRng([10]) } },
      osp,
    )
    expect(out.dmg).toBe(0)
  })

  it('MRMAGI 없는 creature는 감산 없이 풀 데미지', () => {
    const target = toCombatant(makeCreature())
    const ctx = makeCtx({ gated: false })
    const out = offensiveSpell(
      { caster: makeCaster(), casterId: 'p-1', target, ctx: { ...ctx, rng: seqRng([10]) } },
      osp,
    )
    expect(out.dmg).toBe(10)
  })
})
