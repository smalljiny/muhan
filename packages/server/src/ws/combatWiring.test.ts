import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Character, CreatureInstance, RoomNode, ServerEvent } from 'shared'
import type { CombatRng } from '../combat/dice.js'
import type { TickAwardCollector } from './tickAwardCollector.js'
import type { OnCombatTick } from '../world/creatureTick.js'

// 아래 세 mock은 `.harness/rules/testing.md` "비즈니스 로직 mock 금지"의 문서화된 예외다
// (resolverIdentity.test.ts 관례). 셋 다 실제 구현으로 위임하는 pass-through라 기존 테스트의 동작은 같다.
//
// - `defaultCombatRng`: wiring이 굴림 seam을 하드코딩하므로(D4 — 묶음에 rng seam을 뚫지 않는다) 결정적
//   라운드가 필요한 테스트만 `rngControl.impl`을 꽂는다. 비어 있으면 실 rng에 위임한다.
// - `createTickAwardCollector`: 수집기는 wiring 내부 인스턴스라 `finally` 해제를 관찰할 창구가 없다.
//   생성된 인스턴스를 잡아 두기만 한다(동작 불변).
// - `assembleDeathSeams`: 조립 횟수 관찰용 pass-through spy, 동작 불변.
const rngControl = vi.hoisted(() => ({ impl: null as CombatRng | null }))
const collectorSpy = vi.hoisted(() => ({ instances: [] as TickAwardCollector[] }))

vi.mock('../combat/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../combat/dice.js')>()
  const defaultCombatRng: CombatRng = (min, max) =>
    (rngControl.impl ?? actual.defaultCombatRng)(min, max)
  return { ...actual, defaultCombatRng }
})

vi.mock('./tickAwardCollector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tickAwardCollector.js')>()
  return {
    ...actual,
    createTickAwardCollector: (): TickAwardCollector => {
      const collector = actual.createTickAwardCollector()
      collectorSpy.instances.push(collector)
      return collector
    },
  }
})

vi.mock('./assembleDeathSeams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assembleDeathSeams.js')>()
  return { ...actual, assembleDeathSeams: vi.fn(actual.assembleDeathSeams) }
})

import { assembleDeathSeams } from './assembleDeathSeams.js'
import { createAttackHandler } from './handlers/attack.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { createWorldRuntime } from '../world/worldRuntime.js'
import { makeCreature, makeRoom as makeRoomBase, flagsHex } from '../world/roomFixtures.testutil.js'
import { makeCharacter as makeCharacterFixture } from '../world/characterFixtures.testutil.js'
import { MSUMMO } from '../world/hexFlags.js'
import type { SpawnTemplate, SpawnTemplateIndex } from '../world/spawn.js'
import { createInstanceIdAllocator } from '../world/spawn.js'
import type { ObjectTemplateIndex } from '../items/objectTemplate.js'
import { assemblePlayerCombatState } from '../combat/assemblePlayerCombatState.js'
import { accumulateDamage } from '../combat/enmity.js'
import { defaultCombatRng } from '../combat/dice.js'
import { composeCharacterFlags } from '../character/flags.js'
import { createLiveWorldWiring, type LiveWorldWiringBundle } from './liveWorldWiring.js'
import { createCommandRegistry, dispatch } from './router.js'
import { createNoopChannelAdapter } from './noopChannelAdapter.js'
import { createPermissivePermissionAdapter } from './permissivePermissionAdapter.js'

/**
 * 전투 연결 테스트(Story 7) — `combatRegistry`를 세션 수명에 연결하고 `combat:attack`을 명령
 * 레지스트리에 등록하는 연결을 고정한다.
 *
 * 규칙 산술(명중·피해·보상 공식)은 각 규칙 모듈의 단위 테스트가 이미 담당한다. 여기서 검증하는 것은
 * **연결**뿐이다: (a) 월드 입장 시 전투상태가 등록되는가, (b) 세션 종료가 되쓰기→markDirty→release→
 * remove 순서를 지키는가, (c) 공유 인스턴스(원장·발급기·템플릿)가 갈라지지 않는가, (d) 명령이
 * 레지스트리에 실리는가.
 */

/** 하네스가 고정으로 쓰는 현재 절대 틱 — P-flag 합성 시점 seam의 값이다. */
const NOW_TICK = 7

/** 시드 캐릭터 — 공유 픽스처에 id·방만 얹는다(리터럴을 다시 적으면 schemaVersion이 또 갈린다). */
function makeCharacter(
  id: string,
  currentRoom: number,
  overrides: Partial<Character> = {},
): Character {
  return makeCharacterFixture({ _id: id, currentRoom, ...overrides })
}

function makeRoom(roomId: number, overrides: Partial<RoomNode> = {}): RoomNode {
  return makeRoomBase({ roomId, ...overrides })
}

/** 소환 대상 스폰 템플릿 — CreatureSource 필수 필드 + numwander. */
function makeSpawnTemplate(name: string): SpawnTemplate {
  return {
    name,
    level: 2,
    hpmax: 8,
    mpmax: 0,
    dexterity: 10,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 20,
    ndice: 1,
    sdice: 4,
    pdice: 0,
    flags: flagsHex(),
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 10,
    piety: 10,
    experience: 5,
    alignment: 0,
    keys: [],
    numwander: 1,
  }
}

type Harness = {
  bundle: LiveWorldWiringBundle
  worldGraph: Map<number, RoomNode>
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>
  markDirty: ReturnType<typeof vi.fn>
  onRoomLeft: ReturnType<typeof vi.fn>
  objectTemplates: ObjectTemplateIndex
  spawnTemplates: Map<number, SpawnTemplate>
}

function makeBundle(
  worldGraph: Map<number, RoomNode>,
  character: Character,
  overrides: Partial<LiveWorldWiringBundle> = {},
): Harness {
  const liveRegistry = createLiveCharacterRegistry()
  const markDirty = vi.fn()
  const onRoomLeft = vi.fn()
  const objectTemplates: ObjectTemplateIndex = new Map()
  const spawnTemplates = new Map<number, SpawnTemplate>()

  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: vi.fn(() => Promise.resolve(character)),
      hydrateInventory: vi.fn(() => Promise.resolve([])),
    },
    objectTemplates,
    spawnTemplates,
    alloc: createInstanceIdAllocator(worldGraph.values()),
    markDirty,
    peekPending: vi.fn((): unknown => undefined),
    currentHour: () => 12,
    now: () => NOW_TICK,
    onRoomEntered: vi.fn(),
    onRoomLeft,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
  return {
    bundle,
    worldGraph,
    liveRegistry,
    markDirty,
    onRoomLeft,
    objectTemplates,
    spawnTemplates,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createLiveWorldWiring — 전투상태 세션 수명 연결', () => {
  it('entry.place 직후 전투상태가 등록되고 캐릭터에서 파생된 값을 싣는다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })

    expect(wiring.combatRegistry.has('char-1')).toBe(true)
    const state = wiring.combatRegistry.get('char-1')
    expect(state).toBeDefined()
    // 캐릭터 파생 확인 — level은 문서 값 그대로, armor/thaco는 조립기가 캐릭터에서 파생한 값이다.
    const reference = assemblePlayerCombatState(
      { character, inventory: [] },
      h.objectTemplates,
      composeCharacterFlags(character, NOW_TICK),
    )
    expect(state?.level).toBe(character.level)
    expect(state?.armor).toBe(reference.armor)
    expect(state?.thaco).toBe(reference.thaco)
    expect(state?.hpCurrent).toBe(character.hpCurrent)
  })

  it('레벨이 다른 캐릭터는 다른 thaco로 등록된다(상수 하드코딩 방어)', () => {
    const lowRoom = makeRoom(4)
    const lowGraph = new Map<number, RoomNode>([[4, lowRoom]])
    const low = makeCharacter('char-low', 4, { level: 1 })
    const lowWiring = createLiveWorldWiring(makeBundle(lowGraph, low).bundle)
    lowWiring.liveWorldBinding.entry.place({ character: low, inventory: [] })

    const highRoom = makeRoom(4)
    const highGraph = new Map<number, RoomNode>([[4, highRoom]])
    const high = makeCharacter('char-high', 4, { level: 20 })
    const highWiring = createLiveWorldWiring(makeBundle(highGraph, high).bundle)
    highWiring.liveWorldBinding.entry.place({ character: high, inventory: [] })

    expect(lowWiring.combatRegistry.get('char-low')?.thaco).not.toBe(
      highWiring.combatRegistry.get('char-high')?.thaco,
    )
  })

  // 재접속은 `place`를 다시 부른다(hydrate가 등록된 엔트리를 그대로 반환 → enterCommand가 place 재호출).
  // `entryCore.place`는 멱등이라 조기 반환하는데, 래퍼가 무조건 새 상태를 덮으면 진행 중 전투가 초기화된다.
  it('재접속(place 재호출)이 진행 중 전투상태를 초기화하지 않는다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    const live = { character, inventory: [] }
    wiring.liveWorldBinding.entry.place(live)

    // 전투가 진행돼 hp가 깎이고 쿨다운이 걸린 상태를 만든다.
    const state = wiring.combatRegistry.get('char-1')
    expect(state).toBeDefined()
    if (state !== undefined) {
      state.hpCurrent = 5
      state.mpCurrent = 2
      state.nextAttackAt = 999
    }

    // 재접속 — 같은 엔트리로 place가 다시 불린다.
    wiring.liveWorldBinding.entry.place(live)

    const after = wiring.combatRegistry.get('char-1')
    expect(after?.hpCurrent).toBe(5)
    expect(after?.mpCurrent).toBe(2)
    // 이 값이 0으로 돌아가면 재접속으로 공격 쿨다운을 지울 수 있다.
    expect(after?.nextAttackAt).toBe(999)
  })

  it('세션 종료는 되쓰기 → markCharacterDirty → release → combatRegistry.remove 순서로 처리한다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })

    const order: string[] = []
    // 팩토리가 클로저로 Map을 소유하므로 this는 무의미하지만, 분리 참조를 lint가 막아 bind로 고정한다.
    const realGet = wiring.combatRegistry.get.bind(wiring.combatRegistry)
    vi.spyOn(wiring.combatRegistry, 'get').mockImplementation((id: string) => {
      order.push('combat.get')
      return realGet(id)
    })
    const realRemove = wiring.combatRegistry.remove.bind(wiring.combatRegistry)
    vi.spyOn(wiring.combatRegistry, 'remove').mockImplementation((id: string) => {
      order.push('combat.remove')
      realRemove(id)
    })
    h.markDirty.mockImplementation(() => order.push('markDirty'))
    // release는 occupants.delete → onRoomLeft → registry.remove 순서를 담당한다 — 훅이 실행 마커다.
    h.onRoomLeft.mockImplementation(() => order.push('release'))

    wiring.lifecyclePort.onSessionEnd({
      accountId: 'acct-1',
      characterId: 'char-1',
      reason: 'idleTimeout',
    })

    // 제거는 lifecyclePort가 아니라 조립 팩토리의 release 래퍼가 담당한다(place와 대칭) —
    // 그래서 release 훅 마커 뒤에 온다.
    expect(order).toEqual(['combat.get', 'markDirty', 'release', 'combat.remove'])
  })

  it('전투로 깎인 hp가 종료 시 markCharacterDirty 스냅샷에 실린다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })

    // 전투 resolver가 in-place로 차감하는 경로를 그대로 흉내낸다(라이브 가변 carve-out).
    const state = wiring.combatRegistry.get('char-1')
    expect(state).toBeDefined()
    if (state === undefined) return
    state.hpCurrent = 11
    state.mpCurrent = 3

    wiring.lifecyclePort.onSessionEnd({
      accountId: 'acct-1',
      characterId: 'char-1',
      reason: 'shutdown',
    })

    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ _id: 'char-1', hpCurrent: 11, mpCurrent: 3 }),
    )
    expect(wiring.combatRegistry.has('char-1')).toBe(false)
  })

  it('hp·mp 되쓰기는 하한 0으로 클램프한다(characterSchema min(0))', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })
    const state = wiring.combatRegistry.get('char-1')
    if (state === undefined) throw new Error('전투상태 미등록')
    state.hpCurrent = -9
    state.mpCurrent = -2

    wiring.lifecyclePort.onSessionEnd({
      accountId: 'acct-1',
      characterId: 'char-1',
      reason: 'graceExpired',
    })

    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ hpCurrent: 0, mpCurrent: 0 }),
    )
  })

  it('전투를 한 번도 하지 않아 등록 상태가 없으면 기존 종료 동작을 그대로 유지한다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    // place를 거치지 않고 레지스트리에만 등록한다(전투상태 미등록 상태 재현).
    h.liveRegistry.register({ character, inventory: [] })
    room.occupants.add('char-1')

    wiring.lifecyclePort.onSessionEnd({
      accountId: 'acct-1',
      characterId: 'char-1',
      reason: 'evictedByNewLogin',
    })

    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ hpCurrent: 42, mpCurrent: 15 }),
    )
    expect(h.liveRegistry.has('char-1')).toBe(false)
  })
})

describe('createLiveWorldWiring — attackDeps 파생', () => {
  it('attackDeps는 팩토리가 이미 만든 seam 인스턴스를 그대로 싣는다', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)

    expect(wiring.attackDeps.liveRegistry).toBe(h.liveRegistry)
    expect(wiring.attackDeps.combatRegistry).toBe(wiring.combatRegistry)
    expect(wiring.attackDeps.objectTemplates).toBe(h.objectTemplates)
    expect(wiring.attackDeps.resolveRoom).toBe(wiring.resolveRoom)
    expect(wiring.attackDeps.resolveRoomCreature).toBe(wiring.resolveRoomCreature)
    expect(wiring.attackDeps.resolveRoomPlayer).toBe(wiring.resolveRoomPlayer)
    expect(wiring.attackDeps.markCharacterDirty).toBe(wiring.markCharacterDirty)
    expect(wiring.attackDeps.resolveCharacterName).toBe(
      wiring.liveWorldBinding.resolveCharacterName,
    )
    expect(wiring.attackDeps.now).toBe(h.bundle.now)
    expect(wiring.attackDeps.rng).toBe(defaultCombatRng)
  })

  it('원장은 1회만 생성돼 공격 핸들러와 사망 seam이 같은 참조를 공유한다', () => {
    const dead = makeCreature('4:c0', '고블린', {
      experience: 100,
      hpmax: 10,
      hpcur: 0,
      enemies: ['char-1'],
    })
    const room = makeRoom(4, { creatures: [dead] })
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })

    // 공격 핸들러가 쓰는 원장에 누적한 데미지가, 사망 seam이 읽는 원장과 같아야 보상이 나온다.
    accumulateDamage(wiring.attackDeps.ledgers.for(dead.instanceId), 'char-1', 10)
    wiring.attackDeps.fireCreatureDeath(dead, room, NOW_TICK)

    expect(h.liveRegistry.get('char-1')?.character.experience).toBe(100)
  })

  it('사망 seam은 묶음의 alloc·spawnTemplates 인스턴스를 그대로 쓴다(instanceId 충돌 방지)', () => {
    const summonTemplateId = 42
    const dead = makeCreature('4:c0', '소환사', {
      flags: flagsHex(MSUMMO),
      special: summonTemplateId,
      enemies: [],
    })
    const room = makeRoom(4, { creatures: [dead] })
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)

    // index.ts boot와 같은 구성 — worldRuntime이 만든 발급기·템플릿을 묶음에 그대로 싣는다.
    const templates: SpawnTemplateIndex = new Map<number, SpawnTemplate>([
      [summonTemplateId, makeSpawnTemplate('부하')],
    ])
    const worldRuntime = createWorldRuntime(worldGraph, {
      now: () => NOW_TICK,
      templates,
      events: [],
    })
    const h = makeBundle(worldGraph, character, {
      alloc: worldRuntime.alloc,
      spawnTemplates: worldRuntime.templates,
    })

    const wiring = createLiveWorldWiring(h.bundle)

    // 공유 발급기라면 카운터가 이어진다: seed=1(pristine creatures.length) → 스폰이 1을 먹고 → 소환은 2.
    expect(worldRuntime.alloc.next(room)).toBe(1)
    wiring.attackDeps.fireCreatureDeath(dead, room, NOW_TICK)

    const summoned = room.creatures.find((c: CreatureInstance) => c.name === '부하')
    expect(summoned).toBeDefined()
    // instanceId 형식은 `${roomId}:c${idx}`다(creatureFactory).
    expect(summoned?.instanceId).toBe('4:c2')
  })
})

describe('createCommandRegistry — combat:attack 조건부 등록', () => {
  const actor = { accountId: 'acct-1', characterId: 'char-1' }
  const permission = createPermissivePermissionAdapter()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  function makeWiring() {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)
    return { wiring: createLiveWorldWiring(h.bundle), room, character, h }
  }

  it('attack deps를 주입하면 combat:attack이 레지스트리에 등록된다', () => {
    const { wiring } = makeWiring()
    const registry = createCommandRegistry(createNoopChannelAdapter(logger), {
      attack: wiring.attackDeps,
    })

    expect(registry.has('combat:attack')).toBe(true)
  })

  it('attack deps 미주입이면 combat:attack은 unknown_type으로 떨어진다', () => {
    const registry = createCommandRegistry(createNoopChannelAdapter(logger))

    const result = dispatch(
      registry,
      { type: 'combat:attack', target: '고블린' },
      actor,
      permission,
    )

    expect(result.outcome).toBe('rejected')
    expect(result.events[0]).toMatchObject({ type: 'error', code: 'unknown_type' })
  })
})

describe('createLiveWorldWiring — 몬스터 전투 tick 조립', () => {
  /** 항상 상한을 내는 굴림 — 명중 확정·최대 피해·크리/불발 미발생으로 라운드가 결정적이다. */
  const maxRng: CombatRng = (_min, max) => max

  /** 반격으로 죽지 않을 만큼 단단한 몬스터. experience=hpmax라 보상 = 원장 누적 피해(정수 버림 없음). */
  function makeTarget(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
    return makeCreature('4:c0', '고블린', {
      hpmax: 1000,
      hpcur: 1000,
      experience: 1000,
      ndice: 1,
      sdice: 4,
      enemies: ['char-1'],
      ...overrides,
    })
  }

  type Setup = {
    readonly wiring: ReturnType<typeof createLiveWorldWiring>
    readonly handler: OnCombatTick
    readonly bind: ReturnType<typeof vi.fn<(handler: OnCombatTick) => void>>
    readonly send: ReturnType<typeof vi.fn<(id: string, event: ServerEvent) => void>>
    readonly room: RoomNode
    readonly creature: CreatureInstance
    readonly character: Character
    readonly h: Harness
  }

  /** 묶음에 bind spy를 실어 조립하고 char-1을 배치한다. 꽂힌 핸들러를 돌려준다. */
  function setup(
    creature: CreatureInstance,
    bundleOverrides: Partial<LiveWorldWiringBundle> = {},
  ): Setup {
    const room = makeRoom(4, { creatures: [creature] })
    const worldGraph = new Map<number, RoomNode>([[4, room]])
    const character = makeCharacter('char-1', 4)
    const bind = vi.fn<(handler: OnCombatTick) => void>()
    const h = makeBundle(worldGraph, character, { bindCombatTick: bind, ...bundleOverrides })
    const send = vi.fn<(id: string, event: ServerEvent) => void>()
    const wiring = createLiveWorldWiring(h.bundle, { sendToCharacter: send })
    wiring.liveWorldBinding.entry.place({ character, inventory: [] })
    const handler = bind.mock.calls[0]?.[0]
    if (handler === undefined) throw new Error('bindCombatTick에 핸들러가 꽂히지 않았다')
    return { wiring, handler, bind, send, room, creature, character, h }
  }

  beforeEach(() => {
    rngControl.impl = maxRng
    collectorSpy.instances.length = 0
  })

  afterEach(() => {
    rngControl.impl = null
  })

  it('bindCombatTick이 핸들러 함수를 정확히 1회 받는다', () => {
    const { bind } = setup(makeTarget())

    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind.mock.calls[0]?.[0]).toBeTypeOf('function')
  })

  it('bindCombatTick 미주입 묶음도 throw 없이 조립된다', () => {
    const room = makeRoom(4)
    const h = makeBundle(new Map([[4, room]]), makeCharacter('char-1', 4))

    expect(() => createLiveWorldWiring(h.bundle, { sendToCharacter: vi.fn() })).not.toThrow()
  })

  it('transport와 bindCombatTick을 모두 생략한 부분 조립이 성공한다', () => {
    const room = makeRoom(4)
    const h = makeBundle(new Map([[4, room]]), makeCharacter('char-1', 4))

    const wiring = createLiveWorldWiring(h.bundle)

    expect(wiring.attackDeps).toBeDefined()
    expect(wiring.combatRegistry).toBeDefined()
  })

  it('꽂힌 핸들러의 라운드가 wiring.combatRegistry의 플레이어 hp를 바꾼다(같은 레지스트리)', () => {
    const { wiring, handler, room, creature, character } = setup(makeTarget())
    const hpBefore = wiring.combatRegistry.get('char-1')?.hpCurrent

    handler(creature, room)

    // maxRng: 몬스터 근접이 명중해 피해(최소 1)를 깎는다. 정확한 피해 산술은 attackStats 단위 테스트 몫이다.
    expect(hpBefore).toBe(character.hpCurrent)
    expect(wiring.combatRegistry.get('char-1')?.hpCurrent).toBeLessThan(character.hpCurrent)
  })

  it('반격 데미지가 공격 핸들러의 원장 라우터에 쌓여 이후 오프너 처치 보상에 합산된다', () => {
    const { wiring, handler, room, creature, h } = setup(makeTarget())
    // 오프너 처치자 — 몬스터의 적이 아니라 tick 반격에 참여하지 않는다.
    const opener = makeCharacter('char-2', 4, { name: '오프너' })
    wiring.liveWorldBinding.entry.place({ character: opener, inventory: [] })

    handler(creature, room)

    const counterDamage = wiring.attackDeps.ledgers.for(creature.instanceId).get('char-1') ?? 0
    expect(counterDamage).toBeGreaterThan(0)
    expect(creature.hpcur).toBe(1000 - counterDamage)

    // 오프너 한 방에 죽도록 hp를 낮춘다(같은 몬스터 객체 — 원장 키는 instanceId).
    creature.hpcur = 1
    const attack = createAttackHandler(wiring.attackDeps)
    attack(
      { type: 'combat:attack', target: '고블린' },
      { accountId: 'acct-2', characterId: 'char-2' },
    )

    expect(room.creatures).not.toContain(creature)
    // tick 반격만 한 char-1이 보상을 받는다 — 원장이 갈렸다면 char-1은 기여자가 아니라 0이다.
    // 보상 = expdiv(experience*damage/hpmax = 누적 피해) + 그룹킬 가산(기여자 2명 → experience/10).
    expect(h.liveRegistry.get('char-1')?.character.experience).toBe(counterDamage + 1000 / 10)
    expect(h.liveRegistry.get('char-2')?.character.experience).toBeGreaterThan(0)
  })

  it('사망 seam은 1회만 조립돼 반격 처치도 같은 seam(경험치 적립·수령자 통지)을 탄다', () => {
    const { handler, room, creature, h, send } = setup(makeTarget({ hpcur: 1 }))

    handler(creature, room)

    expect(vi.mocked(assembleDeathSeams)).toHaveBeenCalledTimes(1)
    expect(room.creatures).not.toContain(creature)
    const experience = h.liveRegistry.get('char-1')?.character.experience ?? 0
    expect(experience).toBeGreaterThan(0)
    expect(send).toHaveBeenCalledWith(
      'char-1',
      expect.objectContaining({ type: 'character:stats', experience }),
    )
  })

  it('combatTick이 throw해도 래퍼가 finally로 수집기를 끈다(다음 begin() 이전 시점)', () => {
    let nowThrows = false
    const now = (): number => {
      if (nowThrows) throw new Error('시계 실패')
      return NOW_TICK
    }
    const { wiring, handler, room, creature, h } = setup(makeTarget(), { now })
    expect(collectorSpy.instances).toHaveLength(1)
    const collector = collectorSpy.instances[0]
    if (collector === undefined) throw new Error('수집기 미생성')

    nowThrows = true
    expect(() => handler(creature, room)).toThrow('시계 실패')
    nowThrows = false

    // 다음 tick(begin()) 없이 오프너 경로로 사망 관찰자를 실행한다. 수집기가 켜진 채 남았다면 기록된다.
    accumulateDamage(wiring.attackDeps.ledgers.for(creature.instanceId), 'char-1', 10)
    wiring.attackDeps.fireCreatureDeath(creature, room, NOW_TICK)

    expect(h.liveRegistry.get('char-1')?.character.experience).toBeGreaterThan(0)
    expect(collector.current().size).toBe(0)
  })

  it('라운드 결과가 transport.sendToCharacter로 combat:round를 보낸다', () => {
    const { handler, room, creature, send } = setup(makeTarget())

    handler(creature, room)

    expect(send).toHaveBeenCalledWith('char-1', expect.objectContaining({ type: 'combat:round' }))
  })
})
