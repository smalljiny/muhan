import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode, ServerEvent } from 'shared'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { defaultFleeRng } from '../world/tryMove.js'
import { createConnectionContext, type ConnectionContext } from './connection.js'
import { createSessionRegistry } from './sessionRegistry.js'
import { createCommandRegistry } from './router.js'
import { createNoopChannelAdapter } from './noopChannelAdapter.js'
import type { ChannelDeliveryContext, ChannelPort } from './channelPort.js'
import type { ActorContext } from './actorContext.js'
import {
  createLiveWorldWiring,
  assembleRoomChannelPort,
  type LiveWorldWiringBundle,
} from './liveWorldWiring.js'

/**
 * liveWorldWiring — 라이브 월드 의존 묶음을 진입 코어·이동·수명 어댑터·방 해소자로 파생하는 순수 팩토리
 * (Story 7). 팩토리는 transport 없이 단위 테스트 가능해야 하며(#5), transport 결합은 assembleRoomChannelPort
 * 하나에 격리한다. 채팅 전파는 wiring 레벨(2세션 하네스 아님)로 검증한다(#6).
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
  worldGraph: Map<number, RoomNode>
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>
  markDirty: ReturnType<typeof vi.fn>
  onRoomEntered: ReturnType<typeof vi.fn>
  onRoomLeft: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  findById: ReturnType<typeof vi.fn>
}

function makeBundle(worldGraph: Map<number, RoomNode>, character?: Character): BundleHarness {
  const liveRegistry = createLiveCharacterRegistry()
  const markDirty = vi.fn()
  const onRoomEntered = vi.fn()
  const onRoomLeft = vi.fn()
  const warn = vi.fn()
  const findById = vi.fn((_id: string) => Promise.resolve(character ?? null))

  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: { findById },
    markDirty,
    currentHour: () => 12,
    onRoomEntered,
    onRoomLeft,
    logger: { warn },
  }
  return { bundle, worldGraph, liveRegistry, markDirty, onRoomEntered, onRoomLeft, warn, findById }
}

describe('createLiveWorldWiring (순수 팩토리)', () => {
  it('liveWorldBinding.resolveRoom은 roomId로 월드 그래프 방을 해소한다', () => {
    const worldGraph = new Map<number, RoomNode>([[5, makeRoom(5)]])
    const { bundle } = makeBundle(worldGraph)

    const wiring = createLiveWorldWiring(bundle)

    expect(wiring.liveWorldBinding.resolveRoom(5)).toBe(worldGraph.get(5))
    expect(wiring.liveWorldBinding.resolveRoom(9999)).toBeUndefined()
  })

  it('moveDeps는 묶음의 liveRegistry를 그대로 쓰고 tryMoveDeps를 파생한다', () => {
    const worldGraph = new Map<number, RoomNode>([[3, makeRoom(3)]])
    const h = makeBundle(worldGraph)

    const wiring = createLiveWorldWiring(h.bundle)

    expect(wiring.moveDeps.liveRegistry).toBe(h.liveRegistry)
    expect(wiring.moveDeps.tryMoveDeps.resolveRoom(3)).toBe(worldGraph.get(3))
    expect(wiring.moveDeps.tryMoveDeps.currentHour()).toBe(12)
    expect(wiring.moveDeps.tryMoveDeps.rng).toBe(defaultFleeRng)
  })

  it('markCharacterDirty는 1회 생성돼 moveDeps와 같은 인스턴스이고 묶음 markDirty로 위임한다', () => {
    const worldGraph = new Map<number, RoomNode>([[3, makeRoom(3)]])
    const h = makeBundle(worldGraph)

    const wiring = createLiveWorldWiring(h.bundle)

    // 노출 필드와 moveDeps가 같은 인스턴스여야 한다(계약 단일화 — 호출처마다 재생성하지 않는다).
    expect(wiring.moveDeps.markCharacterDirty).toBe(wiring.markCharacterDirty)
    // 위임 확인: 헬퍼 호출이 원시 seam에 'characters' + 전체 문서 스냅샷으로 도달한다.
    wiring.markCharacterDirty('char-1', makeCharacter('char-1', 3))
    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ _id: 'char-1', currentRoom: 3, level: 7 }),
    )
  })

  it('lifecyclePort·entry는 같은 레지스트리/방을 배후에 둔다(#3 — place 후 onSessionEnd가 정리)', () => {
    const room = makeRoom(4)
    const worldGraph = new Map<number, RoomNode>([[4, makeRoom(4)], [4, room]])
    const character = makeCharacter('char-1', 4)
    const h = makeBundle(worldGraph, character)

    const wiring = createLiveWorldWiring(h.bundle)

    // entry로 배치 → 방 점유·레지스트리 등록(liveWorldBinding·lifecyclePort가 공유하는 단일 entry).
    wiring.liveWorldBinding.entry.place({ character })
    expect(room.occupants.has('char-1')).toBe(true)
    expect(h.liveRegistry.has('char-1')).toBe(true)

    // lifecyclePort.onSessionEnd → 같은 방에서 점유 해제 + 레지스트리 제거 + 최종 방 markDirty.
    wiring.lifecyclePort.onSessionEnd({
      accountId: 'acct-1',
      characterId: 'char-1',
      reason: 'shutdown',
    })
    expect(room.occupants.has('char-1')).toBe(false)
    expect(h.liveRegistry.has('char-1')).toBe(false)
    expect(h.markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ currentRoom: 4 }),
    )
  })

  it('trainDeps는 기존 원재료(liveRegistry·by-character resolveRoom·markCharacterDirty)만으로 파생된다', () => {
    const h = makeBundle(new Map<number, RoomNode>([[7, makeRoom(7)]]))

    const wiring = createLiveWorldWiring(h.bundle)

    // 묶음에 신규 원재료를 추가하지 않았음을 필드 동일성으로 고정한다 — 세 필드 모두 이미 존재하던
    // seam(레지스트리·발화자 방 해소자·characters 스냅샷 헬퍼)의 재사용이다. resolveRoom은 by-roomId가
    // 아니라 by-character 해소자와 **같은 인스턴스**여야 하며, 그 해소 동작 자체는 바로 아래
    // 'resolveRoom(by-character)…' 케이스가 소유한다(여기서 재단언하지 않는다).
    expect(wiring.trainDeps.liveRegistry).toBe(h.liveRegistry)
    expect(wiring.trainDeps.markCharacterDirty).toBe(wiring.markCharacterDirty)
    expect(wiring.trainDeps.resolveRoom).toBe(wiring.resolveRoom)
  })

  it('resolveRoom(by-character)은 registry→currentRoom→worldGraph로 발화자 방을 해소한다', () => {
    const room = makeRoom(7, ['char-1'])
    const worldGraph = new Map<number, RoomNode>([[7, room]])
    const h = makeBundle(worldGraph)
    h.liveRegistry.register({ character: makeCharacter('char-1', 7) })

    const wiring = createLiveWorldWiring(h.bundle)

    expect(wiring.resolveRoom('char-1')).toBe(room)
    expect(wiring.resolveRoom('unknown')).toBeUndefined()
  })
})

describe('createCommandRegistry with wiring.moveDeps (#4 world:move 등록)', () => {
  it('묶음 파생 moveDeps 주입 시 world:move가 등록된다', () => {
    const worldGraph = new Map<number, RoomNode>([[1, makeRoom(1)]])
    const { bundle } = makeBundle(worldGraph)
    const wiring = createLiveWorldWiring(bundle)
    const noop = createNoopChannelAdapter({ info: vi.fn() })

    const registry = createCommandRegistry(noop, { move: wiring.moveDeps })

    expect(registry.has('world:move')).toBe(true)
  })

  it('moveDeps 미주입 시 world:move는 미등록이다(거울 케이스)', () => {
    const noop = createNoopChannelAdapter({ info: vi.fn() })

    const registry = createCommandRegistry(noop)

    expect(registry.has('world:move')).toBe(false)
  })

  it('묶음 파생 trainDeps 주입 시 progress:train이 등록된다', () => {
    const worldGraph = new Map<number, RoomNode>([[1, makeRoom(1)]])
    const { bundle } = makeBundle(worldGraph)
    const wiring = createLiveWorldWiring(bundle)
    const noop = createNoopChannelAdapter({ info: vi.fn() })

    const registry = createCommandRegistry(noop, { train: wiring.trainDeps })

    expect(registry.has('progress:train')).toBe(true)
  })

  it('trainDeps 미주입 시 progress:train은 미등록이다(거울 케이스)', () => {
    const noop = createNoopChannelAdapter({ info: vi.fn() })

    const registry = createCommandRegistry(noop)

    expect(registry.has('progress:train')).toBe(false)
  })
})

describe('assembleRoomChannelPort (#6 채팅 전파 — wiring 레벨)', () => {
  type FakeSocket = { readonly id: string }

  type ChatHarness = {
    channelPort: ChannelPort
    safeSend: ReturnType<typeof vi.fn<(socket: FakeSocket, event: ServerEvent) => void>>
  }

  function makeChatHarness(): ChatHarness {
    // 방 1: char-a1·char-a2 점유. 방 2: char-b1 점유.
    const roomA = makeRoom(1, ['char-a1', 'char-a2'])
    const roomB = makeRoom(2, ['char-b1'])
    const worldGraph = new Map<number, RoomNode>([[1, roomA], [2, roomB]])
    const h = makeBundle(worldGraph)
    h.liveRegistry.register({ character: makeCharacter('char-a1', 1) })
    h.liveRegistry.register({ character: makeCharacter('char-a2', 1) })
    h.liveRegistry.register({ character: makeCharacter('char-b1', 2) })
    const wiring = createLiveWorldWiring(h.bundle)

    const sessionRegistry = createSessionRegistry()
    const socketByCtx = new Map<ConnectionContext, FakeSocket>()
    for (const id of ['char-a1', 'char-a2', 'char-b1']) {
      const ctx = createConnectionContext()
      sessionRegistry.register(id, 'acct-1', ctx, () => {})
      socketByCtx.set(ctx, { id: `sock-${id}` })
    }

    const safeSend = vi.fn<(socket: FakeSocket, event: ServerEvent) => void>()
    const channelPort = assembleRoomChannelPort<FakeSocket>({
      resolveRoom: wiring.resolveRoom,
      registry: sessionRegistry,
      resolveSocket: (connection) => socketByCtx.get(connection),
      safeSend,
    })
    return { channelPort, safeSend }
  }

  const speaker: ActorContext = { accountId: 'acct-1', characterId: 'char-a1' }

  it('같은 방 점유자 소켓에는 chat:said가 전달되고 다른 방 점유자에는 전달되지 않는다', () => {
    const { channelPort, safeSend } = makeChatHarness()

    const ctx: ChannelDeliveryContext = { speaker, channel: 'say', text: '안녕' }
    channelPort.deliver(ctx)

    // 소켓 id로 fan-out 대상을 확인한다(sock-<characterId> 규약). 같은 방(char-a2) 포함, 다른 방(char-b1) 배제.
    const targetedIds = new Set(safeSend.mock.calls.map((call) => call[0].id))
    expect(targetedIds.has('sock-char-a2')).toBe(true)
    expect(targetedIds.has('sock-char-b1')).toBe(false)
  })

  it('발화자 자신도 자기 chat:said를 받는다(#7 전 멤버 전달)', () => {
    const { channelPort, safeSend } = makeChatHarness()

    channelPort.deliver({ speaker, channel: 'say', text: '안녕' })

    const targetedIds = new Set(safeSend.mock.calls.map((call) => call[0].id))
    expect(targetedIds.has('sock-char-a1')).toBe(true)
  })

  it('전달 이벤트는 chat:said로 channel·speakerCharacterId·text를 담는다(target 없으면 키 생략)', () => {
    const { channelPort, safeSend } = makeChatHarness()

    channelPort.deliver({ speaker, channel: 'say', text: '안녕' })

    const firstCall = safeSend.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[1]).toEqual({
      type: 'chat:said',
      channel: 'say',
      speakerCharacterId: 'char-a1',
      text: '안녕',
    })
  })

  it('target이 있으면 chat:said에 target 키를 싣는다', () => {
    const { channelPort, safeSend } = makeChatHarness()

    channelPort.deliver({ speaker, channel: 'emote', text: '인사', target: 'char-a2' })

    const firstCall = safeSend.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[1]).toEqual({
      type: 'chat:said',
      channel: 'emote',
      speakerCharacterId: 'char-a1',
      text: '인사',
      target: 'char-a2',
    })
  })

  // 방어 no-op 경로(#4) — 방 occupants에는 있으나 소켓 대상을 해소할 수 없는 멤버는 조용히 스킵한다.
  // 세션 색인·소켓은 별도 조립 지점(assembleRoomChannelPort)에서만 캡처되므로, 두 단계 각각의 미해소를 고정한다.
  it('occupants에 있으나 세션 색인에 없는 멤버(binding 없음)는 조용히 스킵한다', () => {
    // 방 1: 발화자 char-a1 + 색인에 등록되지 않은 char-ghost가 점유. 발화자만 세션 등록·소켓 보유.
    const roomA = makeRoom(1, ['char-a1', 'char-ghost'])
    const worldGraph = new Map<number, RoomNode>([[1, roomA]])
    const h = makeBundle(worldGraph)
    h.liveRegistry.register({ character: makeCharacter('char-a1', 1) })
    const wiring = createLiveWorldWiring(h.bundle)

    const sessionRegistry = createSessionRegistry()
    const socketByCtx = new Map<ConnectionContext, FakeSocket>()
    const ctx = createConnectionContext()
    sessionRegistry.register('char-a1', 'acct-1', ctx, () => {})
    socketByCtx.set(ctx, { id: 'sock-char-a1' })
    // char-ghost는 세션 색인에 없다 → registry.get이 undefined → sendTo가 소켓 해소 전에 bail.

    const safeSend = vi.fn<(socket: FakeSocket, event: ServerEvent) => void>()
    const channelPort = assembleRoomChannelPort<FakeSocket>({
      resolveRoom: wiring.resolveRoom,
      registry: sessionRegistry,
      resolveSocket: (connection) => socketByCtx.get(connection),
      safeSend,
    })

    channelPort.deliver({ speaker, channel: 'say', text: '안녕' })

    // 발화자에게만 전달되고, 미등록 멤버(char-ghost)에는 safeSend가 호출되지 않는다.
    const targetedIds = new Set(safeSend.mock.calls.map((call) => call[0].id))
    expect(targetedIds).toEqual(new Set(['sock-char-a1']))
  })

  it('occupants에 있고 세션 색인에도 있으나 소켓이 정리된 멤버는 조용히 스킵한다', () => {
    // 방 1: 발화자 char-a1 + 세션 등록됐으나 소켓이 drop된 char-dropped가 점유.
    const roomA = makeRoom(1, ['char-a1', 'char-dropped'])
    const worldGraph = new Map<number, RoomNode>([[1, roomA]])
    const h = makeBundle(worldGraph)
    h.liveRegistry.register({ character: makeCharacter('char-a1', 1) })
    const wiring = createLiveWorldWiring(h.bundle)

    const sessionRegistry = createSessionRegistry()
    const socketByCtx = new Map<ConnectionContext, FakeSocket>()
    const ctxA = createConnectionContext()
    sessionRegistry.register('char-a1', 'acct-1', ctxA, () => {})
    socketByCtx.set(ctxA, { id: 'sock-char-a1' })
    // char-dropped는 세션 등록되나 socketByCtx에 매핑이 없다 → resolveSocket undefined → sendTo가 safeSend 전에 bail.
    const ctxDropped = createConnectionContext()
    sessionRegistry.register('char-dropped', 'acct-1', ctxDropped, () => {})

    const safeSend = vi.fn<(socket: FakeSocket, event: ServerEvent) => void>()
    const channelPort = assembleRoomChannelPort<FakeSocket>({
      resolveRoom: wiring.resolveRoom,
      registry: sessionRegistry,
      resolveSocket: (connection) => socketByCtx.get(connection),
      safeSend,
    })

    channelPort.deliver({ speaker, channel: 'say', text: '안녕' })

    // 발화자에게만 전달되고, 소켓이 정리된 멤버(char-dropped)에는 safeSend가 호출되지 않는다.
    const targetedIds = new Set(safeSend.mock.calls.map((call) => call[0].id))
    expect(targetedIds).toEqual(new Set(['sock-char-a1']))
  })
})
