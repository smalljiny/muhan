import { describe, it, expect } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { resolveAttack, type ResolveContext } from './resolveAttack.js'
import { toCombatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'
import type { DamageLedger } from './enmity.js'
import { seqRng } from './dice.testutil.js'
import { F_SET, PUPDMG, OALCRT, OCURSE, MBEFUD } from '../world/hexFlags.js'

/**
 * resolveAttack — 명중→피해→크리/불발→적용 단일 파이프의 오라클 충실 이식(command5.c / update.c).
 *
 * 모든 랜덤은 주입 seqRng(순서 고정)로 결정화한다. seqRng는 시퀀스를 초과 호출하면 throw하므로,
 * 각 케이스의 정확한 굴림 순서·개수가 계약으로 고정된다(과호출=버그가 즉시 드러남).
 *
 * byte-fidelity 함정 pin:
 *   - 플레이어 정상타는 max(1,n)로 최소 1 피해(정상타 min-1), 그러나 불발은 0·혼동 몬스터는 0(예외 2종).
 *   - AttackOutcome.damage=적용 피해 n(비캡), ledger=min(hpBefore,n) 캡(오버킬 분리).
 *   - 크리 `mrand(1,100)`은 `||` 좌변이라 항상 굴림(OALCRT 자동크리에도 소비). 불발 굴림은 무기 있을 때만.
 */

const ZERO_FLAGS = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO_FLAGS)
}

/** class=4(fighter, mod_profic 나눗수 20), effectiveStrength=10(bonusOf=0)로 산술을 투명하게 유지한다. */
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
  readonly ctx: ResolveContext
  readonly ledger: DamageLedger
  readonly creatureDeaths: DeathCall[]
  readonly playerDeaths: DeathCall[]
}

function makeCtx(values: readonly number[], room: RoomNode = makeRoom(), now = 1000): CtxHarness {
  const ledger: DamageLedger = new Map<string, number>()
  const creatureDeaths: DeathCall[] = []
  const playerDeaths: DeathCall[] = []
  const ctx: ResolveContext = {
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
  }
  return { ctx, ledger, creatureDeaths, playerDeaths }
}

describe('resolveAttack — 플레이어 attacker 기본 파이프', () => {
  it('정상타: 명중→피해→비크리·비불발 (결정적 seed)', () => {
    const player = makePlayer()
    const creature = makeCreature({ hpcur: 30 })
    // seq: hit=20(>=thr10), mdice=5, crit=50(p=0 미크리), fumble=50, durability=2(≠0)
    const { ctx, ledger } = makeCtx([20, 5, 50, 50, 2])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.hit).toBe(true)
    expect(out.damage).toBe(5)
    expect(out.critical).toBe(false)
    expect(out.fumble).toBe(false)
    expect(out.died).toBe(false)
    expect(creature.hpcur).toBe(25) // in-place 차감
    expect(ledger.get('char-1')).toBe(5) // m=min(30,5)
    expect(out.messageInputs.attacks).toHaveLength(1)
    expect(out.messageInputs.attacks[0]?.durabilityHit).toBe(false)
  })

  it('빗나감: 피해 굴림 없이 damage 0 (hit 굴림만 소비)', () => {
    const player = makePlayer({ thaco: 25 }) // thr=25, hit=10 미달
    const creature = makeCreature({ hpcur: 30 })
    const { ctx, ledger } = makeCtx([10]) // 초과 굴림 시 seqRng throw

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.hit).toBe(false)
    expect(out.damage).toBe(0)
    expect(creature.hpcur).toBe(30)
    expect(ledger.size).toBe(0)
  })

  it('정상타 min-1: base<1이어도 max(1,n)로 최소 1 피해', () => {
    // effectiveStrength=0 → bonusOf=-4; mdice=1 → base=1-4=-3 → max(1)=1
    const player = makePlayer({ effectiveStrength: 0, weapon: { ndice: 1, sdice: 1, pdice: 0, adjustment: 0, proficiency: 0 } })
    const creature = makeCreature({ hpcur: 30 })
    const { ctx } = makeCtx([20, 1, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.damage).toBe(1)
    expect(creature.hpcur).toBe(29)
  })

  it('크리티컬: mrand(1,100)<=p면 n*=mrand(3,6)', () => {
    // proficiency=20, class=4(나눗수20) → p=1; base term trunc(20/10)=2
    const player = makePlayer({ weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 20 } })
    const creature = makeCreature({ hpcur: 100 })
    // seq: hit=20, mdice=4 → base=4+0+2=6, crit=1(<=1), mult=3 → 18, dura=1
    const { ctx } = makeCtx([20, 4, 1, 3, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.critical).toBe(true)
    expect(out.fumble).toBe(false)
    expect(out.damage).toBe(18)
    expect(creature.hpcur).toBe(82)
  })

  it('OALCRT 무기: 크리 굴림 실패해도 자동 크리티컬(굴림은 소비)', () => {
    const player = makePlayer({
      weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 0, flags: flagsWith(OALCRT) },
    })
    const creature = makeCreature({ hpcur: 100 })
    // seq: hit=20, mdice=4, crit=50(p=0 미달이나 OALCRT로 크리), mult=3 → 12, dura=1
    const { ctx } = makeCtx([20, 4, 50, 3, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.critical).toBe(true)
    expect(out.damage).toBe(12)
  })

  it('불발: mrand(1,100)<=(5-p) & 무기 & !OCURSE면 n=0·무기 낙하 (내구도 굴림 없음)', () => {
    const player = makePlayer({ weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 20 } })
    const creature = makeCreature({ hpcur: 30 })
    // p=1: crit=50(미크리), fumble=2(<=5-1=4) → 불발. 무기 낙하로 내구도 굴림 생략(seq에 없음)
    const { ctx, ledger } = makeCtx([20, 4, 50, 2])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.fumble).toBe(true)
    expect(out.damage).toBe(0)
    expect(out.messageInputs.attacks[0]?.weaponDropped).toBe(true)
    expect(creature.hpcur).toBe(30) // 0 피해
    expect(ledger.get('char-1')).toBe(0)
  })

  it('OCURSE 무기: 불발 굴림 통과해도 낙하 안 함(불발 미발동)', () => {
    const player = makePlayer({
      weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 0, flags: flagsWith(OCURSE) },
    })
    const creature = makeCreature({ hpcur: 30 })
    // p=0: crit=50, fumble=2(<=5) 하지만 OCURSE → 불발 안 함. n=4 유지. 내구도 굴림 발생
    const { ctx } = makeCtx([20, 4, 50, 2, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.fumble).toBe(false)
    expect(out.damage).toBe(4)
    expect(creature.hpcur).toBe(26)
  })

  it('PALADIN 정렬>250: max(1,n) 이후·크리 이전에 mrand(1,3) 보정', () => {
    const player = makePlayer({ class: 6, alignment: 300 }) // PALADIN, 나눗수25
    const creature = makeCreature({ hpcur: 30 })
    // seq: hit=20, mdice=4 → base=4, max(1)=4, align roll=2 → 6, crit=50(p=0), fumble=50, dura=1
    const { ctx } = makeCtx([20, 4, 2, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.damage).toBe(6)
    expect(creature.hpcur).toBe(24)
  })

  it('내구도 굴림 통과: mrand(0,3)===0면 durabilityHit=true', () => {
    const player = makePlayer()
    const creature = makeCreature({ hpcur: 30 })
    const { ctx } = makeCtx([20, 5, 50, 50, 0]) // dura=0

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks[0]?.durabilityHit).toBe(true)
  })

  it('맨손 플레이어: 크리 굴림만 소비하고 불발·내구도 굴림 없음(단락평가 계약)', () => {
    // class=4(fighter) selfDice ndice=1,sdice=5 → mdice=rng(1,5). weapon=null → p=0, autoCrit 없음.
    const player = makePlayer({ weapon: null })
    const creature = makeCreature({ hpcur: 30 })
    // seq 정확히 [hit=20, mdice=3, crit=50]: 불발/내구도 시도 시 seqRng throw
    const { ctx } = makeCtx([20, 3, 50])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.hit).toBe(true)
    expect(out.damage).toBe(3)
    expect(out.critical).toBe(false)
    expect(out.fumble).toBe(false)
    expect(out.messageInputs.attacks[0]?.durabilityHit).toBe(false)
    expect(out.messageInputs.attacks[0]?.weaponDropped).toBe(false)
    expect(creature.hpcur).toBe(27)
  })
})

describe('resolveAttack — 몬스터 attacker (단타·무크리)', () => {
  it('몬스터는 크리/불발/내구도 없이 단타 (hit+mdice 2굴림만)', () => {
    const monster = makeCreature({ instanceId: 'mon-1', thaco: 10, ndice: 1, sdice: 6, pdice: 0 })
    const player = makePlayer({ hpCurrent: 50, armor: 0 })
    // seq 정확히 [15,5]: crit/fumble/durability 시도 시 seqRng throw로 무크리 증명
    const { ctx, ledger } = makeCtx([15, 5])

    const out = resolveAttack(toCombatant(monster), toCombatant(player), ctx)

    expect(out.hit).toBe(true)
    expect(out.critical).toBe(false)
    expect(out.fumble).toBe(false)
    // n = mdice(5) − trunc((70−0)/5)=5−14=-9 → n<1 → n=1
    expect(out.damage).toBe(1)
    expect(player.hpCurrent).toBe(49)
    // defender가 플레이어면 ledger 미누적
    expect(ledger.size).toBe(0)
  })

  it('MBEFUD 약한 몬스터: monsterDamage 0을 파이프가 1로 되돌리지 않음(0 유지)', () => {
    const monster = makeCreature({ instanceId: 'mon-1', thaco: 10, flags: flagsWith(MBEFUD), ndice: 1, sdice: 6, pdice: 0 })
    const player = makePlayer({ hpCurrent: 50, armor: 0 })
    // mdice=2 → 2−14=-12 → n=1 → MBEFUD → trunc(1/3)=0
    const { ctx } = makeCtx([15, 2])

    const out = resolveAttack(toCombatant(monster), toCombatant(player), ctx)

    expect(out.damage).toBe(0)
    expect(player.hpCurrent).toBe(50)
  })

  it('몬스터가 몬스터를 타격하면 ledger에 instanceId로 누적', () => {
    const attacker = makeCreature({ instanceId: 'mon-A', thaco: 10, ndice: 1, sdice: 6, pdice: 0 })
    const defender = makeCreature({ instanceId: 'mon-B', armor: 70, hpcur: 30 })
    // armor=70 → trunc((70-70)/5)=0 → n=mdice=5
    const { ctx, ledger } = makeCtx([15, 5])

    const out = resolveAttack(toCombatant(attacker), toCombatant(defender), ctx)

    expect(out.damage).toBe(5)
    expect(ledger.get('mon-A')).toBe(5)
  })
})

describe('resolveAttack — 사망 감지·seam 발화', () => {
  it('몬스터 defender 사망: died=true + fireCreatureDeath 정확히 1회', () => {
    const player = makePlayer()
    const creature = makeCreature({ hpcur: 3 })
    const room = makeRoom({ creatures: [creature] })
    const { ctx, ledger, creatureDeaths, playerDeaths } = makeCtx([20, 5, 50, 50, 1], room, 2000)

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.died).toBe(true)
    expect(out.damage).toBe(5) // 비캡 n
    expect(ledger.get('char-1')).toBe(3) // m=min(3,5) 오버킬 캡
    expect(creatureDeaths).toHaveLength(1)
    expect(playerDeaths).toHaveLength(0)
    // seam은 (dead, room, now)를 인자로 받는다(사전 바인딩 금지)
    expect(creatureDeaths[0]?.[0]).toBe(creature)
    expect(creatureDeaths[0]?.[1]).toBe(room)
    expect(creatureDeaths[0]?.[2]).toBe(2000)
  })

  it('플레이어 defender 사망: died=true + firePlayerDeath 정확히 1회 (ledger 미누적)', () => {
    const monster = makeCreature({ instanceId: 'mon-1', thaco: 10, ndice: 1, sdice: 6, pdice: 0 })
    const player = makePlayer({ hpCurrent: 1, armor: 70 })
    const room = makeRoom()
    // armor=70 → n=mdice=5; hpCurrent 1-5=-4 <1 → 사망
    const { ctx, ledger, creatureDeaths, playerDeaths } = makeCtx([15, 5], room, 3000)

    const out = resolveAttack(toCombatant(monster), toCombatant(player), ctx)

    expect(out.died).toBe(true)
    expect(playerDeaths).toHaveLength(1)
    expect(creatureDeaths).toHaveLength(0)
    expect(ledger.size).toBe(0)
    expect(playerDeaths[0]?.[0]).toBe(player)
    expect(playerDeaths[0]?.[2]).toBe(3000)
  })
})

describe('resolveAttack — 다중공격(초인 PUPDMG count 루프)', () => {
  it('PUPDMG + class>INVINCIBLE + 굴림 조건이면 count>1로 각 타격 독립 굴림', () => {
    const player = makePlayer({ class: 11, level: 107, flags: flagsWith(PUPDMG) })
    const creature = makeCreature({ hpcur: 30 })
    // count: rng(0,3)=2 → trunc((107-97)/10)=1, 1+2=3>2 → count++ (=2)
    //        class>INVINCIBLE rng(1,4)=2 ≠1 → 증가 없음 (count=2)
    // 공격1: hit=20, mdice=3, crit=50, fumble=50, dura=1 → n=3
    // 공격2: hit=20, mdice=4, crit=50, fumble=50, dura=1 → n=4
    const { ctx, ledger } = makeCtx([2, 2, 20, 3, 50, 50, 1, 20, 4, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks).toHaveLength(2)
    expect(out.hit).toBe(true)
    expect(out.damage).toBe(7) // 3+4
    expect(out.critical).toBe(false)
    expect(creature.hpcur).toBe(23)
    expect(ledger.get('char-1')).toBe(7)
  })

  it('INVINCIBLE(class=9) & level>100 분기: 첫 count 증가 (rng(1,4) 미소비)', () => {
    const player = makePlayer({ class: 9, level: 101, flags: flagsWith(PUPDMG) })
    const creature = makeCreature({ hpcur: 30 })
    // count: rng(0,3)=3 → trunc((101-97)/10)=0, 0+3>2 → count++ (=2)
    //        class>INVINCIBLE? 9>9 거짓 → rng(1,4) 미소비
    // 공격1: hit=20,mdice=3,crit=50,fumble=50,dura=1 → 3; 공격2: hit=20,mdice=4,...,→ 4
    const { ctx } = makeCtx([3, 20, 3, 50, 50, 1, 20, 4, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks).toHaveLength(2)
    expect(out.damage).toBe(7)
  })

  it('두 번째 count 증가: class>INVINCIBLE & rng(1,4)===1 (첫 분기 미증가)', () => {
    const player = makePlayer({ class: 11, level: 100, flags: flagsWith(PUPDMG) })
    const creature = makeCreature({ hpcur: 30 })
    // count: rng(0,3)=0 → trunc((100-97)/10)=0, 0+0>2 거짓 → 미증가
    //        class>INVINCIBLE & rng(1,4)=1 → count++ (=2)
    const { ctx } = makeCtx([0, 1, 20, 3, 50, 50, 1, 20, 4, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks).toHaveLength(2)
    expect(out.damage).toBe(7)
  })

  it('비PUPDMG는 class>INVINCIBLE라도 count=1 (count 굴림 미소비)', () => {
    const player = makePlayer({ class: 11, level: 107 }) // PUPDMG 없음
    const creature = makeCreature({ hpcur: 30 })
    // count 굴림 없이 바로 공격 굴림. 잘못 소비하면 값 어긋나 실패
    const { ctx } = makeCtx([20, 3, 50, 50, 1])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks).toHaveLength(1)
    expect(out.damage).toBe(3)
  })

  it('death 발화 후 남은 count 타격은 실행되지 않는다(break)', () => {
    const player = makePlayer({ class: 11, level: 107, flags: flagsWith(PUPDMG) })
    const creature = makeCreature({ hpcur: 3 })
    const room = makeRoom({ creatures: [creature] })
    // count=2이지만 공격1이 사망시킴. 공격2 굴림은 seq에 없음 → 시도 시 seqRng throw
    const { ctx, creatureDeaths } = makeCtx([2, 2, 20, 5, 50, 50, 1], room)

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.messageInputs.attacks).toHaveLength(1)
    expect(out.died).toBe(true)
    expect(creatureDeaths).toHaveLength(1)
  })
})

describe('resolveAttack — 이미 사망한 defender 진입 가드(stale/재진입 방어)', () => {
  it('HP<1 크리처 defender: 굴림·피해·death seam·ledger 없이 no-op', () => {
    const player = makePlayer()
    const creature = makeCreature({ hpcur: -2, enemies: ['char-1'] }) // 이전 오버킬로 음수 HP
    // seqRng([]) — 어떤 굴림이든 시도하면 throw. 가드가 굴림 전에 차단해야 통과.
    const { ctx, ledger, creatureDeaths } = makeCtx([])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.hit).toBe(false)
    expect(out.died).toBe(false)
    expect(out.damage).toBe(0)
    expect(out.messageInputs.attacks).toHaveLength(0)
    expect(creature.hpcur).toBe(-2) // 추가 차감 없음
    expect(creatureDeaths).toHaveLength(0) // death seam 재발화 없음
    expect(ledger.size).toBe(0) // 음수 ledger 누적 없음
  })

  it('HP<1 플레이어 defender: firePlayerDeath 재발화 없이 no-op', () => {
    const attacker = makeCreature()
    const deadPlayer = makePlayer({ characterId: 'p-dead', hpCurrent: -1 })
    const { ctx, playerDeaths } = makeCtx([])

    const out = resolveAttack(toCombatant(attacker), toCombatant(deadPlayer), ctx)

    expect(out.hit).toBe(false)
    expect(out.died).toBe(false)
    expect(deadPlayer.hpCurrent).toBe(-1)
    expect(playerDeaths).toHaveLength(0)
  })

  it('HP 정확히 1인 defender는 가드를 통과해 정상 처리된다(경계값)', () => {
    const player = makePlayer()
    const creature = makeCreature({ hpcur: 1 })
    // 가드는 HP<1만 차단. HP=1은 통과 → hit=20,mdice=5,crit=50,fumble=50,durability=2 → 1-5=-4 사망
    const { ctx, creatureDeaths } = makeCtx([20, 5, 50, 50, 2])

    const out = resolveAttack(toCombatant(player), toCombatant(creature), ctx)

    expect(out.hit).toBe(true)
    expect(out.died).toBe(true)
    expect(creatureDeaths).toHaveLength(1)
  })
})
