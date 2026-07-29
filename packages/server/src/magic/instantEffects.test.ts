import { describe, it, expect } from 'vitest'
import { SPELL_NO, SPELL_CATALOG, type Character, type CreatureInstance } from 'shared'
import { SpellDispatch } from './dispatch.js'
import { toCombatant } from '../combat/combatant.js'
import { seqRng, maxRollRng } from '../combat/dice.testutil.js'
import { CLERIC, PALADIN, FIGHTER, INVINCIBLE } from '../combat/constants.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import {
  registerInstantEffects,
  registerCureEffects,
  INSTANT_SPELLS,
  type InstantEffectHandler,
  type InstantEffectRequest,
  type CureEffectHandler,
} from './instantEffects.js'
import { RESIST_SPELLS, TIMED_BUFF_SPELLS } from './buffEffects.js'
import { DEBUFF_SPELLS } from './debuffEffects.js'

/**
 * instantEffects 단위 테스트 — Story 10(G7 즉발). 세 handler 셰이프:
 *   - report(InstantEffectHandler → InstantOutcome): 회복 5 + 즉발 seam 8 = 13.
 *   - cure(CureEffectHandler → Character): statusEffects 해제 3.
 * 회복량은 caster 파생(int/piety/class/level/rng)이라 target hp를 읽지 않는다 — pure-report(Story 8 선례).
 * 모든 굴림은 seqRng(초과 호출 시 throw)로 결정화 — 각 케이스의 굴림 개수가 계약이다.
 */

const ZERO16 = '0000000000000000'

function makeCaster(over: Partial<Caster> = {}): Caster {
  return {
    mpCurrent: 100,
    level: 10,
    realm: [0, 0, 0, 0],
    class: FIGHTER,
    intBonus: 2,
    knows: () => true,
    ...over,
  }
}

function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'crt-1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 30,
    hpcur: 10,
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
    intelligence: 0,
    piety: 0,
    experience: 1000,
    flags: ZERO16,
    enemies: [],
    inventory: [],
    ...over,
  }
}

/** rpmext=true면 RPMEXT(bit 32 → flags[4] bit0) 세팅 방 flags를 만든다. */
function makeCtx(rolls: readonly number[], rpmext = false): CastContext {
  return ctxWith(seqRng(rolls), rpmext)
}

/** 임의 CombatRng로 CastContext를 만든다(args-sensitive rng로 mrand(1,N) 경계 pinning). */
function ctxWith(rng: CastContext['rng'], rpmext = false): CastContext {
  return {
    gated: true,
    rng,
    room: {
      roomId: 50,
      name: '방',
      shortDesc: '',
      longDesc: '',
      exits: [],
      items: [],
      flags: rpmext ? [0, 0, 0, 0, 1, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0],
      occupants: new Set<string>(),
      creatures: [],
      permMon: [],
      random: [],
      traffic: 0,
    },
    now: 1000,
    fireCreatureDeath: () => {},
    firePlayerDeath: () => {},
    ledger: new Map<string, number>(),
  }
}

function makeReq(over: Partial<InstantEffectRequest> = {}): InstantEffectRequest {
  return {
    caster: makeCaster(),
    pietyBonus: 3,
    target: toCombatant(makeCreature()),
    ctx: makeCtx([]),
    ...over,
  }
}

function reportDispatch(): SpellDispatch<InstantEffectHandler> {
  const d = new SpellDispatch<InstantEffectHandler>()
  registerInstantEffects(d)
  return d
}

function cureDispatch(): SpellDispatch<CureEffectHandler> {
  const d = new SpellDispatch<CureEffectHandler>()
  registerCureEffects(d)
  return d
}

const ALL_INSTANT = [
  SPELL_NO.SVIGOR,
  SPELL_NO.SRESTO,
  SPELL_NO.SMENDW,
  SPELL_NO.SFHEAL,
  SPELL_NO.SRVIGO,
  SPELL_NO.SCUREP,
  SPELL_NO.SREMOV,
  SPELL_NO.SRMDIS,
  SPELL_NO.SRMBLD,
  SPELL_NO.STELEP,
  SPELL_NO.SRECAL,
  SPELL_NO.SSUMMO,
  SPELL_NO.SENCHA,
  SPELL_NO.STRANO,
  SPELL_NO.STRACK,
  SPELL_NO.SLOCAT,
]

// ── 등록(Completion Criterion 1) ─────────────────────────────────────────────
describe('registerInstantEffects/registerCureEffects — 즉발 16주문 등록', () => {
  it('INSTANT_SPELLS가 정확히 16주문이다', () => {
    expect([...INSTANT_SPELLS].sort((a, b) => a - b)).toEqual([...ALL_INSTANT].sort((a, b) => a - b))
  })

  it('report dispatch가 회복 5 + seam 8 = 13주문을 resolve한다', () => {
    const d = reportDispatch()
    const report = [
      SPELL_NO.SVIGOR,
      SPELL_NO.SRESTO,
      SPELL_NO.SMENDW,
      SPELL_NO.SFHEAL,
      SPELL_NO.SRVIGO,
      SPELL_NO.SREMOV,
      SPELL_NO.STELEP,
      SPELL_NO.SRECAL,
      SPELL_NO.SSUMMO,
      SPELL_NO.SENCHA,
      SPELL_NO.STRANO,
      SPELL_NO.STRACK,
      SPELL_NO.SLOCAT,
    ]
    for (const spellNo of report) expect(d.resolve(spellNo)).toBeTypeOf('function')
  })

  it('cure dispatch가 정확히 3주문 {SCUREP,SRMDIS,SRMBLD}을 resolve한다', () => {
    const d = cureDispatch()
    for (const spellNo of [SPELL_NO.SCUREP, SPELL_NO.SRMDIS, SPELL_NO.SRMBLD]) {
      expect(d.resolve(spellNo)).toBeTypeOf('function')
    }
  })
})

// ── 회복(Completion Criterion 4) ─────────────────────────────────────────────
describe('healing family — A6 §2 회복량', () => {
  it('SFHEAL(완치)은 toFull=true, 굴림을 소비하지 않는다', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SFHEAL)!
    const out = handler(makeReq({ ctx: makeCtx([]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: true } })
  })

  it('SVIGOR(회복) 비-CLERIC/PALADIN: heal = MAX(int,piety) + mrand(1,6), 굴림 1회', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SVIGOR)!
    // intBonus=2, pietyBonus=3, FIGHTER → 클래스 굴림 없음. base 굴림 5 → heal = 3 + 5 = 8.
    const out = handler(makeReq({ ctx: makeCtx([5]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 8 } })
  })

  it('SVIGOR CLERIC: L4 보너스 + 굴림 2회(클래스 mrand + base mrand)', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SVIGOR)!
    // level=10 → L4=3. CLERIC: += 3 + mrand(1,1+1=2). base mrand(1,6).
    // 굴림 [2, 5] → heal = MAX(2,3)=3 + (3+2) + 5 = 13.
    const out = handler(makeReq({ caster: makeCaster({ class: CLERIC }), ctx: makeCtx([2, 5]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 13 } })
  })

  it('SVIGOR RPMEXT 방: 추가 mrand(1,3) 굴림', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SVIGOR)!
    // FIGHTER base 굴림 5, RPMEXT 굴림 3 → heal = 3 + 5 + 3 = 11.
    const out = handler(makeReq({ ctx: makeCtx([5, 3], true) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 11 } })
  })

  it('SMENDW(원기회복) 비-클래스: heal = MAX(int,piety) + dice(2,6,0), 굴림 2회', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SMENDW)!
    // dice(2,6,0) 굴림 [4,5] → 9. heal = MAX(2,3)=3 + 9 = 12.
    const out = handler(makeReq({ ctx: makeCtx([4, 5]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 12 } })
  })

  it('SVIGOR PALADIN: L4/2 보너스 + 굴림 2회', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SVIGOR)!
    // level=10 → L4=3. PALADIN: += trunc(3/2)=1 + mrand(1,1+trunc(3/4)=1). base mrand(1,6).
    // 굴림 [1, 5] → heal = MAX(2,3)=3 + (1+1) + 5 = 10.
    const out = handler(makeReq({ caster: makeCaster({ class: PALADIN }), ctx: makeCtx([1, 5]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 10 } })
  })

  it('SMENDW PALADIN: L4 클래스 보너스 + RPMEXT 굴림', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SMENDW)!
    // level=10 → L4=3. PALADIN: += 3 + mrand(1,1+trunc(3/3)=1+1=2). dice(2,6,0). RPMEXT: += mrand(1,6)+1.
    // 굴림 [2, 4, 5, 6] → heal = 3 + (3+2) + 9 + (6+1) = 24.
    const out = handler(makeReq({ caster: makeCaster({ class: PALADIN }), ctx: makeCtx([2, 4, 5, 6], true) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 24 } })
  })

  it('SRVIGO RPMEXT 방: 추가 mrand(1,3) 굴림', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRVIGO)!
    // mrand(1,6)=4, pietyBonus=3, RPMEXT mrand(1,3)=2 → 4+3+2 = 9.
    const out = handler(makeReq({ ctx: makeCtx([4, 2], true) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 9 } })
  })

  it('SMENDW INVINCIBLE↑: 2*L4 클래스 보너스 적용', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SMENDW)!
    // level=10 → L4=3. class>=INVINCIBLE: += 2*3 + mrand(1,1+1=2). dice(2,6,0).
    // 굴림 [2, 4, 5] → heal = 3 + (6+2) + 9 = 20.
    const out = handler(makeReq({ caster: makeCaster({ class: INVINCIBLE }), ctx: makeCtx([2, 4, 5]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 20 } })
  })

  it('SRESTO(도력반): heal = dice(2,10,0), mrand(1,100)<60이면 restoredMana', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRESTO)!
    // dice(2,10,0) 굴림 [7,8]=15, mrand(1,100)=59(<60) → restoredMana true.
    const out = handler(makeReq({ ctx: makeCtx([7, 8, 59]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 15, restoredMana: true } })
  })

  it('SRESTO: mrand(1,100)>=60이면 restoredMana false', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRESTO)!
    const out = handler(makeReq({ ctx: makeCtx([7, 8, 60]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 15, restoredMana: false } })
  })

  it('SRVIGO(전회복): heal = mrand(1,6) + pietyBonus', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRVIGO)!
    // mrand(1,6)=4, pietyBonus=3 → 7.
    const out = handler(makeReq({ ctx: makeCtx([4]) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 7 } })
  })

  // ── 범위 경계 pinning(args-sensitive maxRollRng — mrand(1,N)의 N을 고정) ─────
  // seqRng는 위치별 preset이라 roll count/합만 고정한다. maxRollRng는 rng(1,N)→N을 반환해 각 공식의
  // N 경계(오라클 상한)를 off-by-one까지 pin한다 — 오라클-critical 회복식 방어(기존 seqRng 케이스 유지).

  it('SVIGOR CLERIC: mrand(1, 1+L4/2) 상한 경계 pinning', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SVIGOR)!
    // level=10 → L4=3. CLERIC N = 1+trunc(3/2)=2, base N=6. maxRoll: 클래스 굴림 2, base 굴림 6.
    // heal = MAX(2,3)=3 + (3 + 2) + 6 = 14. (CLERIC N을 1+L4/4로 잘못 쓰면 N=1 → 값 달라짐.)
    const out = handler(makeReq({ caster: makeCaster({ class: CLERIC }), ctx: ctxWith(maxRollRng) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 14 } })
  })

  it('SMENDW PALADIN: mrand(1, 1+L4/3) 상한 경계 pinning', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SMENDW)!
    // level=21 → L4=6. PALADIN N = 1+trunc(6/3)=3(≠ 1+trunc(6/2)=4로 판별). dice(2,6,0) maxRoll=12.
    // heal = MAX(2,3)=3 + (6 + 3) + 12 = 24.
    const out = handler(
      makeReq({ caster: makeCaster({ class: PALADIN, level: 21 }), ctx: ctxWith(maxRollRng) }),
    )
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 24 } })
  })

  it('SRESTO: dice(2,10,0) sdice·mrand(1,100) 상한 경계 pinning', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRESTO)!
    // dice(2,10,0) maxRoll = 10+10 = 20. mrand(1,100) maxRoll = 100(≥60) → restoredMana false.
    const out = handler(makeReq({ ctx: ctxWith(maxRollRng) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 20, restoredMana: false } })
  })

  it('SRVIGO: mrand(1,6) 상한 경계 pinning', () => {
    const handler = reportDispatch().resolve(SPELL_NO.SRVIGO)!
    // mrand(1,6) maxRoll = 6, pietyBonus=3 → 9.
    const out = handler(makeReq({ ctx: ctxWith(maxRollRng) }))
    expect(out).toEqual({ kind: 'heal', heal: { toFull: false, healed: 9 } })
  })
})

// ── 즉발 seam(Completion Criterion 1) ────────────────────────────────────────
describe('즉발 seam — 이동/유틸/감지/저주해소 pure-report', () => {
  const seams: readonly [number, string][] = [
    [SPELL_NO.STELEP, 'teleport'],
    [SPELL_NO.SRECAL, 'recall'],
    [SPELL_NO.SSUMMO, 'summon'],
    [SPELL_NO.SENCHA, 'enchant'],
    [SPELL_NO.STRANO, 'object_send'],
    [SPELL_NO.STRACK, 'track'],
    [SPELL_NO.SLOCAT, 'locate_player'],
    [SPELL_NO.SREMOV, 'remove_curse'],
  ]
  for (const [spellNo, effect] of seams) {
    it(`${effect}은 { kind:'seam', effect } 보고(굴림·write 없음)`, () => {
      const handler = reportDispatch().resolve(spellNo)!
      expect(handler(makeReq({ ctx: makeCtx([]) }))).toEqual({ kind: 'seam', effect })
    })
  }
})

// ── cure(Completion Criterion 3) ─────────────────────────────────────────────
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

describe('cure family — statusEffects 필드 해제', () => {
  it('SCUREP(해독)이 poison만 해제하고 disease/blind는 보존한다', () => {
    const before = makeCharacter({
      statusEffects: { poison: { until: 100, interval: 6 }, disease: { until: 200, interval: 12 }, blind: { until: 300 } },
    })
    const after = cureDispatch().resolve(SPELL_NO.SCUREP)!(before)
    expect(after.statusEffects).toEqual({ disease: { until: 200, interval: 12 }, blind: { until: 300 } })
    // immutability — 입력 불변.
    expect(before.statusEffects?.poison).toEqual({ until: 100, interval: 6 })
  })

  it('SRMDIS(치료)가 disease만 해제한다', () => {
    const before = makeCharacter({
      statusEffects: { poison: { until: 100, interval: 6 }, disease: { until: 200, interval: 12 } },
    })
    const after = cureDispatch().resolve(SPELL_NO.SRMDIS)!(before)
    expect(after.statusEffects).toEqual({ poison: { until: 100, interval: 6 } })
  })

  it('SRMBLD(개안술)이 blind만 해제한다', () => {
    const before = makeCharacter({ statusEffects: { blind: { until: 300 } } })
    const after = cureDispatch().resolve(SPELL_NO.SRMBLD)!(before)
    expect(after.statusEffects).toEqual({})
  })

  it('statusEffects가 없으면 입력을 그대로 반환한다(throw 없음)', () => {
    const before = makeCharacter()
    const after = cureDispatch().resolve(SPELL_NO.SCUREP)!(before)
    expect(after).toEqual(before)
  })
})

// ── 커버리지 union=36(Completion Criterion 5) ────────────────────────────────
describe('비-offensive 36주문 커버리지 — Story 7·8·9·10 union', () => {
  it('RESIST(4)+DEBUFF(6)+TIMED_BUFF(10)+INSTANT(16) = 36, 중복 0(disjoint)', () => {
    expect(RESIST_SPELLS.length).toBe(4)
    expect(DEBUFF_SPELLS.length).toBe(6)
    expect(TIMED_BUFF_SPELLS.length).toBe(10)
    expect(INSTANT_SPELLS.length).toBe(16)
    const all = [...RESIST_SPELLS, ...DEBUFF_SPELLS, ...TIMED_BUFF_SPELLS, ...INSTANT_SPELLS]
    expect(all.length).toBe(36)
    // union set size가 36이면 중복 0(disjoint)이고 정확히 36을 닫는다.
    expect(new Set(all).size).toBe(36)
  })

  it('union이 SPELL_CATALOG 비-offensive 집합과 정확히 일치한다(누락·초과 0 — 커버리지 표 대조)', () => {
    // 카탈로그 정본(family 필드)과 대조 — disjoint·중복뿐 아니라 "누락 없이" 절반을 닫는다.
    const catalogNonOffensive = new Set(
      SPELL_CATALOG.filter((entry) => !entry.offensive).map((entry) => entry.spellNo),
    )
    const union = new Set([...RESIST_SPELLS, ...DEBUFF_SPELLS, ...TIMED_BUFF_SPELLS, ...INSTANT_SPELLS])
    expect(union).toEqual(catalogNonOffensive)
  })
})
