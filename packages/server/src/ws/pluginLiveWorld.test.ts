import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { neededExp, type Character, type RoomNode } from 'shared'
import { buildApp } from '../app.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { goldToTrain } from '../progression/train.js'
import { trainingFlagsForClass } from '../progression/train.testutil.js'
import { resetConfigForTests } from '../config/env.js'
import { SEED_ACCOUNT_ID, SEED_CHARACTER_ID } from '../auth/seedSessionAuth.testutil.js'
import type { ConnectionContext } from './connection.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import type { LiveWorldWiringBundle } from './liveWorldWiring.js'
import { createInstanceIdAllocator } from '../world/spawn.js'
import {
  buildSeededApp,
  injectAuthedWS,
  enterCommandState,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'

/**
 * plugin.ts 라이브 월드 결선(Story 7) — buildApp/registerWebsocket에 라이브 월드 의존 묶음이 주입되면
 * 채널·수명 포트가 묶음 파생 어댑터로 세워지고, 명시 포트가 함께 주어지면 명시 포트가 우선한다
 * (explicit > bundle-derived > noop, #2). wsLifecyclePort 데코레이션으로 어느 포트가 배선됐는지 관측한다.
 */
function makeCharacter(id: string, currentRoom: number): Character {
  return {
    _id: id,
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
  }
}

function makeRoom(roomId: number, occupantIds: readonly string[] = []): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [],
    occupants: new Set<string>(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

type BundleHarness = {
  bundle: LiveWorldWiringBundle
  markDirty: ReturnType<typeof vi.fn>
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>
  room: RoomNode
}

function makeBundle(): BundleHarness {
  const room = makeRoom(1, ['char-1'])
  const worldGraph = new Map<number, RoomNode>([[1, room]])
  const liveRegistry = createLiveCharacterRegistry()
  liveRegistry.register({ character: makeCharacter('char-1', 1), inventory: [] })
  const markDirty = vi.fn()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: vi.fn(() => Promise.resolve(null)),
      hydrateInventory: vi.fn(() => Promise.resolve([])),
    },
    objectTemplates: new Map(),
    // 사망 seam 원재료 — 이 하네스는 소환·리스폰 경로를 검증하지 않아 빈 인덱스와 신규 발급기를 싣는다.
    spawnTemplates: new Map(),
    alloc: createInstanceIdAllocator(),
    markDirty,
    peekPending: () => undefined,
    currentHour: () => 12,
    // P-flag 합성 시점 seam(#120 study 경로). 테스트는 고정 틱을 쓴다 — 만료 판정이 시간에 흔들리지 않게.
    now: () => 0,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  }
  return { bundle, markDirty, liveRegistry, room }
}

describe('registerWebsocket 라이브 월드 묶음 결선', () => {
  it('묶음 주입 시 wsLifecyclePort가 묶음 파생 라이브 수명 어댑터로 세워진다', async () => {
    const h = makeBundle()
    const app = buildApp({ liveWorldDeps: h.bundle })
    await app.ready()

    // 라이브 어댑터는 종료 시 최종 방을 담은 전체 문서를 markDirty한 뒤 release한다
    // (no-op 어댑터라면 markDirty가 없다).
    app.wsLifecyclePort.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'shutdown' })
    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ currentRoom: 1 }),
    )

    await app.close()
  })

  it('명시 lifecyclePort가 묶음보다 우선한다(explicit > bundle-derived, #2)', async () => {
    const h = makeBundle()
    const explicit: SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } = {
      onSessionEnd: vi.fn(),
    }
    const app = buildApp({ liveWorldDeps: h.bundle, lifecyclePort: explicit })
    await app.ready()

    app.wsLifecyclePort.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'shutdown' })
    // 명시 포트가 호출되고, 묶음 파생 어댑터(markDirty)는 관여하지 않는다.
    expect(explicit.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(h.markDirty).not.toHaveBeenCalled()

    await app.close()
  })

  it('묶음 미주입 시 wsLifecyclePort는 no-op 어댑터로 남는다(기존 동작 보존)', async () => {
    const app = buildApp()
    await app.ready()

    expect(typeof app.wsLifecyclePort.onSessionEnd).toBe('function')
    expect(() =>
      app.wsLifecyclePort.onSessionEnd({
        accountId: 'acc-1',
        characterId: 'char-x',
        reason: 'graceExpired',
      }),
    ).not.toThrow()

    await app.close()
  })
})

// ── evict된 옛 소켓의 라이브 명령 차단(신뢰 경계 회귀) ────────────────────────────────
// 같은 캐릭터 재로그인은 옛 바인딩을 evict하고 옛 소켓을 close한다. 그러나 `sock.close()`와 소켓
// 'close' 이벤트 사이에는 창이 있어(teardown은 ctx.state·ctx.boundCharacterId를 되돌리지 않고
// ctx.closed도 아직 false다), 그 사이 발화하는 버퍼된 프레임이 옛 ctx로 dispatch에 도달할 수 있다.
// liveRegistry는 characterId 키라 그 명령은 **새 세션의** 라이브 엔트리를 변이한다.
// 아래 스위트는 그 승계 명령이 라이브 상태를 전혀 건드리지 못함을 고정한다.

/** 훈련방 겸 출발 방. 연마(progress:train)와 이동(world:move)을 같은 방에서 순서대로 시도한다. */
const EVICT_ROOM_TRAIN = 11
/** 이동 도착 방. 승계 명령이 통과했다면 캐릭터가 이 방으로 옮겨진다. */
const EVICT_ROOM_DEST = 12
/** 연마 전 레벨. 정확히 1레벨분 exp·gold를 실어 승계 명령이 통과하면 결정적으로 상태가 바뀌게 한다. */
const EVICT_LEVEL = 7
const EVICT_EXP = neededExp(EVICT_LEVEL)
const EVICT_GOLD = goldToTrain(EVICT_LEVEL)
/** all-zero flags 출구 — 이동 게이트 건틀릿을 통과한다(liveWorld.e2e 픽스처 미러). */
const EVICT_EXIT = '동'

interface EvictHarness {
  bundle: LiveWorldWiringBundle
  markDirty: ReturnType<typeof vi.fn>
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>
  roomTrain: RoomNode
  roomDest: RoomNode
}

/**
 * 시드 계정·시드 캐릭터로 키를 맞춘 라이브 월드 묶음을 만든다(makeBundle과 별개 — 그쪽은 'char-1' 키에
 * findById가 null이라 실 세션 진입 경로를 태울 수 없다). 캐릭터는 라이브 레지스트리에 미리 등록하고
 * characterRepo에도 심는다 — 전자는 초기 상태 관측용, 후자는 hydrate 경로용이라 서로 대체하지 않는다.
 */
function makeEvictHarness(): EvictHarness {
  const character: Character = {
    ...makeCharacter(SEED_CHARACTER_ID, EVICT_ROOM_TRAIN),
    accountId: SEED_ACCOUNT_ID,
    level: EVICT_LEVEL,
    experience: EVICT_EXP,
    gold: EVICT_GOLD,
  }

  const roomTrain: RoomNode = {
    ...makeRoom(EVICT_ROOM_TRAIN),
    // 훈련방 flag는 픽스처 캐릭터의 class에서 **파생**한다 — 상수로 복제하면 makeCharacter의 class가 바뀔 때
    // train()이 class-mismatch로 조용히 거부되어, 가드가 없어도 통과하는 vacuous 테스트가 된다.
    // 훈련방 비트(RTRAIN=3 + class 서브매칭 4~6)는 이동 게이트가 읽는 방 비트(11·14·15·16·36)와 겹치지 않으므로,
    // 같은 방이 연마·이동 두 명령의 출발점이 될 수 있다.
    flags: trainingFlagsForClass(character.class),
    exits: [
      { name: EVICT_EXIT, targetRoomId: EVICT_ROOM_DEST, flags: [0, 0, 0, 0], key: 0, ltime: 0, interval: 60 },
    ],
  }
  const roomDest: RoomNode = { ...makeRoom(EVICT_ROOM_DEST), flags: [0, 0, 0, 0, 0, 0, 0, 0] }
  const worldGraph = new Map<number, RoomNode>([
    [EVICT_ROOM_TRAIN, roomTrain],
    [EVICT_ROOM_DEST, roomDest],
  ])

  const liveRegistry = createLiveCharacterRegistry()
  liveRegistry.register({ character, inventory: [] })

  const markDirty = vi.fn()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: vi.fn(() => Promise.resolve(character)),
      hydrateInventory: vi.fn(() => Promise.resolve([])),
    },
    objectTemplates: new Map(),
    // 사망 seam 원재료 — 이 하네스는 소환·리스폰 경로를 검증하지 않아 빈 인덱스와 신규 발급기를 싣는다.
    spawnTemplates: new Map(),
    alloc: createInstanceIdAllocator(),
    markDirty,
    peekPending: () => undefined,
    currentHour: () => 12, // 이동 시간 게이트 통과(밤 게이트 회피)
    // P-flag 합성 시점 seam(#120 study 경로). 테스트는 고정 틱을 쓴다 — 만료 판정이 시간에 흔들리지 않게.
    now: () => 0,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  }
  return { bundle, markDirty, liveRegistry, roomTrain, roomDest }
}

describe('evict된 소켓의 라이브 명령 차단', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    // 잔여 세션의 실 grace 타이머가 스위트를 붙잡지 않도록 넉넉히 잡고, 정리는 converge가 담당한다.
    process.env.WS_RECONNECT_GRACE_MS = '60000'
    resetConfigForTests()
  })

  afterEach(() => {
    process.env = savedEnv
    resetConfigForTests()
  })

  it('evict된 옛 소켓의 world:move·progress:train은 새 세션의 라이브 상태를 바꾸지 못한다', async () => {
    const h = makeEvictHarness()
    const app = buildSeededApp({ liveWorldDeps: h.bundle })
    await app.ready()

    // ── 1) 세션 A 진입(live 등록) ────────────────────────────────────────────────
    const ws1 = await injectAuthedWS(app)
    await enterCommandState(ws1)
    const bindingA = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(bindingA?.link).toBe('live')

    // 옛 ctx·소켓을 evict '전에' 캡처한다 — teardown의 cleanupConnection이 wsConnections에서 지우면
    // 이후에는 역참조할 방법이 없다.
    const ctxA = bindingA?.connection as ConnectionContext
    const entryA = [...app.wsConnections.entries()].find(([, c]) => c === ctxA)
    const sockA = entryA?.[0] as WebSocket
    expect(sockA).toBeDefined()

    // ── 2) 세션 B가 같은 캐릭터로 로그인 → A가 evictedByNewLogin으로 evict된다 ────────
    const ws2 = await injectAuthedWS(app)
    await enterCommandState(ws2)

    const bindingB = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(bindingB?.link).toBe('live')
    expect(bindingB).not.toBe(bindingA)
    expect(bindingB?.connection).not.toBe(ctxA)
    // 옛 ctx는 teardown 후에도 command 상태·바인딩 키를 그대로 쥐고 있다 — 이것이 결함의 전제다.
    expect(ctxA.boundCharacterId).toBe(SEED_CHARACTER_ID)

    // 결함이 노출되는 창을 명시적으로 고정한다: 'close' 이벤트 전이라 ctx.closed는 아직 false다.
    // 이 단언이 실패하면 아래 프레임 주입이 closed 가드에 걸려 테스트가 무의미해지므로(가드의 신원
    // 절이 아니라 closed 절만 검증하게 된다) 창 자체를 먼저 단언한다.
    expect(ctxA.closed).toBe(false)

    // evict 자체가 종료 lifecycle에서 markDirty를 1회 부르므로, 승계 명령 관측 전에 계수기를 비운다.
    h.markDirty.mockClear()

    // ── 3) 옛 소켓으로 라이브 명령 2개를 주입한다 ─────────────────────────────────
    // 실 TCP 타이밍 race('close' 직전에 도착한 버퍼 프레임)는 결정적으로 재현할 수 없으므로, 서버측
    // 소켓의 'message' 리스너를 직접 구동해 같은 상태(teardown 완료 + ctx.closed=false)에서 프레임이
    // 도달하는 상황을 만든다. 검증 대상은 race의 *타이밍*이 아니라 dispatch 경계 *가드의 존재*다.
    // 연마→이동 순서가 load-bearing이다: 이동이 먼저 통과하면 캐릭터가 훈련방을 떠나 연마가 방 게이트에서
    // 거부되므로, 가드가 없을 때 두 명령이 모두 상태를 바꾸도록 순서를 잡는다.
    sockA.emit('message', Buffer.from(JSON.stringify({ type: 'progress:train', id: 'evicted-1' })))
    await ctxA.frameTail
    sockA.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'world:move', direction: EVICT_EXIT, id: 'evicted-2' })),
    )
    await ctxA.frameTail

    // ── 4) 라이브 상태는 전혀 변하지 않는다 ───────────────────────────────────────
    const live = h.liveRegistry.get(SEED_CHARACTER_ID)
    expect(live?.character.currentRoom).toBe(EVICT_ROOM_TRAIN)
    expect(live?.character.level).toBe(EVICT_LEVEL)
    expect(live?.character.gold).toBe(EVICT_GOLD)
    expect(h.roomTrain.occupants.has(SEED_CHARACTER_ID)).toBe(true)
    expect(h.roomDest.occupants.has(SEED_CHARACTER_ID)).toBe(false)
    // write-behind 영속 경로도 건드리지 않는다(승계 명령이 저장 큐에 스냅샷을 남기지 않는다).
    expect(h.markDirty).not.toHaveBeenCalled()

    ws2.terminate()
    // 등록 바인딩을 일괄 종결해 grace·idle 실 타이머를 걷어낸다(vitest 열린 핸들 hang 방지).
    app.wsShutdown.markShuttingDown()
    app.wsShutdown.converge()
    await app.close()
  })
})
