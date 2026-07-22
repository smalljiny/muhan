import { describe, it, expect } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { initiateAttack, type InitiateContext } from './initiateAttack.js'
import { toCombatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'
import type { DamageLedger } from './enmity.js'
import { seqRng } from './dice.testutil.js'
import { F_SET, MUNKIL, PCHAOS } from '../world/hexFlags.js'
import { setFlag } from '../world/door.js'
import { RNOKIL, RSUVIV } from '../world/moveGates.js'
import { PVP_COOLDOWN_INCREMENT } from './constants.js'

/**
 * initiateAttack — 플레이어 오프너의 오라클 충실 이식 검증(command5.c attack_crt 진입부 :146-209).
 *
 * 오프너 = 개시 게이트(Story 6) → resolveAttack 1회(Story 5/8) → 적대 등록(Story 7)의 순수 합성.
 * 게이트 실패 시 resolveAttack가 호출되지 않음을 seqRng([])로 pin한다(굴림 시도 시 즉시 throw).
 */

// resolveAttack.test.ts 하네스 재사용(로컬 헬퍼).
function makePlayer(overrides: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'char-1',
    hpCurrent: 50,
    mpCurrent: 0,
    level: 10,
    class: 4,
    effectiveStrength: 10,
    armor: 0,
    thaco: 10,
    dexterity: 12,
    flags: '',
    alignment: 1,
    weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 0 },
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

type DeathCall = readonly [unknown, RoomNode, number]

interface CtxHarness {
  readonly ctx: InitiateContext
  readonly ledger: DamageLedger
  readonly creatureDeaths: DeathCall[]
  readonly playerDeaths: DeathCall[]
}

function makeCtx(
  values: readonly number[],
  room: RoomNode = makeRoom(),
  checkWarResult = false,
  now = 1000,
): CtxHarness {
  const ledger: DamageLedger = new Map<string, number>()
  const creatureDeaths: DeathCall[] = []
  const playerDeaths: DeathCall[] = []
  const ctx: InitiateContext = {
    rng: seqRng(values),
    room,
    now,
    fireCreatureDeath: (dead, r, n) => {
      creatureDeaths.push([dead, r, n])
    },
    firePlayerDeath: (dead, r, n) => {
      playerDeaths.push([dead, r, n])
    },
    ledger,
    checkWarResult,
  }
  return { ctx, ledger, creatureDeaths, playerDeaths }
}

// 방 flags를 number[] + setFlag(door.ts)로 구성한다.
function roomWith(...bits: number[]): RoomNode {
  const flags: number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return makeRoom({ flags })
}

describe('initiateAttack — 게이트 거부(개시 차단)', () => {
  it('무적 게이트 거부: MUNKIL 크리처면 resolveAttack 미호출 + 부수효과 불변', () => {
    const attacker = toCombatant(makePlayer())
    const defender = makeCreature({ flags: F_SET('', MUNKIL) })
    // seqRng([]) — resolveAttack가 굴림을 시도하면 즉시 throw.
    const { ctx, ledger, creatureDeaths } = makeCtx([])

    const result = initiateAttack(attacker, toCombatant(defender), ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.reason).toBe('string')
    expect(defender.hpcur).toBe(30) // 피해 미적용
    expect(defender.enemies).toEqual([]) // 적대 미등록
    expect(ledger.size).toBe(0)
    expect(creatureDeaths).toHaveLength(0)
  })

  it('PvP 게이트 거부: RNOKIL 방이면 resolveAttack 미호출', () => {
    const attacker = toCombatant(makePlayer({ flags: F_SET('', PCHAOS), level: 1 }))
    const defenderState = makePlayer({ characterId: 'char-2', flags: F_SET('', PCHAOS) })
    const room = roomWith(RNOKIL)
    const { ctx } = makeCtx([], room)

    const result = initiateAttack(attacker, toCombatant(defenderState), ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.reason).toBe('string')
    expect(defenderState.hpCurrent).toBe(50) // 피해 미적용
  })
})

describe('initiateAttack — 게이트 통과(개시 성공)', () => {
  it('크리처 defender 통과: resolveAttack 1회 + 적대 등록 + cooldownIncrement 0', () => {
    const attacker = toCombatant(makePlayer())
    const defender = makeCreature({ hpcur: 30 })
    // seq: hit=20, mdice=5, crit=50(p=0 미크리), fumble=50, durability=2
    const { ctx, ledger } = makeCtx([20, 5, 50, 50, 2])

    const result = initiateAttack(attacker, toCombatant(defender), ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.hit).toBe(true)
    expect(result.outcome.damage).toBe(5)
    expect(result.cooldownIncrement).toBe(0)
    expect(defender.hpcur).toBe(25) // in-place 차감
    expect(defender.enemies).toContain('char-1') // 적대 등록
    expect(ledger.get('char-1')).toBe(5)
  })

  it('PvP defender 통과: resolveAttack 1회 + cooldownIncrement 3 + 적대 등록 생략', () => {
    const attacker = toCombatant(makePlayer({ flags: F_SET('', PCHAOS), level: 1 }))
    const defenderState = makePlayer({ characterId: 'char-2', hpCurrent: 50, flags: F_SET('', PCHAOS) })
    // 양측 PCHAOS·평범한 방 → PvP 게이트 통과. seq: hit=20, mdice=5, crit=50, fumble=50, durability=2
    const { ctx, ledger } = makeCtx([20, 5, 50, 50, 2])

    const result = initiateAttack(attacker, toCombatant(defenderState), ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.hit).toBe(true)
    expect(result.cooldownIncrement).toBe(PVP_COOLDOWN_INCREMENT)
    expect(defenderState.hpCurrent).toBe(45) // in-place 차감
    // 플레이어 defender엔 enemies[] 모델이 없어 적대 등록 생략 — ledger 미누적(defender=player).
    expect(ledger.size).toBe(0)
  })

  it('PvP defender 통과: RSUVIV 대련장에서도 개시된다', () => {
    const attacker = toCombatant(makePlayer({ flags: '', level: 1 }))
    const defenderState = makePlayer({ characterId: 'char-2', hpCurrent: 50, flags: '' })
    const room = roomWith(RSUVIV)
    const { ctx } = makeCtx([20, 5, 50, 50, 2], room)

    const result = initiateAttack(attacker, toCombatant(defenderState), ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cooldownIncrement).toBe(PVP_COOLDOWN_INCREMENT)
  })

  it('중복 등록 없음: 이미 적인 attacker면 enemies에 중복 추가 안 함', () => {
    const attacker = toCombatant(makePlayer())
    const defender = makeCreature({ hpcur: 30, enemies: ['char-1'] })
    const { ctx } = makeCtx([20, 5, 50, 50, 2])

    const result = initiateAttack(attacker, toCombatant(defender), ctx)

    expect(result.ok).toBe(true)
    expect(defender.enemies).toEqual(['char-1']) // 중복 없음
  })

  it('checkWarResult 미주입 시 기본 false로 PvP 게이트를 판정한다', () => {
    // 비-패거리 선한 공격자 → 기본 false로도 선악 게이트 거부(주입 없이 결정적).
    const attacker = toCombatant(makePlayer({ flags: '', level: 1 }))
    const defenderState = makePlayer({ characterId: 'char-2', flags: '' })
    const ledger: DamageLedger = new Map<string, number>()
    const ctx: InitiateContext = {
      rng: seqRng([]),
      room: makeRoom(),
      now: 1000,
      fireCreatureDeath: () => {},
      firePlayerDeath: () => {},
      ledger,
    }

    const result = initiateAttack(attacker, toCombatant(defenderState), ctx)

    expect(result.ok).toBe(false)
  })
})
