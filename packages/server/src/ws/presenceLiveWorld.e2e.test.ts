import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type Character, type RoomNode, type ServerEvent } from 'shared'
import { buildApp } from '../app.js'
import { resetConfigForTests } from '../config/env.js'
import { InMemorySessionAuthAdapter } from '../auth/inMemorySessionAuthAdapter.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { createInstanceIdAllocator } from '../world/spawn.js'
import type { LiveWorldWiringBundle } from './liveWorldWiring.js'
import {
  startTestServer,
  newAuthedClient,
  waitForOpen,
  createMessageReader,
  waitFor,
  DEFAULT_TEST_ORIGIN,
  type MessageReader,
} from './wsTestClient.testutil.js'

// 방 입·퇴장 통지(world:presence) end-to-end — 실 TCP 소켓 2개로 라이브 월드 조립(createLiveWorldWiring)과
// 소켓 전송(registerWebsocket의 sendToCharacter)이 실제로 이어졌는지 관측한다. 하네스 구성은
// liveWorld.e2e.test.ts를 따르되, 이 파일은 presence 관측에 필요한 최소 월드(시작 방 →'동'→ 도착 방)만 둔다.
//
// 프레임 관찰 원칙: presence 판정은 "표식 채팅까지의 모든 프레임"으로 한다. 비채팅 프레임을 버리는
// nextChatSaid는 쓰지 않는다 — 버려진 프레임 안의 presence를 셀 수 없기 때문이다.

const COOKIE_A = 'presence-cookie-a'
const COOKIE_B = 'presence-cookie-b'
const ACCOUNT_A = 'presence-account-a'
const ACCOUNT_B = 'presence-account-b'
const CHAR_A = 'presence-char-a'
const CHAR_B = 'presence-char-b'
const NAME_A = '가람'
const NAME_B = '나래'

const ROOM_START = 1 // A·B의 시작 방
const ROOM_DEST = 2 // A의 이동 도착 방
const EXIT_EAST = '동'

function makeCharacter(
  id: string,
  name: string,
  accountId: string,
  currentRoom: number,
): Character {
  return {
    _id: id,
    name,
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
    accountId,
    status: 'active',
    alignment: 1,
  }
}

/** all-zero flags 방(이동 게이트 통과). */
function makeRoom(roomId: number, exits: RoomNode['exits']): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits,
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

function makeExit(name: string, targetRoomId: number): RoomNode['exits'][number] {
  return { name, targetRoomId, flags: [0, 0, 0, 0], key: 0, ltime: 0, interval: 60 }
}

interface PresenceHarness {
  app: FastifyInstance
  roomStart: RoomNode
  roomDest: RoomNode
}

/**
 * 라이브 월드 묶음을 주입한 app을 만든다. 저장은 이 스위트의 관측 대상이 아니라 markDirty·peekPending은
 * 무동작 stub으로 둔다(이동 write-behind 기록이 어디에도 닿지 않아도 presence 경로는 영향이 없다).
 */
function buildHarness(): PresenceHarness {
  const roomStart = makeRoom(ROOM_START, [makeExit(EXIT_EAST, ROOM_DEST)])
  const roomDest = makeRoom(ROOM_DEST, [])
  const worldGraph = new Map<number, RoomNode>([
    [ROOM_START, roomStart],
    [ROOM_DEST, roomDest],
  ])
  const store = new Map<string, Character>([
    [CHAR_A, makeCharacter(CHAR_A, NAME_A, ACCOUNT_A, ROOM_START)],
    [CHAR_B, makeCharacter(CHAR_B, NAME_B, ACCOUNT_B, ROOM_START)],
  ])

  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry: createLiveCharacterRegistry(),
    characterRepo: {
      findById: (id) => Promise.resolve(store.get(id) ?? null),
      hydrateInventory: () => Promise.resolve([]),
    },
    objectTemplates: new Map(),
    spawnTemplates: new Map(),
    alloc: createInstanceIdAllocator(),
    markDirty: vi.fn(),
    peekPending: () => undefined,
    currentHour: () => 12, // 밤 게이트 회피
    now: () => 0,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  }

  const sessionAuth = new InMemorySessionAuthAdapter({
    cookieToAccount: { [COOKIE_A]: ACCOUNT_A, [COOKIE_B]: ACCOUNT_B },
    characters: {
      [ACCOUNT_A]: [{ characterId: CHAR_A, name: NAME_A, class: 4, race: 1, level: 7 }],
      [ACCOUNT_B]: [{ characterId: CHAR_B, name: NAME_B, class: 4, race: 1, level: 7 }],
    },
  })

  const app = buildApp({ sessionAuth, liveWorldDeps: bundle })
  return { app, roomStart, roomDest }
}

/**
 * connect→hello→ready→characterList→prompt→selectCharacter→entered→world:room까지 왕복한다.
 * 진입 프레임(session:entered 또는 session:resumed)을 함께 돌려줘 호출자가 진입 경로를 단언하게 한다.
 */
async function enterWorldWithFrame(
  client: WebSocket,
  characterId: string,
): Promise<{ reader: MessageReader; entered: ServerEvent }> {
  const reader = createMessageReader(client)
  await waitForOpen(client)
  await reader.next() // system:hello
  client.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
  await reader.next() // session:characterList
  await reader.next() // session:prompt(selectCharacter)
  client.send(JSON.stringify({ type: 'session:selectCharacter', characterId }))
  const entered = await reader.next() // session:entered | session:resumed
  await reader.next() // world:room(배치 통지)
  return { reader, entered }
}

async function enterWorld(client: WebSocket, characterId: string): Promise<MessageReader> {
  return (await enterWorldWithFrame(client, characterId)).reader
}

/**
 * 표식 텍스트의 `chat:said`가 나올 때까지 **모든** 프레임을 모아 돌려준다(표식 프레임 포함).
 * 서버는 단일 스레드에서 요청을 순서대로 처리하므로, 표식보다 먼저 발생한 프레임은 모두 표식 앞에 놓인다.
 */
async function collectUntilChatMarker(
  reader: MessageReader,
  marker: string,
  timeoutMs = 1000,
): Promise<ServerEvent[]> {
  const frames: ServerEvent[] = []
  for (;;) {
    const frame = await reader.next(timeoutMs)
    frames.push(frame)
    if (frame.type === 'chat:said' && frame.text === marker) return frames
  }
}

function sayMarker(client: WebSocket, marker: string): void {
  client.send(JSON.stringify({ type: 'chat:message', channel: 'say', text: marker, id: marker }))
}

type PresenceEvent = Extract<ServerEvent, { type: 'world:presence' }>

function presenceOf(frames: readonly ServerEvent[], subjectId?: string): PresenceEvent[] {
  return frames.filter(
    (f): f is PresenceEvent =>
      f.type === 'world:presence' &&
      (subjectId === undefined || f.subject.characterId === subjectId),
  )
}

describe('world:presence end-to-end (실 소켓 2세션)', () => {
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    process.env.WS_RECONNECT_GRACE_MS = '60000'
    resetConfigForTests()
    apps = []
    clients = []
  })

  afterEach(async () => {
    // liveWorld.e2e와 같은 정리 순서 — 클라이언트를 닫고 일괄 종료로 grace 타이머를 걷어 낸 뒤 app을 닫는다.
    for (const client of clients) client.close()
    for (const app of apps) {
      app.wsShutdown.markShuttingDown()
      app.wsShutdown.converge()
    }
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  async function startTracked(app: FastifyInstance): Promise<string> {
    apps.push(app)
    return startTestServer(app)
  }

  function trackedClient(url: string, cookie: string): WebSocket {
    const client = newAuthedClient(url, { cookie })
    clients.push(client)
    return client
  }

  it('① 같은 방의 A가 이동하면 B는 moved-out을 정확히 1건 받고 A는 자기 통지를 받지 않는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // (1) A·B 초기 배치.
    const clientA = trackedClient(url, COOKIE_A)
    const a = await enterWorld(clientA, CHAR_A)
    const clientB = trackedClient(url, COOKIE_B)
    const b = await enterWorld(clientB, CHAR_B)
    await waitFor(() => h.roomStart.occupants.has(CHAR_A) && h.roomStart.occupants.has(CHAR_B))

    // (2) 초기 프레임 소비 — 같은 방이라 각 표식은 양쪽 모두에 도착한다. 두 리더를 두 표식까지 비운다
    // (B 진입으로 A에 쌓인 entered 통지도 여기서 소비된다).
    sayMarker(clientA, 'a-init')
    await collectUntilChatMarker(a, 'a-init')
    await collectUntilChatMarker(b, 'a-init')
    sayMarker(clientB, 'b-init')
    await collectUntilChatMarker(b, 'b-init')
    await collectUntilChatMarker(a, 'b-init')

    // (3) A 이동 요청.
    clientA.send(JSON.stringify({ type: 'world:move', direction: EXIT_EAST, id: 'm1' }))

    // (4) A의 이동 응답 — 첫 프레임이 도착 방 world:room이다.
    const aFirst = await a.next()
    expect(aFirst).toMatchObject({ type: 'world:room', roomId: ROOM_DEST })

    // (5) A의 이동 응답을 받은 뒤 B가 표식을 보낸다. (6) B의 표식까지 모은 프레임을 검사한다.
    sayMarker(clientB, 'b-after')
    const bFrames = await collectUntilChatMarker(b, 'b-after')
    const bPresence = presenceOf(bFrames)
    expect(bPresence).toHaveLength(1)
    expect(bPresence[0]).toMatchObject({
      type: 'world:presence',
      roomId: ROOM_START,
      subject: { kind: 'player', characterId: CHAR_A, name: NAME_A },
      change: { change: 'moved-out', direction: EXIT_EAST, announce: true },
    })

    // A: (4)부터 A 자신의 표식까지 같은 관찰 구간에서 subject A의 presence는 0건이다.
    sayMarker(clientA, 'a-after')
    const aFrames = [aFirst, ...(await collectUntilChatMarker(a, 'a-after'))]
    expect(presenceOf(aFrames, CHAR_A)).toHaveLength(0)
  })

  it('② B가 있는 방에 A가 진입하면 B는 entered(announce true)를 정확히 1건 받는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // B 먼저 진입하고 초기 프레임을 표식까지 소비한다.
    const clientB = trackedClient(url, COOKIE_B)
    const b = await enterWorld(clientB, CHAR_B)
    sayMarker(clientB, 'b-init')
    await collectUntilChatMarker(b, 'b-init')

    // A 진입 — 새 연결이 session:entered를 받아 진입 완료를 확인한 뒤에 B가 표식을 보낸다.
    const clientA = trackedClient(url, COOKIE_A)
    const { entered } = await enterWorldWithFrame(clientA, CHAR_A)
    expect(entered).toMatchObject({ type: 'session:entered', characterId: CHAR_A })

    sayMarker(clientB, 'b-after')
    const bPresence = presenceOf(await collectUntilChatMarker(b, 'b-after'))
    expect(bPresence).toHaveLength(1)
    expect(bPresence[0]).toMatchObject({
      type: 'world:presence',
      roomId: ROOM_START,
      subject: { kind: 'player', characterId: CHAR_A, name: NAME_A },
      change: { change: 'entered', announce: true },
    })
  })

  /** A·B를 시작 방에 배치하고, B가 받은 A의 entered 등 초기 프레임을 표식까지 소비한다. */
  async function placeBoth(
    url: string,
  ): Promise<{ clientA: WebSocket; clientB: WebSocket; b: MessageReader }> {
    const clientB = trackedClient(url, COOKIE_B)
    const b = await enterWorld(clientB, CHAR_B)
    const clientA = trackedClient(url, COOKIE_A)
    await enterWorld(clientA, CHAR_A)
    sayMarker(clientB, 'b-init')
    await collectUntilChatMarker(b, 'b-init')
    return { clientA, clientB, b }
  }

  it('③ A 소켓이 끊겨 link-dead 유예 중이면 B는 presence를 받지 않고 A는 방에 남는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)
    const { clientA, clientB, b } = await placeBoth(url)

    clientA.close()
    await waitFor(() => h.app.wsSessionRegistry.get(CHAR_A)?.link === 'link-dead')

    sayMarker(clientB, 'b-after')
    expect(presenceOf(await collectUntilChatMarker(b, 'b-after'))).toHaveLength(0)
    expect(h.roomStart.occupants.has(CHAR_A)).toBe(true)
  })

  it('④ 유예 중 같은 쿠키로 재접속(resumed)해도 B는 presence를 받지 않는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)
    const { clientA, clientB, b } = await placeBoth(url)

    clientA.close()
    await waitFor(() => h.app.wsSessionRegistry.get(CHAR_A)?.link === 'link-dead')

    const clientA2 = trackedClient(url, COOKIE_A)
    const { entered } = await enterWorldWithFrame(clientA2, CHAR_A)
    expect(entered).toMatchObject({ type: 'session:resumed', characterId: CHAR_A })

    sayMarker(clientB, 'b-after')
    expect(presenceOf(await collectUntilChatMarker(b, 'b-after'))).toHaveLength(0)
    expect(h.roomStart.occupants.has(CHAR_A)).toBe(true)
  })

  it('⑤ 유예가 만료되면 B는 A의 무음 exited만 정확히 1건 받는다', async () => {
    // grace를 스키마 최소값(1ms)으로 낮춘다 — env를 먼저 바꾸고 설정 캐시를 비운 뒤 app을 만든다.
    // afterEach가 env와 설정 캐시를 복원해 다른 it()에 새지 않는다.
    process.env.WS_RECONNECT_GRACE_MS = '1'
    resetConfigForTests()

    const h = buildHarness()
    const url = await startTracked(h.app)
    const { clientA, clientB, b } = await placeBoth(url)

    clientA.close()
    await waitFor(() => !h.roomStart.occupants.has(CHAR_A))

    sayMarker(clientB, 'b-after')
    const aPresence = presenceOf(await collectUntilChatMarker(b, 'b-after'), CHAR_A)
    // subject A의 presence 전체가 무음 exited 1건뿐이어야 한다 — 다른 변화가 섞여도 실패한다.
    expect(aPresence).toHaveLength(1)
    expect(aPresence[0]).toMatchObject({
      type: 'world:presence',
      roomId: ROOM_START,
      subject: { kind: 'player', characterId: CHAR_A, name: NAME_A },
      change: { change: 'exited', announce: false },
    })
  })

  it('⑥ 같은 캐릭터로 새 로그인해 세션이 교체되면 B는 exited → entered 2건을 순서대로 받는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)
    const { clientB, b } = await placeBoth(url)

    // A가 live인 상태에서 같은 쿠키의 새 클라이언트로 같은 캐릭터를 선택한다(register evict → release → place).
    expect(h.app.wsSessionRegistry.get(CHAR_A)?.link).toBe('live')
    const clientA2 = trackedClient(url, COOKIE_A)
    const { entered } = await enterWorldWithFrame(clientA2, CHAR_A)
    expect(entered).toMatchObject({ type: 'session:entered', characterId: CHAR_A })

    sayMarker(clientB, 'b-after')
    const bPresence = presenceOf(await collectUntilChatMarker(b, 'b-after'))
    expect(bPresence).toHaveLength(2)
    expect(bPresence[0]).toMatchObject({
      roomId: ROOM_START,
      subject: { kind: 'player', characterId: CHAR_A, name: NAME_A },
      change: { change: 'exited', announce: false },
    })
    expect(bPresence[1]).toMatchObject({
      roomId: ROOM_START,
      subject: { kind: 'player', characterId: CHAR_A, name: NAME_A },
      change: { change: 'entered', announce: true },
    })
    expect(h.roomStart.occupants.has(CHAR_A)).toBe(true)
  })
})
