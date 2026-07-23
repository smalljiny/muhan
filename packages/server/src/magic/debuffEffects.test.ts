import { describe, it, expect } from 'vitest'
import { SPELL_NO, type CreatureInstance } from 'shared'
import { SpellDispatch } from './dispatch.js'
import { toCombatant } from '../combat/combatant.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import { seqRng } from '../combat/dice.testutil.js'
import { F_SET, MPERMT, MNOCHA, MRMAGI, MRBEFD, MFEARS, MSILNC, MBLIND, MCHARM, MBEFUD } from '../world/hexFlags.js'
import { MAGE, FIGHTER } from '../combat/constants.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import { registerDebuffs, DEBUFF_SPELLS, type DebuffEffectHandler } from './debuffEffects.js'

/**
 * debuffEffects 단위 테스트 — Story 8(G6). offensiveSpell 패러다임(target=Combatant creature)을 미러링한
 * pure-report DebuffOutcome. 모든 굴림은 seqRng(초과 호출 시 throw)로 결정화 — 각 케이스의 굴림 개수가
 * 계약이다(fear/charm=1굴림, silence/blind=0, befuddle=2, drain=L4굴림).
 *
 * dur은 상대 초(초 단위)로 보고한다(#99 라이브 조립이 now+dur을 계산) — offensiveSpell.realmGrowth의
 * defer-write 선례. 실 charmedUntil/befuddledUntil/flags write·MUNKIL·caster-class 게이트는 이 모듈 밖.
 */

const ZERO16 = '0000000000000000'

function makeCaster(over: Partial<Caster> = {}): Caster {
  return {
    mpCurrent: 100,
    level: 20,
    realm: [0, 0, 0, 0],
    class: MAGE,
    intBonus: 0,
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
    hpcur: 30,
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

function makePlayer(over: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'char-1',
    hpCurrent: 30,
    mpCurrent: 0,
    level: 10,
    class: FIGHTER,
    effectiveStrength: 10,
    effectiveIntelligence: 10,
    armor: 0,
    thaco: 10,
    dexterity: 12,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    flags: '',
    alignment: 0,
    weapon: null,
    nextAttackAt: 0,
    ...over,
  }
}

function makeCtx(rolls: readonly number[]): CastContext {
  return {
    gated: true,
    rng: seqRng(rolls),
    room: {
      roomId: 50,
      name: '방',
      shortDesc: '',
      longDesc: '',
      exits: [],
      items: [],
      flags: [0, 0, 0, 0, 0, 0, 0, 0],
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

function dispatch(): SpellDispatch<DebuffEffectHandler> {
  const d = new SpellDispatch<DebuffEffectHandler>()
  registerDebuffs(d)
  return d
}

// ── 등록(Completion Criterion 1·7) ───────────────────────────────────────────
describe('registerDebuffs — 6주문 등록', () => {
  it('debuff family 정확히 6주문 {SBEFUD,SDREXP,SFEARS,SBLIND,SSILNC,SCHARM}을 등록한다', () => {
    expect([...DEBUFF_SPELLS].sort((a, b) => a - b)).toEqual(
      [
        SPELL_NO.SBEFUD,
        SPELL_NO.SDREXP,
        SPELL_NO.SFEARS,
        SPELL_NO.SBLIND,
        SPELL_NO.SSILNC,
        SPELL_NO.SCHARM,
      ].sort((a, b) => a - b),
    )
  })

  it('각 주문이 resolve로 핸들러를 반환한다', () => {
    const d = dispatch()
    for (const spellNo of DEBUFF_SPELLS) {
      expect(d.resolve(spellNo)).toBeTypeOf('function')
    }
  })
})

// ── fear (Completion Criterion 2·4) ──────────────────────────────────────────
describe('fear — SFEARS', () => {
  it('dur = 600 + mrand(1,30)*10 + B*150, flag MFEARS', () => {
    const h = dispatch().resolve(SPELL_NO.SFEARS)!
    const out = h({
      caster: makeCaster({ intBonus: 2 }),
      target: toCombatant(makeCreature()),
      ctx: makeCtx([30]),
    })
    // 600 + 30*10 + 2*150 = 1200
    expect(out).toEqual({ applied: true, flag: MFEARS, dur: 1200 })
  })

  it('PRMAGI(MRMAGI) 대상이면 dur/2', () => {
    const h = dispatch().resolve(SPELL_NO.SFEARS)!
    const out = h({
      caster: makeCaster({ intBonus: 2 }),
      target: toCombatant(makeCreature({ flags: F_SET(ZERO16, MRMAGI) })),
      ctx: makeCtx([30]),
    })
    // trunc(1200/2) = 600
    expect(out).toEqual({ applied: true, flag: MFEARS, dur: 600 })
  })

  it('MPERMT 대상이면 완전 면역(applied=false, 효과 미부여)', () => {
    const h = dispatch().resolve(SPELL_NO.SFEARS)!
    const out = h({
      caster: makeCaster({ intBonus: 2 }),
      target: toCombatant(makeCreature({ flags: F_SET(ZERO16, MPERMT) })),
      // roll-then-guard: 오라클은 면역이어도 dur mrand를 최상단에서 소비한다 → 굴림 1개 필요.
      ctx: makeCtx([30]),
    })
    expect(out).toEqual({ applied: false })
  })
})

// ── silence (Completion Criterion 2) ─────────────────────────────────────────
describe('silence — SSILNC', () => {
  it('dur = 3600 고정(굴림·int 항 없음), flag MSILNC', () => {
    const h = dispatch().resolve(SPELL_NO.SSILNC)!
    const out = h({
      caster: makeCaster({ intBonus: 5 }),
      target: toCombatant(makeCreature()),
      ctx: makeCtx([]), // rollDie=0 → rng 미소비
    })
    expect(out).toEqual({ applied: true, flag: MSILNC, dur: 3600 })
  })

  it('PRMAGI 대상이면 dur/2 = 1800', () => {
    const h = dispatch().resolve(SPELL_NO.SSILNC)!
    const out = h({
      caster: makeCaster(),
      target: toCombatant(makeCreature({ flags: F_SET(ZERO16, MRMAGI) })),
      ctx: makeCtx([]),
    })
    expect(out).toEqual({ applied: true, flag: MSILNC, dur: 1800 })
  })
})

// ── charm (Completion Criterion 2·3) ─────────────────────────────────────────
describe('charm — SCHARM', () => {
  it('dur = 300 + mrand(1,30)*10 + B*30, flag MCHARM', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const out = h({
      caster: makeCaster({ level: 20, intBonus: 2 }),
      target: toCombatant(makeCreature({ level: 3 })),
      ctx: makeCtx([30]),
    })
    // 300 + 30*10 + 2*30 = 660
    expect(out).toEqual({ applied: true, flag: MCHARM, dur: 660 })
  })

  it('시전자 lvl < 대상 lvl이면 완전 반탄(applied=false)', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const out = h({
      caster: makeCaster({ level: 3 }),
      target: toCombatant(makeCreature({ level: 10 })),
      // roll-then-guard: 반탄되어도 dur mrand는 최상단에서 소비된다 → 굴림 1개 필요.
      ctx: makeCtx([30]),
    })
    expect(out).toEqual({ applied: false })
  })

  it('시전자 lvl == 대상 lvl이면 반탄되지 않고 성공한다(엄격 < 경계)', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const out = h({
      caster: makeCaster({ level: 5, intBonus: 0 }),
      target: toCombatant(makeCreature({ level: 5 })),
      ctx: makeCtx([10]),
    })
    // 300 + 10*10 + 0 = 400
    expect(out).toEqual({ applied: true, flag: MCHARM, dur: 400 })
  })

  it('MNOCHA 대상이면 완전 반탄(applied=false)', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const out = h({
      caster: makeCaster({ level: 99 }),
      target: toCombatant(makeCreature({ level: 1, flags: F_SET(ZERO16, MNOCHA) })),
      // roll-then-guard: MNOCHA 반탄이어도 dur mrand는 소비된다 → 굴림 1개 필요.
      ctx: makeCtx([30]),
    })
    expect(out).toEqual({ applied: false })
  })

  it('PRMAGI 대상이면 dur/2', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const out = h({
      caster: makeCaster({ level: 20, intBonus: 2 }),
      target: toCombatant(makeCreature({ level: 3, flags: F_SET(ZERO16, MRMAGI) })),
      ctx: makeCtx([30]),
    })
    // trunc(660/2) = 330
    expect(out).toEqual({ applied: true, flag: MCHARM, dur: 330 })
  })
})

// ── befuddle (Completion Criterion 2 — HANDOFF B shortening 모델) ─────────────
describe('befuddle — SBEFUD (computeDebuffDur 미사용, shortening 모델)', () => {
  it('CAST dur = B + dice(2,6,0), else MAX(5,dur), flag MBEFUD', () => {
    const h = dispatch().resolve(SPELL_NO.SBEFUD)!
    const out = h({
      caster: makeCaster({ intBonus: 4 }),
      target: toCombatant(makeCreature()),
      ctx: makeCtx([6, 6]), // dice(2,6,0)=12
    })
    // 4 + 12 = 16, MAX(5,16)=16
    expect(out).toEqual({ applied: true, flag: MBEFUD, dur: 16 })
  })

  it('MAX(5) 하한 — 낮은 굴림은 5로 바닥된다', () => {
    const h = dispatch().resolve(SPELL_NO.SBEFUD)!
    const out = h({
      caster: makeCaster({ intBonus: 0 }),
      target: toCombatant(makeCreature()),
      ctx: makeCtx([1, 1]), // dice(2,6,0)=2 → 0+2=2 → MAX(5,2)=5
    })
    expect(out).toEqual({ applied: true, flag: MBEFUD, dur: 5 })
  })

  it('MRMAGI 대상이면 dur=3(단축, dice는 여전히 굴린다)', () => {
    const h = dispatch().resolve(SPELL_NO.SBEFUD)!
    const out = h({
      caster: makeCaster({ intBonus: 4 }),
      target: toCombatant(makeCreature({ flags: F_SET(ZERO16, MRMAGI) })),
      ctx: makeCtx([6, 6]), // dice 굴림 소비 후 dur=3 오버라이드
    })
    expect(out).toEqual({ applied: true, flag: MBEFUD, dur: 3 })
  })

  it('MRBEFD(혼동 저항) 대상이면 dur=3', () => {
    const h = dispatch().resolve(SPELL_NO.SBEFUD)!
    const out = h({
      caster: makeCaster({ intBonus: 4 }),
      target: toCombatant(makeCreature({ flags: F_SET(ZERO16, MRBEFD) })),
      ctx: makeCtx([6, 6]),
    })
    expect(out).toEqual({ applied: true, flag: MBEFUD, dur: 3 })
  })
})

// ── blind (Completion Criterion 6 — OpenQ #3-b) ──────────────────────────────
describe('blind — SBLIND (타이머 없음 = 영구 실명, 원본 충실)', () => {
  it('flag MBLIND를 부여하되 dur을 걸지 않는다(magic8.c dur 미사용 = 개안 전까지 영구)', () => {
    const h = dispatch().resolve(SPELL_NO.SBLIND)!
    const out = h({
      caster: makeCaster(),
      target: toCombatant(makeCreature()),
      ctx: makeCtx([]), // 굴림 없음
    })
    expect(out).toEqual({ applied: true, flag: MBLIND })
    expect(out.dur).toBeUndefined()
  })
})

// ── drain_exp (Completion Criterion 5) ───────────────────────────────────────
describe('drain_exp — SDREXP (즉발, 타이머·플래그 없음)', () => {
  it('expLoss = dice(L4,L4,1)*30, L4=trunc((lvl+3)/4)', () => {
    const h = dispatch().resolve(SPELL_NO.SDREXP)!
    // lvl 20 → L4=5 → dice(5,5,1)=sum5 + 1
    const out = h({
      caster: makeCaster({ level: 20 }),
      target: toCombatant(makeCreature({ experience: 100000 })),
      ctx: makeCtx([5, 5, 5, 5, 5]), // sum=25 → +1 = 26 → *30 = 780
    })
    expect(out).toEqual({ applied: true, expLoss: 780 })
    expect(out.flag).toBeUndefined()
    expect(out.dur).toBeUndefined()
  })

  it('expLoss는 대상 현재 경험치로 캡된다(MIN)', () => {
    const h = dispatch().resolve(SPELL_NO.SDREXP)!
    const out = h({
      caster: makeCaster({ level: 20 }),
      target: toCombatant(makeCreature({ experience: 100 })),
      ctx: makeCtx([5, 5, 5, 5, 5]), // raw 780 → min(780,100)=100
    })
    expect(out).toEqual({ applied: true, expLoss: 100 })
  })

  it('experience 미설정 대상이면 expLoss=0(?? 0)', () => {
    const h = dispatch().resolve(SPELL_NO.SDREXP)!
    const out = h({
      caster: makeCaster({ level: 20 }),
      target: toCombatant(makeCreature({ experience: undefined })),
      ctx: makeCtx([5, 5, 5, 5, 5]),
    })
    expect(out).toEqual({ applied: true, expLoss: 0 })
  })
})

// ── player 대상 유예(HANDOFF A — PvP P-flag 전 계열 defer) ────────────────────
describe('player 대상은 유예(applied=false)', () => {
  it.each([
    ['fear', SPELL_NO.SFEARS],
    ['silence', SPELL_NO.SSILNC],
    ['charm', SPELL_NO.SCHARM],
    ['befuddle', SPELL_NO.SBEFUD],
    ['blind', SPELL_NO.SBLIND],
    ['drain_exp', SPELL_NO.SDREXP],
  ])('%s를 player 대상에 걸면 미부여(offensiveSpell player-resist defer 선례)', (_name, spellNo) => {
    const h = dispatch().resolve(spellNo)!
    const out = h({
      caster: makeCaster(),
      target: toCombatant(makePlayer()),
      ctx: makeCtx([]), // player defer는 굴림 前 반환 — rng 미소비
    })
    expect(out).toEqual({ applied: false })
  })
})

// ── 순수성(immutability) ─────────────────────────────────────────────────────
describe('순수 함수 — 입력 creature를 변형하지 않는다', () => {
  it('charm 성공이 target.instance.flags를 변형하지 않는다(pure-report)', () => {
    const h = dispatch().resolve(SPELL_NO.SCHARM)!
    const creature = makeCreature({ level: 3 })
    const before = creature.flags
    h({ caster: makeCaster({ level: 20 }), target: toCombatant(creature), ctx: makeCtx([10]) })
    expect(creature.flags).toBe(before)
    expect(creature.charmedUntil).toBeUndefined()
  })

  it('drain_exp가 target.instance.experience를 변형하지 않는다(pure-report)', () => {
    const h = dispatch().resolve(SPELL_NO.SDREXP)!
    const creature = makeCreature({ experience: 1000 })
    h({ caster: makeCaster({ level: 20 }), target: toCombatant(creature), ctx: makeCtx([5, 5, 5, 5, 5]) })
    expect(creature.experience).toBe(1000)
  })
})
