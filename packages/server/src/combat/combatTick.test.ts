import { describe, it, expect } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { createCombatTick, type CombatTickDeps, type CastSpellSeam } from './combatTick.js'
import { createCombatRegistry, type CombatRegistry } from './combatRegistry.js'
import type { PlayerCombatState } from './playerState.js'
import type { DamageLedger } from './enmity.js'
import { seqRng } from './dice.testutil.js'
import { F_SET, MMAGIC, MCHARM, PBLIND } from '../world/hexFlags.js'

/**
 * createCombatTick — 몬스터 근접 + 적 플레이어 반격을 조립하는 OnCombatTick 팩토리(update.c §1·§3,
 * 반격 command5.c). 모든 랜덤은 주입 seqRng(순서·개수 고정)로 결정화한다 — 시퀀스 초과 호출은
 * throw이므로 각 케이스의 굴림 예산이 계약으로 고정된다.
 *
 * 굴림 소비 순서: [MMAGIC 시전 굴림(있을 때)] → [몬스터 근접(hit+mdice)] → [반격 per player].
 *
 * 의도적 단순화(D7 / #91): 오라클의 target-last 반격 순서·죽어가는 target의 last 반격·"막타치면 생존"·
 * end-of-round 사망 지연은 이 슬라이스에서 미재현이다(Story 8 inline death 발화 위에 근사). 아래
 * 케이스들은 이 단순화된 동작을 계약으로 고정하며, 오라클 충실 라운드는 #91 후속 패치가 검증한다.
 */

const ZERO_FLAGS = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO_FLAGS)
}

/** class=4(fighter), effectiveStrength=10(bonusOf=0), 무기 1d6 proficiency=0로 산술을 투명하게 유지. */
function makePlayer(overrides: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'p1',
    hpCurrent: 50,
    mpCurrent: 0,
    level: 10,
    class: 4,
    effectiveStrength: 10,
    armor: 70,
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
    instanceId: 'm1',
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
    flags: '',
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

function makeRoom(occupantIds: readonly string[] = [], over: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 50,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
    ...over,
  }
}

type DeathCall = readonly [unknown, RoomNode, number]

interface DepsHarness {
  readonly deps: CombatTickDeps
  readonly registry: CombatRegistry
  readonly ledger: DamageLedger
  readonly creatureDeaths: DeathCall[]
  readonly playerDeaths: DeathCall[]
}

function makeDeps(
  values: readonly number[],
  opts: { now?: number; castSpell?: CastSpellSeam } = {},
): DepsHarness {
  const registry = createCombatRegistry()
  const ledger: DamageLedger = new Map<string, number>()
  const creatureDeaths: DeathCall[] = []
  const playerDeaths: DeathCall[] = []
  const now = opts.now ?? 1000
  const deps: CombatTickDeps = {
    rng: seqRng(values),
    registry,
    ledger,
    fireCreatureDeath: (dead, r, n) => {
      creatureDeaths.push([dead, r, n])
    },
    firePlayerDeath: (dead, r, n) => {
      playerDeaths.push([dead, r, n])
    },
    now: () => now,
    ...(opts.castSpell !== undefined ? { castSpell: opts.castSpell } : {}),
  }
  return { deps, registry, ledger, creatureDeaths, playerDeaths }
}

describe('createCombatTick — 팩토리 seam 계약', () => {
  it('deps를 클로저로 바인딩한 (creature, room)=>void 핸들러를 반환한다', () => {
    const { deps } = makeDeps([])
    const tick = createCombatTick(deps)
    expect(typeof tick).toBe('function')
    expect(tick.length).toBe(2)
  })
})

describe('createCombatTick — 적 경계(#83 aggro)', () => {
  it('enemies 빈 배열이면 no-op (굴림·death seam·ledger 불변)', () => {
    const creature = makeCreature({ enemies: [] })
    const room = makeRoom(['p1'])
    // seqRng([])는 어떤 굴림에도 throw — 근접/반격 진입 시 즉시 실패.
    const { deps, ledger, creatureDeaths, playerDeaths } = makeDeps([])

    const tick = createCombatTick(deps)
    expect(() => tick(creature, room)).not.toThrow()

    expect(creature.hpcur).toBe(100)
    expect(ledger.size).toBe(0)
    expect(creatureDeaths).toHaveLength(0)
    expect(playerDeaths).toHaveLength(0)
  })

  it('enemies는 있으나 방에 present 적이 없으면 no-op (도달 타깃 없음)', () => {
    const creature = makeCreature({ enemies: ['p1'] })
    const room = makeRoom([]) // p1이 방에 없음
    const { deps, ledger } = makeDeps([]) // 굴림 소비 시 throw

    const tick = createCombatTick(deps)
    expect(() => tick(creature, room)).not.toThrow()
    expect(ledger.size).toBe(0)
  })
})

describe('createCombatTick — 근접 + 반격', () => {
  it('present 적 근접 피격 + 쿨다운 도래 플레이어 반격', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접: hit=15(thr max(1,10-8)=2), mdice=5 → damage 5. 반격: hit=20(thr10), mdice=5, crit=50, fumble=50, dura=2 → 5
    const { deps, registry, ledger } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45) // 몬스터 근접
    expect(creature.hpcur).toBe(95) // 반격
    expect(ledger.get('p1')).toBe(5) // 반격 defender=몬스터
    expect(player.nextAttackAt).toBe(1001) // now+ATTACK_COOLDOWN_INTERVAL(1)
  })

  it('nextAttackAt > now인 플레이어는 반격 스킵 (근접만)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 5000 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접만: [15, 5]. 반격 진입 시 seqRng throw로 스킵 증명.
    const { deps, registry, ledger } = makeDeps([15, 5], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45)
    expect(creature.hpcur).toBe(100) // 반격 없음
    expect(ledger.size).toBe(0)
    expect(player.nextAttackAt).toBe(5000) // 불변
  })

  it('PBLIND 플레이어 반격 쿨다운은 now+6 (ATTACK_COOLDOWN_BLIND)', () => {
    const player = makePlayer({ characterId: 'p1', flags: flagsWith(PBLIND), nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 반격 hit thr = 10 + 5(PBLIND) = 15; hit=20>=15 ✓
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.nextAttackAt).toBe(1006) // now+6
  })

  it('방에는 있으나 레지스트리 미등록 id는 present 적에서 제외', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    // 'ghost'는 방에 있으나 레지스트리 미등록 → 해소 실패로 제외. p1이 target.
    const creature = makeCreature({ hpcur: 100, enemies: ['ghost', 'p1'] })
    const room = makeRoom(['ghost', 'p1'])
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player) // p1만 등록

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45) // p1이 근접·반격 대상
    expect(creature.hpcur).toBe(95)
  })

  it('몬스터 근접에 사망한 플레이어는 반격 불가 (의도적 단순화 — 오라클은 last 반격, D7/#91)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 3, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접 [15,5]: p1 3-5=-2 사망(firePlayerDeath). 반격 진입 시 hpCurrent<1 → continue(굴림 미소비).
    // NOTE: 오라클은 죽어가는 target도 last에 반격하고 막타치면 생존하나(#91), 여기서는 미재현이다.
    const { deps, registry, playerDeaths } = makeDeps([15, 5], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBeLessThan(1)
    expect(playerDeaths).toHaveLength(1) // resolveAttack이 발화
    expect(creature.hpcur).toBe(100) // 반격 없음
    expect(player.nextAttackAt).toBe(0) // 쿨다운 미설정
  })

  it("'첫 적' = enemies 중 첫 present 플레이어 (미해소 id는 건너뜀)", () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    // enemies[0]='ghost'는 방에 없음 → 다음 present 적 p1이 근접 target
    const creature = makeCreature({ hpcur: 100, enemies: ['ghost', 'p1'] })
    const room = makeRoom(['p1'])
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45) // p1이 근접 피격 대상
    expect(creature.hpcur).toBe(95)
  })
})

describe('createCombatTick — MMAGIC 주문 분기', () => {
  it("castSpell 'cast'면 근접 스킵하되 반격은 발생", () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: flagsWith(MMAGIC) })
    const room = makeRoom(['p1'])
    let castCalls = 0
    const castSpell: CastSpellSeam = () => {
      castCalls += 1
      return 'cast'
    }
    // MMAGIC 굴림=10(<=20 시전) → 근접 스킵. 반격: hit=20,mdice=5,crit=50,fumble=50,dura=2
    const { deps, registry } = makeDeps([10, 20, 5, 50, 50, 2], { now: 1000, castSpell })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(castCalls).toBe(1)
    expect(player.hpCurrent).toBe(50) // 근접 스킵 → 피해 없음
    expect(creature.hpcur).toBe(95) // 반격은 유지
  })

  it("castSpell 'none'이면 근접 진행", () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: flagsWith(MMAGIC) })
    const room = makeRoom(['p1'])
    const castSpell: CastSpellSeam = () => 'none'
    // MMAGIC=10(<=20 시전 시도) → 'none' → 근접 진행: hit=15,mdice=5 → 반격 [20,5,50,50,2]
    const { deps, registry } = makeDeps([10, 15, 5, 20, 5, 50, 50, 2], { now: 1000, castSpell })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45) // 근접 진행
    expect(creature.hpcur).toBe(95)
  })

  it('기본 seam(no-op)은 시전해도 근접 진행 (반환 none)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: flagsWith(MMAGIC) })
    const room = makeRoom(['p1'])
    // castSpell 미주입 → 기본 no-op. MMAGIC=10 시전 시도 → 'none' → 근접 진행.
    const { deps, registry } = makeDeps([10, 15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBe(45)
  })

  it('MMAGIC 굴림 > 20이면 castSpell 미호출 (근접 진행)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: flagsWith(MMAGIC) })
    const room = makeRoom(['p1'])
    let castCalls = 0
    const castSpell: CastSpellSeam = () => {
      castCalls += 1
      return 'cast'
    }
    // MMAGIC=50(>20 미시전) → 근접 진행: [50, 15, 5, 20, 5, 50, 50, 2]
    const { deps, registry } = makeDeps([50, 15, 5, 20, 5, 50, 50, 2], { now: 1000, castSpell })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(castCalls).toBe(0)
    expect(player.hpCurrent).toBe(45)
  })

  it('MMAGIC 없으면 castSpell 미호출 (굴림 미소비)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: '' })
    const room = makeRoom(['p1'])
    let castCalls = 0
    const castSpell: CastSpellSeam = () => {
      castCalls += 1
      return 'cast'
    }
    // MMAGIC 굴림 없음: 바로 근접 [15,5] + 반격 [20,5,50,50,2]
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000, castSpell })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(castCalls).toBe(0)
    expect(player.hpCurrent).toBe(45)
  })

  it('MMAGIC + MCHARM이면 시전 억제 (근접 진행, 굴림 미소비)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], flags: flagsWith(MMAGIC, MCHARM) })
    const room = makeRoom(['p1'])
    let castCalls = 0
    const castSpell: CastSpellSeam = () => {
      castCalls += 1
      return 'cast'
    }
    // MCHARM → MMAGIC 굴림 없음: 근접 [15,5] + 반격 [20,5,50,50,2]
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000, castSpell })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(castCalls).toBe(0)
    expect(player.hpCurrent).toBe(45)
  })
})

describe('createCombatTick — 케이던스 비소유(criterion 5)', () => {
  it('핸들러는 creature.nextActionAt을 읽거나 쓰지 않는다', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'], nextActionAt: 777 })
    const room = makeRoom(['p1'])
    const { deps, registry } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(creature.nextActionAt).toBe(777) // 불변 — 케이던스는 creatureTick 슬롯 소유
  })
})

describe('createCombatTick — death seam 1회 + break', () => {
  it('첫 반격이 몬스터를 죽이면 fireCreatureDeath 1회 + 둘째 반격 미발생', () => {
    const p1 = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const p2 = makePlayer({ characterId: 'p2', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 3, enemies: ['p1', 'p2'] })
    const room = makeRoom(['p1', 'p2'])
    // 근접 target=p1: [15,5]. p1 반격: hit=20,mdice=5(>=3 사망),crit=50,fumble=50,dura=2.
    // p2 반격 굴림은 시퀀스에 없음 → break 미준수 시 seqRng throw.
    const { deps, registry, creatureDeaths } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(p1)
    registry.register(p2)

    createCombatTick(deps)(creature, room)

    expect(creature.hpcur).toBeLessThan(1) // 사망
    expect(creatureDeaths).toHaveLength(1) // resolveAttack이 1회 발화, 핸들러는 추가 발화 안 함
    expect(p1.hpCurrent).toBe(45) // 근접 피격 대상
    expect(p2.hpCurrent).toBe(50) // 반격 전 break → 무피해
  })
})
