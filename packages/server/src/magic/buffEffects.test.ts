import { describe, it, expect } from 'vitest'
import { SPELL_NO, type Character, type CreatureInstance, type RoomNode } from 'shared'
import { SpellDispatch } from './dispatch.js'
import {
  resistBuff,
  standardBuff,
  specialBuff,
  projectResistFlags,
  projectBuffFlags,
  registerResistBuffs,
  registerTimedBuffs,
  RESIST_SPELLS,
  TIMED_BUFF_SPELLS,
  type BuffEffectHandler,
  type BuffEffectRequest,
} from './buffEffects.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import { offensiveSpell } from './offensiveSpell.js'
import { toCombatant } from '../combat/combatant.js'
import {
  F_ISSET,
  F_SET,
  PRFIRE,
  PRMAGI,
  PRCOLD,
  PSSHLD,
  MRMAGI,
  PBLESS,
  PPROTE,
  PINVIS,
  PLEVIT,
  PBRWAT,
  PDINVI,
  PDMAGI,
  PKNOWA,
  PFLYSP,
  PLIGHT,
} from '../world/hexFlags.js'
import { setFlag } from '../world/door.js'
import { RPMEXT } from '../world/roomFlags.js'
import { MAGE, FIGHTER, CLERIC } from '../combat/constants.js'
import { seqRng } from '../combat/dice.testutil.js'

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
    alignment: 1,
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
    ledger: new Map<string, number>(),
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

// ══ Story 9 (G7) — 버프·감지 timed effect 10주문 ════════════════════════════════

// ── T9.1/T9.2/T9.3 standardBuff: computeBuffDur 소비 7주문 until 기록 ───────────
describe('standardBuff — computeBuffDur 소비 버프/감지/fly(A6 §6 표준)', () => {
  it('SBLESS(bless): MAGE는 클래스 보너스 없음 → until=now+1200', () => {
    // bless는 CLERIC/PALADIN만 +60*L4. MAGE B=0 → 1200. now=1000 → until=2200.
    const next = standardBuff(
      req({ caster: makeCaster({ class: MAGE, intBonus: 0 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SBLESS,
    )
    expect(next.buffs?.[String(SPELL_NO.SBLESS)]).toEqual({ until: 2200 })
  })

  it('SBLESS(bless): CLERIC는 +60*L4 → until=now+1380', () => {
    // CLERIC=3, level=10 → L4=3, +180. base 1200 → 1380. now=1000 → until=2380.
    const next = standardBuff(
      req({ caster: makeCaster({ class: CLERIC, intBonus: 0, level: 10 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SBLESS,
    )
    expect(next.buffs?.[String(SPELL_NO.SBLESS)]).toEqual({ until: 2380 })
  })

  it('SPROTE(protection): FIGHTER B=0 → until=now+1200', () => {
    const next = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SPROTE,
    )
    expect(next.buffs?.[String(SPELL_NO.SPROTE)]).toEqual({ until: 2200 })
  })

  it('SBRWAT(breathe_water, family=buff → Story 9): FIGHTER B=2 → until=now+2400', () => {
    // breathe_water 클래스 보너스 없음. B=2 → MAX(300,2400)=2400. now=1000 → 3400.
    const next = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 2 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SBRWAT,
    )
    expect(next.buffs?.[String(SPELL_NO.SBRWAT)]).toEqual({ until: 3400 })
  })

  it('SDINVI(detectinvis): MAGE +60*L4 → until=now+1380', () => {
    const next = standardBuff(
      req({ caster: makeCaster({ class: MAGE, intBonus: 0, level: 10 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SDINVI,
    )
    expect(next.buffs?.[String(SPELL_NO.SDINVI)]).toEqual({ until: 2380 })
  })

  it('SDMAGI(detectmagic): 비-MAGE는 보너스 없음 → until=now+1200', () => {
    const next = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SDMAGI,
    )
    expect(next.buffs?.[String(SPELL_NO.SDMAGI)]).toEqual({ until: 2200 })
  })

  it('SKNOWA(know_alignment): RPMEXT +800 → until=now+2000', () => {
    const flags = [0, 0, 0, 0, 0, 0, 0, 0]
    setFlag(flags, RPMEXT)
    const next = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000, room: makeRoom(flags) }) }),
      SPELL_NO.SKNOWA,
    )
    expect(next.buffs?.[String(SPELL_NO.SKNOWA)]).toEqual({ until: 3000 })
  })

  it('SFLYSP(fly, movement family지만 LT_FLYSP 타이머 보유): RPMEXT +600 → until=now+1800', () => {
    const flags = [0, 0, 0, 0, 0, 0, 0, 0]
    setFlag(flags, RPMEXT)
    const next = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000, room: makeRoom(flags) }) }),
      SPELL_NO.SFLYSP,
    )
    expect(next.buffs?.[String(SPELL_NO.SFLYSP)]).toEqual({ until: 2800 })
  })

  it('resistBuff는 standardBuff에 위임한다(Story 7 API 유지)', () => {
    const r = req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000 }) })
    expect(resistBuff(r, SPELL_NO.SRFIRE)).toEqual(standardBuff(r, SPELL_NO.SRFIRE))
  })
})

// ── T9.1/T9.3 specialBuff: computeSpecialBuffDur 소비 3주문(OpenQ #3-a/#3-b) ────
describe('specialBuff — invis/levit/light(A6 §6 표준 공식 예외)', () => {
  it('SINVIS(invisibility): MAGE 복원식 → until=now+1380', () => {
    // MAX(300,1200)=1200 + MAGE 60*3=180 → 1380. now=1000 → 2380.
    const next = specialBuff(
      req({ caster: makeCaster({ class: MAGE, intBonus: 0, level: 10 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SINVIS,
    )
    expect(next.buffs?.[String(SPELL_NO.SINVIS)]).toEqual({ until: 2380 })
  })

  it('SINVIS: 음수 B에 MAX(300) 하한 복원(OpenQ #3-b) → until=now+300', () => {
    // B=-2, FIGHTER → MAX(300,0)=300. 하한 미복원이면 0(anti-tautology). now=1000 → 1300.
    const next = specialBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: -2 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SINVIS,
    )
    expect(next.buffs?.[String(SPELL_NO.SINVIS)]).toEqual({ until: 1300 })
  })

  it('SLEVIT(levitate): base 2400 → until=now+2400', () => {
    const next = specialBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SLEVIT,
    )
    expect(next.buffs?.[String(SPELL_NO.SLEVIT)]).toEqual({ until: 3400 })
  })

  it('SLEVIT: 음수 B에 MAX(300) 하한 복원(OpenQ #3-b) → until=now+300', () => {
    // B=-4 → 2400-2400=0 → MAX(300,0)=300. now=1000 → 1300.
    const next = specialBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: -4 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SLEVIT,
    )
    expect(next.buffs?.[String(SPELL_NO.SLEVIT)]).toEqual({ until: 1300 })
  })

  it('SLIGHT(light, utility family): 스케일 복원 level=10 → until=now+1200(600 버그 아님)', () => {
    // 300 + L4(3)*300 = 1200. 원본 버그면 600. now=1000 → 2200.
    const next = specialBuff(
      req({ caster: makeCaster({ class: FIGHTER, intBonus: 0, level: 10 }), ctx: makeCtx({ now: 1000 }) }),
      SPELL_NO.SLIGHT,
    )
    expect(next.buffs?.[String(SPELL_NO.SLIGHT)]).toEqual({ until: 2200 })
  })
})

// ── T9.4 projectBuffFlags: 활성 Story 9 버프 → P-flag hex 투영 ───────────────────
describe('projectBuffFlags — 활성 버프/감지 → P-flag hex(projectResistFlags 계약 승계)', () => {
  const cases: ReadonlyArray<readonly [number, number]> = [
    [SPELL_NO.SBLESS, PBLESS],
    [SPELL_NO.SPROTE, PPROTE],
    [SPELL_NO.SINVIS, PINVIS],
    [SPELL_NO.SLEVIT, PLEVIT],
    [SPELL_NO.SBRWAT, PBRWAT],
    [SPELL_NO.SDINVI, PDINVI],
    [SPELL_NO.SDMAGI, PDMAGI],
    [SPELL_NO.SKNOWA, PKNOWA],
    [SPELL_NO.SFLYSP, PFLYSP],
    [SPELL_NO.SLIGHT, PLIGHT],
  ]

  for (const [spellNo, bit] of cases) {
    it(`주문 ${spellNo} 활성 → P-flag 비트 ${bit} set`, () => {
      const dispatch = new SpellDispatch<BuffEffectHandler>()
      registerTimedBuffs(dispatch)
      const c = dispatch.resolve(spellNo)!(req({ ctx: makeCtx({ now: 1000 }) }))
      expect(F_ISSET(projectBuffFlags(c, 1000), bit)).toBe(true)
    })
  }

  it('만료된 버프는 P-flag를 세팅하지 않는다', () => {
    // SBLESS FIGHTER B=0 → dur 1200. now=500 → until=1700. tick=1701 만료.
    const c = standardBuff(
      req({ caster: makeCaster({ class: FIGHTER }), ctx: makeCtx({ now: 500 }) }),
      SPELL_NO.SBLESS,
    )
    expect(F_ISSET(projectBuffFlags(c, 1701), PBLESS)).toBe(false)
  })

  it('버프 없는 Character는 전 P-flag off', () => {
    const hex = projectBuffFlags(makeCharacter(), 1000)
    for (const bit of [PBLESS, PPROTE, PINVIS, PLEVIT, PBRWAT, PDINVI, PDMAGI, PKNOWA, PFLYSP, PLIGHT]) {
      expect(F_ISSET(hex, bit)).toBe(false)
    }
  })
})

// ── T9.4 registerTimedBuffs: 자체 버프 dispatch 등록 + immutability ──────────────
describe('registerTimedBuffs — 버프-family 디스패치(10주문)', () => {
  it('타이머 보유 10주문을 모두 등록한다', () => {
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerTimedBuffs(dispatch)
    const all = [
      SPELL_NO.SBLESS, SPELL_NO.SPROTE, SPELL_NO.SINVIS, SPELL_NO.SLEVIT, SPELL_NO.SBRWAT,
      SPELL_NO.SDINVI, SPELL_NO.SDMAGI, SPELL_NO.SKNOWA, SPELL_NO.SFLYSP, SPELL_NO.SLIGHT,
    ]
    for (const spellNo of all) expect(typeof dispatch.resolve(spellNo)).toBe('function')
    expect(TIMED_BUFF_SPELLS).toHaveLength(10)
  })

  it('SBRWAT(family=buff)·SLIGHT(family=utility)가 이 Story에 안착한다(결정 요약 #1)', () => {
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerTimedBuffs(dispatch)
    expect(TIMED_BUFF_SPELLS).toContain(SPELL_NO.SBRWAT)
    expect(TIMED_BUFF_SPELLS).toContain(SPELL_NO.SLIGHT)
    expect(typeof dispatch.resolve(SPELL_NO.SBRWAT)).toBe('function')
    expect(typeof dispatch.resolve(SPELL_NO.SLIGHT)).toBe('function')
  })

  it('resistBuff family(SRFIRE 등)와 같은 인스턴스에 공존 등록 가능(핸들러 타입 동일)', () => {
    // buff-family 단일 dispatch: resistBuff 4 + timed 10을 한 인스턴스에 등록해도 충돌 없음.
    const dispatch = new SpellDispatch<BuffEffectHandler>()
    registerResistBuffs(dispatch)
    registerTimedBuffs(dispatch)
    expect(typeof dispatch.resolve(SPELL_NO.SRFIRE)).toBe('function')
    expect(typeof dispatch.resolve(SPELL_NO.SBLESS)).toBe('function')
  })

  it('effect는 입력 Character·buffs를 변형하지 않는다(immutability)', () => {
    const target = makeCharacter({ buffs: { [String(SPELL_NO.SDMAGI)]: { until: 42 } } })
    const next = specialBuff(req({ target, caster: makeCaster({ class: FIGHTER }) }), SPELL_NO.SLIGHT)
    // 원본 불변.
    expect(target.buffs).toEqual({ [String(SPELL_NO.SDMAGI)]: { until: 42 } })
    // 기존 엔트리 병합 + 새 엔트리.
    expect(next.buffs?.[String(SPELL_NO.SDMAGI)]).toEqual({ until: 42 })
    expect(next.buffs?.[String(SPELL_NO.SLIGHT)]).toBeDefined()
  })
})
