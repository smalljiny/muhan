import { describe, it, expect, vi } from 'vitest'
import type { Character, CreatureInstance, ObjectInstance } from 'shared'
import { assembleDeathSeams } from './assembleDeathSeams.js'
import { makeCreature, makeItem, makeRoom } from '../world/roomFixtures.testutil.js'
import { makeCharacter } from '../world/characterFixtures.testutil.js'
import { makeObjectInstance } from '../items/objectFixtures.testutil.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { buildSpawnTemplateIndex, createInstanceIdAllocator } from '../world/spawn.js'
import { createCreatureLedgers } from '../combat/creatureLedgers.js'
import { accumulateDamage } from '../combat/enmity.js'
import type { PlayerCombatState } from '../combat/playerState.js'

/**
 * 사망 seam 조립기 테스트.
 *
 * 이 조립기는 보상 산술을 소유하지 않는다 — 분배는 `distributeCreatureDeath`, 방 제거·리스폰
 * 타이머는 `onCreatureDeath`가 소유한다. 그래서 여기서 고정하는 것은 **연결 순서와 라이브 반영**이다:
 * 원장을 읽은 뒤에 버리는가, 기여자 경험치가 레지스트리에 실제로 남는가, 성향·전리품처럼 적용하지
 * 않기로 한 것이 새어 들어오지 않는가.
 *
 * 원장·레지스트리·크리처 사망 deps는 mock이 아니라 실제 구현을 쓴다(관측만 spy로 얹는다) — mock으로
 * 갈아끼우면 "원장을 먼저 버려도 통과하는" 테스트가 되어 순서 회귀를 못 잡는다.
 */

/** 사망 크리처 픽스처 — exp 100, hpmax 10이라 데미지 10이면 보상이 정확히 100이다. */
function makeDead(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return makeCreature('50:c0', '고정몹', {
    hpmax: 10,
    hpcur: 0,
    experience: 100,
    alignment: 0,
    ...overrides,
  })
}

function setup() {
  const liveRegistry = createLiveCharacterRegistry()
  const ledgers = createCreatureLedgers()
  const markCharacterDirty = vi.fn()
  const logger = { error: vi.fn() }
  const register = vi.spyOn(liveRegistry, 'register')
  const discard = vi.spyOn(ledgers, 'discard')

  const seams = assembleDeathSeams({
    liveRegistry,
    ledgers,
    markCharacterDirty,
    creatureDeathDeps: {
      templates: buildSpawnTemplateIndex([]),
      alloc: createInstanceIdAllocator(),
    },
    logger,
  })

  return { liveRegistry, ledgers, markCharacterDirty, logger, register, discard, seams }
}

/**
 * 라이브 엔트리를 등록한다. 인벤토리를 인자로 받는 것이 load-bearing이다 — 항상 빈 배열로 등록하면
 * 조립기가 교체 등록에서 인벤을 통째로 떨어뜨려도 테스트가 통과한다(그 회귀는 조용하고, 진입에서
 * 1회 적재한 인벤을 되돌릴 경로가 이 토픽에 없다).
 */
function place(
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>,
  character: Character,
  inventory: readonly ObjectInstance[] = [],
): void {
  liveRegistry.register({ character, inventory })
}

describe('assembleDeathSeams — fireCreatureDeath 경험치 적립', () => {
  it('단독 기여자에게 award.exp를 적립하고 register·markCharacterDirty를 각 1회 호출한다', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', experience: 30 }))
    ctx.register.mockClear() // 시드 등록은 계수에서 제외한다.

    const dead = makeDead({ enemies: ['char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10) // 전체 hpmax → exp 100 전액.

    ctx.seams.fireCreatureDeath(dead, room, 500)

    expect(ctx.liveRegistry.get('char-1')?.character.experience).toBe(130)
    expect(ctx.register).toHaveBeenCalledTimes(1)
    expect(ctx.markCharacterDirty).toHaveBeenCalledTimes(1)
    expect(ctx.markCharacterDirty).toHaveBeenCalledWith(
      'char-1',
      expect.objectContaining({ experience: 130 }),
    )
  })

  it('기여자 2명(그룹킬)에게 모두 적립한다', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', experience: 0 }))
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-2', name: '타이', experience: 0 }))

    const dead = makeDead({ enemies: ['char-1', 'char-2'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    const ledger = ctx.ledgers.for(dead.instanceId)
    accumulateDamage(ledger, 'char-1', 5)
    accumulateDamage(ledger, 'char-2', 5)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    // expdiv = 100*5/10 = 50, 그룹킬 보너스 exp/10 = 10 → 60(몬스터 exp 캡 100 미만).
    expect(ctx.liveRegistry.get('char-1')?.character.experience).toBe(60)
    expect(ctx.liveRegistry.get('char-2')?.character.experience).toBe(60)
    expect(ctx.markCharacterDirty).toHaveBeenCalledTimes(2)
  })

  it('미등록 기여자는 예외 없이 건너뛰고 등록된 기여자만 적립한다', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', experience: 0 }))

    const dead = makeDead({ enemies: ['char-gone', 'char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    const ledger = ctx.ledgers.for(dead.instanceId)
    accumulateDamage(ledger, 'char-gone', 5)
    accumulateDamage(ledger, 'char-1', 5)

    expect(() => ctx.seams.fireCreatureDeath(dead, room, 500)).not.toThrow()

    expect(ctx.liveRegistry.get('char-1')?.character.experience).toBe(60)
    expect(ctx.liveRegistry.has('char-gone')).toBe(false)
    expect(ctx.markCharacterDirty).toHaveBeenCalledTimes(1)
  })

  it('라이브 캐릭터를 in-place로 변형하지 않고 새 문서로 교체 등록한다', () => {
    const ctx = setup()
    const seed = makeCharacter({ _id: 'char-1', experience: 30 })
    place(ctx.liveRegistry, seed)

    const dead = makeDead({ enemies: ['char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    expect(seed.experience).toBe(30) // 원본 문서는 그대로다.
    expect(ctx.liveRegistry.get('char-1')?.character).not.toBe(seed)
  })
})

describe('assembleDeathSeams — fireCreatureDeath 방·원장 처리', () => {
  it('죽은 크리처를 room.creatures에서 제거한다', () => {
    const ctx = setup()
    const dead = makeDead({ enemies: [] })
    const survivor = makeCreature('50:c1', '살아있는몹')
    const room = makeRoom({ roomId: 50, creatures: [dead, survivor] })

    ctx.seams.fireCreatureDeath(dead, room, 500)

    expect(room.creatures).toEqual([survivor])
  })

  it('원장을 폐기해 이후 같은 instanceId 조회가 빈 원장이다', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1' }))
    const dead = makeDead({ enemies: ['char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    expect(ctx.discard).toHaveBeenCalledWith('50:c0')
    expect(ctx.ledgers.for('50:c0').size).toBe(0)
  })

  it('교체 등록이 기여자의 인벤토리를 보존한다', () => {
    // 조립기가 새 LiveCharacter를 만들어 register하므로 인벤을 옮기지 않으면 통째로 사라진다.
    // 진입에서 1회 적재한 인벤을 되돌릴 경로가 이 토픽에 없어 그 회귀는 조용하고 복구 불가다.
    const ctx = setup()
    const carried = makeObjectInstance({ _id: 'inv-1', objnum: 200 })
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', experience: 0 }), [carried])
    const dead = makeDead({ enemies: ['char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    const after = ctx.liveRegistry.get('char-1')
    expect(after?.character.experience).toBe(100) // 적립이 실제로 일어난 상태에서 확인한다.
    expect(after?.inventory).toEqual([carried])
  })

  it('원장을 폐기하기 전에 보상을 계산한다(순서 회귀 가드)', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', experience: 0 }))
    const dead = makeDead({ enemies: ['char-1'] })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    // 폐기가 먼저면 원장이 비어 기여자 자체가 사라지고 보상이 0이 된다. `> 0`이 아니라 정확값을
    // 단언한다 — 약한 단언은 순서가 아닌 다른 회귀(분배 비율 변화)를 통과시킨다.
    expect(ctx.liveRegistry.get('char-1')?.character.experience).toBe(100)
  })
})

describe('assembleDeathSeams — 적용하지 않는 결정(D7·D8)', () => {
  it('alignmentDelta를 적용하지 않는다 — 기여자 alignment가 사망 전후 동일하다(D7)', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1', alignment: 1 }))
    // alignment 10 → delta -2. 적용하면 1이 아닌 값이 된다.
    const dead = makeDead({ enemies: ['char-1'], alignment: 10 })
    const room = makeRoom({ roomId: 50, creatures: [dead] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    // 양성 전제 — 보상이 실제로 나온 상태여야 "alignment만 안 변했다"가 의미를 갖는다.
    // 이 줄이 없으면 상류가 깨져 awards가 비어도 아래 단언이 조용히 통과한다.
    expect(ctx.liveRegistry.get('char-1')?.character.experience).toBeGreaterThan(0)
    expect(ctx.liveRegistry.get('char-1')?.character.alignment).toBe(1)
  })

  it('drops를 방에 넣지 않는다 — room.items가 사망 전후 동일하다(D8)', () => {
    const ctx = setup()
    place(ctx.liveRegistry, makeCharacter({ _id: 'char-1' }))
    const loot = makeItem('50:o9', '녹슨 검')
    const dead = makeDead({ enemies: ['char-1'], gold: 500, inventory: [loot] })
    const floor = makeItem('50:o1', '돌멩이')
    const room = makeRoom({ roomId: 50, creatures: [dead], items: [floor] })
    accumulateDamage(ctx.ledgers.for(dead.instanceId), 'char-1', 10)

    ctx.seams.fireCreatureDeath(dead, room, 500)

    expect(room.items).toEqual([floor])
  })
})

describe('assembleDeathSeams — firePlayerDeath 스텁', () => {
  const player: PlayerCombatState = {
    characterId: 'char-1',
    hpCurrent: 0,
    mpCurrent: 3,
    level: 7,
    class: 4,
    effectiveStrength: 16,
    effectiveIntelligence: 10,
    armor: 5,
    thaco: 18,
    dexterity: 18,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    flags: '0'.repeat(16),
    alignment: 1,
    weapon: null,
    nextAttackAt: 0,
  }

  it('logger.error를 1회 남기고 레지스트리·방 상태를 바꾸지 않는다', () => {
    const ctx = setup()
    const seed = makeCharacter({ _id: 'char-1', experience: 30 })
    place(ctx.liveRegistry, seed)
    ctx.register.mockClear()
    const survivor = makeCreature('50:c1', '살아있는몹')
    const floor = makeItem('50:o1', '돌멩이')
    const room = makeRoom({ roomId: 50, creatures: [survivor], items: [floor] })

    ctx.seams.firePlayerDeath(player, room, 500)

    expect(ctx.logger.error).toHaveBeenCalledTimes(1)
    expect(ctx.register).not.toHaveBeenCalled()
    expect(ctx.markCharacterDirty).not.toHaveBeenCalled()
    expect(ctx.liveRegistry.get('char-1')?.character).toBe(seed)
    expect(room.creatures).toEqual([survivor])
    expect(room.items).toEqual([floor])
  })
})
