import { describe, it, expect } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { crtSpell, selectSpell, isSelfTargetSpell } from './crtSpell.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import type { ResolveContext } from '../combat/resolveAttack.js'
import type { CombatRng } from '../combat/dice.js'
import { F_SET, MMAGIC } from '../world/hexFlags.js'
import { MAGE } from '../combat/constants.js'
import { createCombatTick } from '../combat/combatTick.js'
import { createCombatRegistry } from '../combat/combatRegistry.js'
import { seqRng } from '../combat/dice.testutil.js'

/**
 * crtSpell — MMAGIC 몬스터의 시전 seam(update.c:654-701 crt_spell). CastSpellSeam 시그니처
 * `(caster, target, ctx) => 'cast'|'none'`를 직접 만족한다: 'cast'=근접 대체, 'none'=근접 진행.
 *
 * 오라클 대응(byte 확인, update.c:654-701 · magic1.c:820-841 offensive_spell CAST 게이트):
 *   - spells 16바이트를 비트 순서로 훑어 아는 주문 최대 10개 수집 → 한 번만 pick(재추첨 없음).
 *   - 빈 경우 spl=SHURTS(1)이나 몬스터가 SHURTS를 모르므로 knowledge 게이트가 항상 막는다 → 'none'.
 *   - offensive는 mana→class(tier5 MAGE 전용)→knowledge 게이트 후 시전 → 'cast'.
 *   - 비-offensive(치유 self 포함)는 #85 유예 → 'none'(근접 진행).
 */

// 주문번호 상수(mtype.h) — 테스트가 비트 위치·분기를 이름으로 참조한다.
const SVIGOR = 0
const SHURTS = 1
const SFIREB = 6
const SICEBL = 14
const SMENDW = 18
const SFHEAL = 19
const STHUND = 38

const ZERO_SPELLS = '0'.repeat(32)
/** 몬스터 M-flags(8바이트=16 hex chars) 빈 값 — MMAGIC 세팅 기준. */
const ZERO_FLAGS_HEX = '0000000000000000'

/** 지정 spellNo 비트만 세팅한 spells hex(16바이트=32 hex chars). */
function spellsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO_SPELLS)
}

/** (min,max) 인자를 기록하는 rng 스텁 — 시퀀스 소진 후엔 min 반환(호출 횟수/범위 관찰용). */
function spyRng(values: readonly number[]): { rng: CombatRng; calls: [number, number][] } {
  const calls: [number, number][] = []
  let i = 0
  const rng: CombatRng = (min, max) => {
    calls.push([min, max])
    return values[i++] ?? min
  }
  return { rng, calls }
}

/** 어떤 굴림에도 throw하는 rng — "rng 미소비"를 강제 검증한다. */
const throwingRng: CombatRng = (min, max) => {
  throw new Error(`rng는 호출되면 안 됨: (${min}, ${max})`)
}

function makeRoom(over: Partial<RoomNode> = {}): RoomNode {
  return {
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
    ...over,
  }
}

function makeCtx(rng: CombatRng, over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    rng,
    room: makeRoom(),
    now: 1000,
    fireCreatureDeath: () => {},
    firePlayerDeath: () => {},
    ledger: new Map<string, number>(),
    ...over,
  }
}

function makePlayer(over: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'p1',
    hpCurrent: 50,
    mpCurrent: 0,
    level: 10,
    class: 4,
    effectiveStrength: 10,
    effectiveIntelligence: 10,
    armor: 70,
    thaco: 10,
    dexterity: 12,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    flags: '',
    alignment: 1,
    weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 0 },
    nextAttackAt: 0,
    ...over,
  }
}

function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'm1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 100,
    hpcur: 100,
    mpmax: 30,
    mpcur: 30,
    dexterity: 12,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 10,
    ndice: 1,
    sdice: 6,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: ZERO_SPELLS,
    class: 0,
    intelligence: 10,
    piety: 0,
    flags: '',
    enemies: ['p1'],
    inventory: [],
    ...over,
  }
}

describe('selectSpell — 주문 선택(update.c:663-680)', () => {
  it('빈 spells면 SHURTS(1)로 폴백하며 rng를 호출하지 않는다', () => {
    // knowctr==0 → spl=1(오라클), 랜덤 pick 없음.
    expect(selectSpell(ZERO_SPELLS, throwingRng)).toBe(SHURTS)
  })

  it('아는 주문이 하나면 rng(1,1)로 그 주문을 pick한다', () => {
    const { rng, calls } = spyRng([1])
    expect(selectSpell(spellsWith(SFIREB), rng)).toBe(SFIREB)
    expect(calls).toEqual([[1, 1]]) // 한 번만 pick(재추첨 없음)
  })

  it('여러 주문 중 rng 인덱스로 pick한다(known[i-1])', () => {
    // 세팅 비트 = [SVIGOR(0), SHURTS(1), SFIREB(6)] 비트 순서. rng(1,3)=2 → known[1]=SHURTS.
    const { rng, calls } = spyRng([2])
    expect(selectSpell(spellsWith(SVIGOR, SHURTS, SFIREB), rng)).toBe(SHURTS)
    expect(calls).toEqual([[1, 3]])
  })

  it('아는 주문이 10개를 넘으면 처음 10개로 cap한다(known[10])', () => {
    // 비트 0..11(12개) 세팅 → cap 10 → rng(1,10). 11·12번째(bit 10,11)는 후보에서 제외.
    const { rng, calls } = spyRng([10])
    const spl = selectSpell(spellsWith(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), rng)
    expect(calls).toEqual([[1, 10]]) // 12가 아니라 10으로 cap
    expect(spl).toBe(9) // known[9] = 10번째 세팅 비트 = spellNo 9
  })
})

describe('isSelfTargetSpell — 대상 분기(update.c:681-687, cmnd.num 2 vs 3)', () => {
  it('치유 3종(SVIGOR·SMENDW·SFHEAL)은 self 대상이다', () => {
    expect(isSelfTargetSpell(SVIGOR)).toBe(true)
    expect(isSelfTargetSpell(SMENDW)).toBe(true)
    expect(isSelfTargetSpell(SFHEAL)).toBe(true)
  })

  it('나머지 주문은 공격자(target) 대상이다', () => {
    expect(isSelfTargetSpell(SHURTS)).toBe(false)
    expect(isSelfTargetSpell(SFIREB)).toBe(false)
    expect(isSelfTargetSpell(SICEBL)).toBe(false)
  })
})

describe('crtSpell — CastSpellSeam 어댑트', () => {
  it('offensive 주문을 게이트 통과 후 시전하면 target 피해 + 마나 소비 + "cast"', () => {
    // SHURTS(offensive tier1, mp=3) 보유·class0·mpcur=30 → rng(1,1)=1 pick, dmg 굴림 rng(1,8)=5.
    const creature = makeCreature({ spells: spellsWith(SHURTS), mpcur: 30, class: 0 })
    const target = makePlayer({ hpCurrent: 50 })
    const { rng } = spyRng([1, 5])

    const result = crtSpell(creature, target, makeCtx(rng))

    expect(result).toBe('cast')
    expect(target.hpCurrent).toBeLessThan(50) // 주문 피해 적용
    expect(creature.mpcur).toBe(27) // 30 - SHURTS.mp(3) 소비(게이트 통과 경로)
  })

  it('비-offensive(치유) 선택 시 "none" 폴백(근접 진행, #85 본체 미구현 경계)', () => {
    // SVIGOR(healing, self) 단독 보유 → pick SVIGOR → 비-offensive → 'none'. 피해·마나 불변.
    const creature = makeCreature({ spells: spellsWith(SVIGOR), mpcur: 30 })
    const target = makePlayer({ hpCurrent: 50 })
    const { rng } = spyRng([1])

    const result = crtSpell(creature, target, makeCtx(rng))

    expect(result).toBe('none')
    expect(target.hpCurrent).toBe(50)
    expect(creature.mpcur).toBe(30) // 비-offensive는 게이트 진입 없이 폴백 → 마나 미소비
  })

  it('빈 spells면 SHURTS 폴백이 knowledge 게이트에 막혀 "none"(오라클 magic1.c:839)', () => {
    // 빈 spells → spl=SHURTS이나 몬스터가 SHURTS 미보유 → knowledge 실패 → 'none'. 선택 rng 미소비.
    const creature = makeCreature({ spells: ZERO_SPELLS, mpcur: 30 })
    const target = makePlayer({ hpCurrent: 50 })

    const result = crtSpell(creature, target, makeCtx(throwingRng))

    expect(result).toBe('none')
    expect(target.hpCurrent).toBe(50)
    expect(creature.mpcur).toBe(30) // knowledge 실패 → 마나 미소비
  })

  it('시전 피해가 치명이면 death seam 1회 발화(cast→데미지→사망 end-to-end)', () => {
    // hp=1 플레이어에 SHURTS 시전 → 주문 피해로 사망 → firePlayerDeath 1회. crtSpell이 소유한
    // cast→데미지→사망 체인을 직접 검증한다(#82 death seam 재사용).
    const creature = makeCreature({ spells: spellsWith(SHURTS), mpcur: 30, class: 0 })
    const target = makePlayer({ hpCurrent: 1 })
    const deaths: PlayerCombatState[] = []
    const { rng } = spyRng([1, 5])
    const ctx = makeCtx(rng, { firePlayerDeath: (dead) => deaths.push(dead) })

    const result = crtSpell(creature, target, ctx)

    expect(result).toBe('cast')
    expect(target.hpCurrent).toBeLessThan(1) // 치명 피해
    expect(deaths).toHaveLength(1) // death seam 정확히 1회
    expect(deaths[0]).toBe(target)
  })

  it('마나 부족(mpcur < osp.mp)이면 "none"(마나 게이트 차단, 마나 미소비)', () => {
    // SHURTS.mp=3인데 mpcur=2 → mana 실패 → 'none'.
    const creature = makeCreature({ spells: spellsWith(SHURTS), mpcur: 2, class: 0 })
    const target = makePlayer({ hpCurrent: 50 })
    const { rng } = spyRng([1])

    const result = crtSpell(creature, target, makeCtx(rng))

    expect(result).toBe('none')
    expect(target.hpCurrent).toBe(50)
    expect(creature.mpcur).toBe(2)
  })
})

describe('crtSpell — tier5 MAGE 전용 게이트(A6 §3, 88 비-MAGE 몬스터 데이터 근거)', () => {
  it('tier5 주문(SICEBL)을 아는 비-MAGE 몬스터는 클래스 게이트에 막혀 "none"(마나 미소비)', () => {
    // 구리 용류(class0)가 SICEBL(14, tier5)를 알아도 offensive_spell class 게이트가 차단(magic1.c:900).
    const creature = makeCreature({ spells: spellsWith(SICEBL), mpcur: 30, class: 0 })
    const target = makePlayer({ hpCurrent: 50 })
    const { rng } = spyRng([1])

    const result = crtSpell(creature, target, makeCtx(rng))

    expect(result).toBe('none')
    expect(target.hpCurrent).toBe(50)
    expect(creature.mpcur).toBe(30) // 클래스 실패 → 마나 미소비(마나 게이트가 먼저 통과하나 미소비)
  })

  it('tier5 주문(STHUND)을 아는 MAGE 몬스터는 게이트 통과 후 시전 "cast"', () => {
    // STHUND(38, tier5, mp=25). MAGE(5) → 클래스 게이트 통과. dmg 굴림 4d5 → rng 4회.
    const creature = makeCreature({ spells: spellsWith(STHUND), mpcur: 30, class: MAGE })
    const target = makePlayer({ hpCurrent: 500 })
    const { rng } = spyRng([1, 5, 5, 5, 5])

    const result = crtSpell(creature, target, makeCtx(rng))

    expect(result).toBe('cast')
    expect(target.hpCurrent).toBeLessThan(500)
    expect(creature.mpcur).toBe(5) // 30 - STHUND.mp(25)
  })
})

describe('crtSpell — createCombatTick 주입 데모(T6.4, combatTick.ts 미변경)', () => {
  it('offensive 시전 성공 → 근접 스킵("cast"), 마나 소비 + 반격 없음(쿨다운 미도래)', () => {
    // MMAGIC 몬스터가 SHURTS를 알고 mpcur 충분 → crtSpell이 'cast' → doMelee=false.
    // player.nextAttackAt=5000으로 반격 굴림을 억제해 시퀀스를 [MMAGIC, pick, 주문dmg]로 고정.
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 5000 })
    const creature = makeCreature({
      spells: spellsWith(SHURTS),
      mpcur: 30,
      class: 0,
      flags: F_SET(ZERO_FLAGS_HEX, MMAGIC),
      enemies: ['p1'],
    })
    const room = makeRoom({ occupants: new Set(['p1']) })
    const registry = createCombatRegistry()
    registry.register(player)
    // [MMAGIC 시전 굴림=10(<=20), 선택 rng(1,1)=1, 주문 dmg rng(1,8)=5].
    const rng = seqRng([10, 1, 5])

    createCombatTick({
      rng,
      registry,
      ledger: new Map<string, number>(),
      fireCreatureDeath: () => {},
      firePlayerDeath: () => {},
      now: () => 1000,
      castSpell: crtSpell,
    })(creature, room)

    expect(creature.mpcur).toBe(27) // 시전 발생(30-3) 증거
    expect(player.hpCurrent).toBeLessThan(50) // 주문 피해
    expect(creature.hpcur).toBe(100) // 반격 없음(쿨다운 미도래)
  })

  it('게이트 실패(빈 spells) → "none" → 근접 진행', () => {
    // 빈 spells → SHURTS 폴백이 knowledge 게이트 차단 → 'none' → 근접 실행.
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 5000 })
    const creature = makeCreature({
      spells: ZERO_SPELLS,
      mpcur: 30,
      flags: F_SET(ZERO_FLAGS_HEX, MMAGIC),
      enemies: ['p1'],
    })
    const room = makeRoom({ occupants: new Set(['p1']) })
    const registry = createCombatRegistry()
    registry.register(player)
    // [MMAGIC=10, (선택 rng 없음: 빈 spells), 근접 hit=15, mdice=5].
    const rng = seqRng([10, 15, 5])

    createCombatTick({
      rng,
      registry,
      ledger: new Map<string, number>(),
      fireCreatureDeath: () => {},
      firePlayerDeath: () => {},
      now: () => 1000,
      castSpell: crtSpell,
    })(creature, room)

    expect(creature.mpcur).toBe(30) // 시전 없음(마나 미소비)
    expect(player.hpCurrent).toBe(45) // 근접 진행(50-5)
  })
})
