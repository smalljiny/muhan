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
 * 굴림 소비 순서: [MMAGIC 시전 굴림(있을 때)] → [몬스터 근접(hit+mdice)] → [반격 역순: OTHER 적들 먼저,
 * TARGET 마지막].
 *
 * 오라클 충실 라운드(#91, update.c:501~530): 반격은 counter 역순(OTHER enemies 먼저, TARGET last)이며,
 * attack_crt에 attacker-HP 가드가 없어 근접에 죽어가는 target도 마지막에 반격을 날린다. resolveAttack는
 * fire-free이므로 근접이 target을 HP<1로 떨어뜨려도 즉시 발화하지 않는다(pending). counter가 몬스터를
 * 죽이면 몬스터 death 1회 + target pending death 취소("막타치면 target 생존"), 몬스터 생존 시에만
 * end-of-round에서 target death를 발화한다. death seam은 이제 combatTick이 발화한다(resolveAttack 아님).
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
    effectiveIntelligence: 10,
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

  it('근접에 죽어가는 target도 last 반격한다 (오라클 충실 — attack_crt attacker-HP 가드 없음, #91)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 3, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접 [15,5]: p1 3-5=-2 (pending death, fire-free). 죽어가는 target p1이 last 반격 [20,5,50,50,2]:
    // creature 100-5=95. 몬스터 생존 → end-of-round에서 target death 1회 발화.
    const { deps, registry, playerDeaths, creatureDeaths, ledger } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBeLessThan(1) // 근접에 죽어감
    expect(creature.hpcur).toBe(95) // 죽어가는 target도 반격을 날림
    expect(ledger.get('p1')).toBe(5) // 반격 데미지 기록
    expect(playerDeaths).toHaveLength(1) // end-of-round target death 1회
    expect(creatureDeaths).toHaveLength(0) // 몬스터 생존
    expect(player.nextAttackAt).toBe(1001) // 반격했으므로 쿨다운 설정
  })

  it('막타 생존: 죽어가는 target이 last 반격으로 몬스터를 죽이면 target death 미발화 (end-of-round 취소, #91)', () => {
    const player = makePlayer({ characterId: 'p1', hpCurrent: 3, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: 3, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접 [15,5]: p1 3-5=-2 (pending). target p1 last 반격 [20,5,50,50,2]: creature 3-5=-2 사망 →
    // fireCreatureDeath 1회 + p1 pending death 취소(막타 생존, update.c goto crt_died→continue).
    const { deps, registry, playerDeaths, creatureDeaths } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(player.hpCurrent).toBeLessThan(1) // target HP는 dead 상태(막타로 살아남지만 HP<1)
    expect(creature.hpcur).toBeLessThan(1) // 몬스터 사망(막타)
    expect(creatureDeaths).toHaveLength(1) // 몬스터 death 1회
    expect(playerDeaths).toHaveLength(0) // ★ target death 미발화 — 막타 생존
  })

  it('stale-dead target(HP<1로 진입)은 end-of-round death를 재발화하지 않는다 (exactly-once, #91)', () => {
    // D2 사망 제거 유예로 이전 틱에 죽은 target이 방·레지스트리에 남아 재진입할 수 있다. 근접은
    // DEAD_DEFENDER_NOOP로 died=false라 meleeOutcome.died=false → end-of-round 재발화 없음. `meleeOutcome.died`
    // 대신 `target.hpCurrent<1`로 판정하면 여기서 cross-tick 중복 발화가 재유입되므로 이 케이스가 그 회귀 lock이다.
    const player = makePlayer({ characterId: 'p1', hpCurrent: -3, nextAttackAt: 0 }) // 이미 사망 상태로 진입
    const creature = makeCreature({ hpcur: 100, enemies: ['p1'] })
    const room = makeRoom(['p1'])
    // 근접: DEAD_DEFENDER_NOOP → 굴림 미소비. 죽어가는 target도 last 반격 [20,5,50,50,2] → monster 95.
    const { deps, registry, playerDeaths, creatureDeaths } = makeDeps([20, 5, 50, 50, 2], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(creature.hpcur).toBe(95) // stale-dead target도 반격은 날림(attacker-HP 가드 없음)
    expect(playerDeaths).toHaveLength(0) // ★ meleeOutcome.died=false → target death 재발화 없음
    expect(creatureDeaths).toHaveLength(0) // 몬스터 생존
  })

  it('stale-dead 몬스터(hpcur<1로 진입)는 counter 준비돼도 fireCreatureDeath 재발화 안 함 (exactly-once, #91)', () => {
    // 사망 제거가 #99로 유예돼(deathDistribution) creatureTick이 HP 가드 없이 due 크리처를 재디스패치할 수
    // 있다. 가드 없으면 counter가 DEAD_DEFENDER_NOOP(미발화)를 반환해도 이후 `creature.hpcur<1` 관찰이
    // 여전히 true라 fireCreatureDeath가 재발화된다 — stale-dead 진입 가드가 이 exactly-once 위반의 lock이다.
    const player = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 })
    const creature = makeCreature({ hpcur: -2, enemies: ['p1'] }) // 이전 틱 사망분이 미제거로 재진입
    const room = makeRoom(['p1'])
    // seq [15,5]는 가드 없을 때 근접이 소비하는 굴림. 가드가 있으면 조기 return으로 미소비(under-consume 무해).
    const { deps, registry, creatureDeaths, playerDeaths, ledger } = makeDeps([15, 5], { now: 1000 })
    registry.register(player)

    createCombatTick(deps)(creature, room)

    expect(creatureDeaths).toHaveLength(0) // ★ stale-dead 몬스터 death 재발화 없음
    expect(playerDeaths).toHaveLength(0)
    expect(creature.hpcur).toBe(-2) // 불변 — 근접·counter 미실행
    expect(player.hpCurrent).toBe(50) // 근접도 차단 — 무피해
    expect(ledger.size).toBe(0)
  })

  it('target-last 반격 순서: OTHER 적이 먼저·target이 마지막 (ledger로 순서 pin, #91)', () => {
    const p1 = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 }) // target(presentEnemies[0])
    const p2 = makePlayer({ characterId: 'p2', hpCurrent: 50, nextAttackAt: 0 }) // OTHER(presentEnemies[1])
    const creature = makeCreature({ hpcur: 100, armor: 0, enemies: ['p1', 'p2'] })
    const room = makeRoom(['p1', 'p2'])
    // 근접 target p1: [15,5] → p1 45. counter 역순: p2(OTHER) 먼저 [20,6,50,50,2]=dmg6, p1(TARGET)
    // 마지막 [20,3,50,50,2]=dmg3. 순서가 뒤집히면 ledger p2/p1이 3/6이 되어 실패.
    const { deps, registry, ledger, creatureDeaths, playerDeaths } = makeDeps(
      [15, 5, 20, 6, 50, 50, 2, 20, 3, 50, 50, 2],
      { now: 1000 },
    )
    registry.register(p1)
    registry.register(p2)

    createCombatTick(deps)(creature, room)

    expect(p1.hpCurrent).toBe(45) // 근접 피격 대상 = target
    expect(creature.hpcur).toBe(91) // 100 - 6(p2 먼저) - 3(p1 마지막)
    expect(ledger.get('p2')).toBe(6) // OTHER가 첫 counter 굴림 소비 → dmg 6
    expect(ledger.get('p1')).toBe(3) // TARGET이 마지막 counter 굴림 소비 → dmg 3
    expect(creatureDeaths).toHaveLength(0)
    expect(playerDeaths).toHaveLength(0)
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
  it('counter가 몬스터를 죽이면 combatTick이 fireCreatureDeath 1회 + 남은 counter 미발생', () => {
    const p1 = makePlayer({ characterId: 'p1', hpCurrent: 50, nextAttackAt: 0 }) // target
    const p2 = makePlayer({ characterId: 'p2', hpCurrent: 50, nextAttackAt: 0 }) // OTHER(먼저 반격)
    const creature = makeCreature({ hpcur: 3, enemies: ['p1', 'p2'] })
    const room = makeRoom(['p1', 'p2'])
    // 근접 target=p1: [15,5]. counter 역순 → OTHER p2 먼저: hit=20,mdice=5(>=3 사망),crit=50,fumble=50,dura=2.
    // 몬스터 사망 → death 1회 발화 + break. TARGET p1 counter 굴림은 시퀀스에 없음 → break 미준수 시 seqRng throw.
    const { deps, registry, creatureDeaths } = makeDeps([15, 5, 20, 5, 50, 50, 2], { now: 1000 })
    registry.register(p1)
    registry.register(p2)

    createCombatTick(deps)(creature, room)

    expect(creature.hpcur).toBeLessThan(1) // 사망
    expect(creatureDeaths).toHaveLength(1) // combatTick이 정확히 1회 발화(resolveAttack fire-free)
    expect(p1.hpCurrent).toBe(45) // 근접 피격 대상
    expect(p2.hpCurrent).toBe(50) // OTHER는 공격자라 무피해
    expect(p2.nextAttackAt).toBe(1001) // OTHER가 killing counter를 날림
    expect(p1.nextAttackAt).toBe(0) // TARGET은 last라 break로 반격 못 함
  })
})
