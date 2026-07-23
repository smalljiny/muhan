import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  REALM,
  OSPELL_GRID,
  SPELL_NO,
  approve,
  goldenFixtureSchema,
  type CreatureInstance,
  type OspellEntry,
  type RoomNode,
} from 'shared'
import { SpellDispatch } from './dispatch.js'
import { toCombatant } from '../combat/combatant.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import type { DamageLedger } from '../combat/enmity.js'
import { seqRng } from '../combat/dice.testutil.js'
import { F_SET, MRMAGI } from '../world/hexFlags.js'
import { setFlag } from '../world/door.js'
import { MAGE, FIGHTER } from '../combat/constants.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import {
  computeBns,
  offensiveSpell,
  registerOffensiveSpells,
  REARTH,
  RWINDR,
  RFIRER,
  RWATER,
  type OffensiveSpellHandler,
} from './offensiveSpell.js'

/**
 * offensiveSpell 단위 테스트 — bns(T5.2)·방상성(T5.3)·마법저항(T5.4)·applySpellDamage 데미지순서(T5.5).
 * 모든 굴림은 seqRng(초과 호출 시 throw)로 결정화 — 각 케이스의 dice 굴림 개수(=ndice)가 계약이다.
 * 데미지 순서: max(1) → 저항(creature만) → m=min(hpBefore,dmg) → ledger(m) → hp-=dmg → death once.
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

// realm은 number로 받아 OspellEntry['realm'](Realm union)로 캐스트한다 — fixture 입력·상성 루프가
// plain number(realm 코드)를 넘기고, offensiveSpell은 realm을 REALM.* 숫자와 === 비교만 하므로 안전하다.
function makeOsp(over: Partial<Record<keyof OspellEntry, number>> = {}): OspellEntry {
  // tier2 기본(2d5+7, bonusType 2) — 명시 오버라이드로 tier·realm 변경.
  return {
    spellNo: over.spellNo ?? 29,
    realm: (over.realm ?? REALM.WIND) as OspellEntry['realm'],
    mp: over.mp ?? 7,
    ndice: over.ndice ?? 2,
    sdice: over.sdice ?? 5,
    pdice: over.pdice ?? 7,
    bonusType: over.bonusType ?? 2,
  }
}

function makeCreatureTarget(over: Partial<CreatureInstance> = {}): CreatureInstance {
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
    flags: ZERO16,
    enemies: [],
    inventory: [],
    ...over,
  }
}

function makePlayerTarget(over: Partial<PlayerCombatState> = {}): PlayerCombatState {
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

type DeathCall = readonly [unknown, RoomNode, number]
interface CtxHarness {
  readonly ctx: CastContext
  readonly ledger: DamageLedger
  readonly creatureDeaths: DeathCall[]
  readonly playerDeaths: DeathCall[]
}

function makeCtx(
  rolls: readonly number[],
  opts: { gated?: boolean; room?: RoomNode } = {},
): CtxHarness {
  const ledger: DamageLedger = new Map<string, number>()
  const creatureDeaths: DeathCall[] = []
  const playerDeaths: DeathCall[] = []
  const ctx: CastContext = {
    gated: opts.gated ?? false,
    rng: seqRng(rolls),
    room: opts.room ?? makeRoom(),
    now: 1000,
    fireCreatureDeath: (dead, r, n) => {
      creatureDeaths.push([dead, r, n])
    },
    firePlayerDeath: (dead, r, n) => {
      playerDeaths.push([dead, r, n])
    },
    ledger,
  }
  return { ctx, ledger, creatureDeaths, playerDeaths }
}

function roomWith(bit: number): RoomNode {
  const flags = [0, 0, 0, 0, 0, 0, 0, 0]
  setFlag(flags, bit)
  return makeRoom(flags)
}

// ── T5.2 bns 계산 ────────────────────────────────────────────────────────────
describe('computeBns — T5.2 gated 한정 bns', () => {
  it('gated=false면 bns=0(아이템 경로 — mprofic·상성 없음)', () => {
    const caster = makeCaster({ intBonus: 5, realm: [3072, 0, 0, 0] })
    const osp = makeOsp({ realm: REALM.EARTH, bonusType: 1 })
    const { ctx } = makeCtx([], { gated: false })
    expect(computeBns(caster, osp, ctx)).toBe(0)
  })

  it('gated=true: bns=intBonus+trunc(mprofic/K), K=10(bonusType1)', () => {
    // MAGE realm[EARTH-1]=3072 → mprofic=25. bonusType1 → K=10 → trunc(25/10)=2. bns=2+2=4.
    const caster = makeCaster({ intBonus: 2, realm: [3072, 0, 0, 0], class: MAGE })
    const osp = makeOsp({ realm: REALM.EARTH, bonusType: 1 })
    const { ctx } = makeCtx([], { gated: true })
    expect(computeBns(caster, osp, ctx)).toBe(4)
  })

  it('bonusType2 → K=6, bonusType3 → K=4', () => {
    const caster = makeCaster({ intBonus: 2, realm: [3072, 0, 0, 0], class: MAGE })
    const { ctx: ctx2 } = makeCtx([], { gated: true })
    // trunc(25/6)=4 → bns=6
    expect(computeBns(caster, makeOsp({ realm: REALM.EARTH, bonusType: 2 }), ctx2)).toBe(6)
    const { ctx: ctx3 } = makeCtx([], { gated: true })
    // trunc(25/4)=6 → bns=8
    expect(computeBns(caster, makeOsp({ realm: REALM.EARTH, bonusType: 3 }), ctx3)).toBe(8)
  })

  it('realm=0(전 몬스터 caster)이면 mprofic=0 → bns=intBonus만', () => {
    const caster = makeCaster({ intBonus: 3, realm: [0, 0, 0, 0] })
    const osp = makeOsp({ realm: REALM.WIND, bonusType: 2 })
    const { ctx } = makeCtx([], { gated: true })
    expect(computeBns(caster, osp, ctx)).toBe(3)
  })
})

// ── T5.3 방 상성 ─────────────────────────────────────────────────────────────
describe('computeBns — T5.3 방 상성(gated 한정)', () => {
  const caster = () => makeCaster({ intBonus: 4, realm: [0, 0, 0, 0] }) // base bns=4

  it('동속성 강화 ×2 (4개 상극 쌍)', () => {
    const pairs: readonly [number, number][] = [
      [REARTH, REALM.EARTH],
      [RWINDR, REALM.WIND],
      [RFIRER, REALM.FIRE],
      [RWATER, REALM.WATER],
    ]
    for (const [roomBit, realm] of pairs) {
      const { ctx } = makeCtx([], { gated: true, room: roomWith(roomBit) })
      expect(computeBns(caster(), makeOsp({ realm, bonusType: 2 }), ctx)).toBe(8) // 4*2
    }
  })

  it('반대속성 약화 min(-bns,-5) (물↔불, 바람↔땅)', () => {
    const pairs: readonly [number, number][] = [
      [RWATER, REALM.FIRE], // 물방+불 → 약화
      [RFIRER, REALM.WATER], // 불방+물 → 약화
      [RWINDR, REALM.EARTH], // 바람방+땅 → 약화
      [REARTH, REALM.WIND], // 땅방+바람 → 약화
    ]
    for (const [roomBit, realm] of pairs) {
      const { ctx } = makeCtx([], { gated: true, room: roomWith(roomBit) })
      // base bns=4 → min(-4,-5) = -5
      expect(computeBns(caster(), makeOsp({ realm, bonusType: 2 }), ctx)).toBe(-5)
    }
  })

  it('큰 bns면 min(-bns,-5)이 -bns(더 음수)를 택한다', () => {
    const bigCaster = makeCaster({ intBonus: 10, realm: [0, 0, 0, 0] }) // base bns=10
    const { ctx } = makeCtx([], { gated: true, room: roomWith(RWATER) })
    // 물방+불 realm → min(-10,-5) = -10
    expect(computeBns(bigCaster, makeOsp({ realm: REALM.FIRE, bonusType: 2 }), ctx)).toBe(-10)
  })
})

// ── T5.4 / T5.5 applySpellDamage 데미지 순서 ─────────────────────────────────
describe('offensiveSpell — T5.5 데미지 순서 + T5.4 저항', () => {
  it('기본 creature 피해: dmg=max(1,dice), ledger=m, hp in-place 차감', () => {
    const caster = makeCaster()
    const target = makeCreatureTarget({ hpcur: 30 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 }) // dice = 7 + rolls
    const { ctx, ledger, creatureDeaths } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell(
      { caster, casterId: 'mob-1', target: toCombatant(target), ctx },
      osp,
    )

    expect(out.dmg).toBe(14) // 7+3+4
    expect(out.died).toBe(false)
    expect(target.hpcur).toBe(16) // 30-14 (원본 ref 차감)
    expect(ledger.get('mob-1')).toBe(14) // m=min(30,14)
    expect(creatureDeaths).toHaveLength(0)
  })

  it('max(1) floor: pdice+bns 음수여도 최소 1 (저항 前 clamp)', () => {
    // gated + RFIRER 방 + WATER realm → 반대속성 → bns=min(-0,-5)=-5(realm=0 caster).
    const caster = makeCaster({ intBonus: 0, realm: [0, 0, 0, 0] })
    const osp = makeOsp({ realm: REALM.WATER, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 })
    const target = makeCreatureTarget({ hpcur: 30 })
    const { ctx } = makeCtx([1], { gated: true, room: roomWith(RFIRER) })

    const out = offensiveSpell(
      { caster, casterId: 'mob-1', target: toCombatant(target), ctx },
      osp,
    )
    // dice = 0 + (-5) + 1 = -4 → max(1)=1
    expect(out.dmg).toBe(1)
    expect(target.hpcur).toBe(29)
  })

  it('마법저항(creature MRMAGI): dmg -= trunc(dmg*2*min(50,piety+int)/100), 25→50%', () => {
    const caster = makeCaster()
    const target = makeCreatureTarget({ hpcur: 30, flags: F_SET(ZERO16, MRMAGI), piety: 15, intelligence: 10 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 })
    const { ctx, ledger } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    // dmg=14; piety+int=25 → 14 - trunc(14*2*25/100)=14-trunc(7.0)=14-7=7
    expect(out.dmg).toBe(7)
    expect(target.hpcur).toBe(23) // 30-7
    expect(ledger.get('mob-1')).toBe(7) // m=min(30,7) 저항 後
  })

  it('마법저항 완전무효(piety+int>=50, min(50) cap): dmg=0, hp 불변, ledger 0', () => {
    const caster = makeCaster()
    const target = makeCreatureTarget({ hpcur: 30, flags: F_SET(ZERO16, MRMAGI), piety: 40, intelligence: 20 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 })
    const { ctx, ledger, creatureDeaths } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    // min(50,60)=50 → dmg -= trunc(14*2*50/100)=14 → 0. 재-clamp 금지(0 보존).
    expect(out.dmg).toBe(0)
    expect(out.died).toBe(false)
    expect(target.hpcur).toBe(30)
    expect(ledger.get('mob-1')).toBe(0)
    expect(creatureDeaths).toHaveLength(0)
  })

  it('kill: m=min(hpBefore,dmg) 오버킬 캡(차감 前), death seam 정확히 1회', () => {
    const caster = makeCaster()
    const target = makeCreatureTarget({ hpcur: 5 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 }) // dmg=14 > hp=5
    const { ctx, ledger, creatureDeaths, playerDeaths } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)

    expect(out.dmg).toBe(14)
    expect(out.died).toBe(true)
    expect(target.hpcur).toBe(-9) // 5-14
    expect(ledger.get('mob-1')).toBe(5) // m=min(5,14) 오버킬 캡
    expect(creatureDeaths).toHaveLength(1)
    expect(creatureDeaths[0]?.[0]).toBe(target)
    expect(playerDeaths).toHaveLength(0)
  })

  it('player 대상: 저항 미발동·ledger 미누적, firePlayerDeath로 사망 1회', () => {
    const caster = makeCaster()
    const target = makePlayerTarget({ hpCurrent: 3 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 }) // dmg=14 > 3
    const { ctx, ledger, creatureDeaths, playerDeaths } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)

    expect(out.dmg).toBe(14)
    expect(out.died).toBe(true)
    expect(target.hpCurrent).toBe(-11) // 3-14
    expect(ledger.size).toBe(0) // creature 대상만 누적 — player는 미누적
    expect(playerDeaths).toHaveLength(1)
    expect(creatureDeaths).toHaveLength(0)
  })

  it('이미 사망(hp<1) 대상: no-op 반환(death 재발화·ledger 누적 없음)', () => {
    const caster = makeCaster()
    const target = makeCreatureTarget({ hpcur: 0 })
    const osp = makeOsp({ ndice: 2, sdice: 5, pdice: 7 })
    const { ctx, ledger, creatureDeaths } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)

    expect(out.dmg).toBe(0)
    expect(out.died).toBe(false)
    expect(target.hpcur).toBe(0) // 불변
    expect(ledger.size).toBe(0)
    expect(creatureDeaths).toHaveLength(0)
  })
})

// ── T4.2 realm 숙련 성장 훅(PvE 한정) ────────────────────────────────────────
describe('offensiveSpell — T4.2 realm 성장 훅(magic1.c:1128)', () => {
  it('creature 대상: realmGrowth=MIN(trunc(m*exp/hpmax), exp)', () => {
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const target = makeCreatureTarget({ hpcur: 30, hpmax: 30, experience: 100 })
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 }) // dmg=14
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell(
      { caster, casterId: 'mob-1', target: toCombatant(target), ctx },
      osp,
    )
    // m=min(30,14)=14 → trunc(14*100/30)=46, min(46,100)=46.
    expect(out.realmGrowth).toBe(46)
    // 회귀 가드: 데미지·hp·death는 성장 훅에 영향받지 않는다.
    expect(out.dmg).toBe(14)
    expect(target.hpcur).toBe(16)
  })

  it('오버킬: 성장은 dmg가 아닌 m=min(hpBefore,dmg)을 쓴다', () => {
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const target = makeCreatureTarget({ hpcur: 5, hpmax: 30, experience: 100 })
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 }) // dmg=14 > hp=5
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    // m=min(5,14)=5 → trunc(5*100/30)=16 (dmg=14였다면 46). m 사용 증명.
    expect(out.realmGrowth).toBe(16)
    expect(out.died).toBe(true)
  })

  it('experience 미설정 몬스터: exp=0 폴백 → 성장 0', () => {
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const target = makeCreatureTarget({ hpcur: 30, hpmax: 30 }) // experience 미설정
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 })
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    expect(out.realmGrowth).toBe(0)
  })

  it('PLAYER 대상(PvP): realmGrowth=0(성장 없음)', () => {
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const target = makePlayerTarget({ hpCurrent: 30 })
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 })
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    expect(out.realmGrowth).toBe(0)
  })

  it('자기대상(player가 자신에게 시전 — 동일 PLAYER 가드): realmGrowth=0', () => {
    // 오라클 가드는 crt->type != PLAYER 하나뿐이다. 플레이어 자기대상은 target.kind='player'라
    // PvP와 동일 가드로 미성장한다(별도 caster-identity 체크 없음).
    const player = makePlayerTarget({ hpCurrent: 30 })
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 })
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell(
      { caster, casterId: 'char-1', target: toCombatant(player), ctx },
      osp,
    )
    expect(out.realmGrowth).toBe(0)
  })

  it('이미 사망(hp<1) no-op: realmGrowth=0', () => {
    const caster = makeCaster({ realm: [0, 0, 0, 0] })
    const target = makeCreatureTarget({ hpcur: 0, experience: 100 })
    const osp = makeOsp({ realm: REALM.FIRE, ndice: 2, sdice: 5, pdice: 7 })
    const { ctx } = makeCtx([3, 4], { gated: false })

    const out = offensiveSpell({ caster, casterId: 'mob-1', target: toCombatant(target), ctx }, osp)
    expect(out.realmGrowth).toBe(0)
    expect(out.dmg).toBe(0)
  })
})

// ── T5.6 디스패치 등록 ───────────────────────────────────────────────────────
describe('registerOffensiveSpells — offensive 20종 배선', () => {
  it('offensive 20 주문번호가 전부 핸들러로 해소된다', () => {
    const dispatch = new SpellDispatch<OffensiveSpellHandler>()
    registerOffensiveSpells(dispatch)
    for (const osp of OSPELL_GRID) {
      const handler = dispatch.resolve(osp.spellNo)
      expect(typeof handler).toBe('function')
    }
  })

  it('등록 핸들러가 offensiveSpell을 호출한다(해당 osp 캡처 — 피해 산출)', () => {
    const dispatch = new SpellDispatch<OffensiveSpellHandler>()
    registerOffensiveSpells(dispatch)
    // SHURTS(tier1 WIND 1d8+0). rolls=[6] → dmg=max(1,0+6)=6.
    const handler = dispatch.resolve(SPELL_NO.SHURTS) as OffensiveSpellHandler
    const target = makeCreatureTarget({ hpcur: 30 })
    const { ctx } = makeCtx([6], { gated: false })
    const out = handler({ caster: makeCaster(), casterId: 'mob-1', target: toCombatant(target), ctx })
    expect(out.dmg).toBe(6)
    expect(target.hpcur).toBe(24)
  })

  it('비-offensive 주문은 offensiveSpell 디스패처에서 미등록(undefined)으로 남는다', () => {
    const dispatch = new SpellDispatch<OffensiveSpellHandler>()
    registerOffensiveSpells(dispatch)
    // SVIGOR(회복)은 비-offensive → registerOffensiveSpells는 등록하지 않는다(effect 모듈 소관).
    expect(dispatch.resolve(SPELL_NO.SVIGOR)).toBeUndefined()
  })
})

// ── T5.6 offensive_spell 골든 fixture 소비 ───────────────────────────────────
interface OffensiveCaseInput {
  gated: boolean
  caster: { class: number; realm: number[]; intBonus: number }
  osp: { realm: number; ndice: number; sdice: number; pdice: number; bonusType: number }
  target: { kind: 'creature' | 'player'; hpcur: number; flags: string; piety: number; intelligence: number }
  roomFlags: number[]
  rolls: number[]
}

describe('체크인된 offensive_spell.json 골든 fixture', () => {
  // 크로스 패키지 읽기: fixture는 shared 소유, SUT offensiveSpell은 server 소유. approve의 SUT가
  // JSON 시나리오를 실 객체로 재구성해 offensiveSpell을 소비한다(spell_fail.json 선례).
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/offensive_spell.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('offensive_spell.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 offensiveSpell SUT로 전 케이스를 throw 없이 통과한다(피해·상성·저항·사망)', () => {
    // anti-tautology: fixture expected는 offensiveSpellFixture.ts의 magic1.c 독립 전사,
    // SUT offensiveSpell은 offensiveSpell.ts 구현. 두 전사가 diff되면 approve가 throw한다.
    const fixture = loadFixture()
    const casterId = 'mob-1'

    const sut = (input: unknown): unknown => {
      const inp = input as OffensiveCaseInput
      const osp = makeOsp(inp.osp)
      const room = makeRoom([...inp.roomFlags])
      const { ctx, ledger, creatureDeaths, playerDeaths } = makeCtx(inp.rolls, {
        gated: inp.gated,
        room,
      })
      const caster = makeCaster({
        class: inp.caster.class,
        realm: [...inp.caster.realm],
        intBonus: inp.caster.intBonus,
      })

      let target
      let readHp: () => number
      if (inp.target.kind === 'creature') {
        const c = makeCreatureTarget({
          hpcur: inp.target.hpcur,
          flags: inp.target.flags,
          piety: inp.target.piety,
          intelligence: inp.target.intelligence,
        })
        target = toCombatant(c)
        readHp = () => c.hpcur
      } else {
        const p = makePlayerTarget({ hpCurrent: inp.target.hpcur })
        target = toCombatant(p)
        readHp = () => p.hpCurrent
      }

      const out = offensiveSpell({ caster, casterId, target, ctx }, osp)
      return {
        dmg: out.dmg,
        finalHp: readHp(),
        died: out.died,
        ledgerAmount: ledger.get(casterId) ?? 0,
        deathFires: creatureDeaths.length + playerDeaths.length,
      }
    }

    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
