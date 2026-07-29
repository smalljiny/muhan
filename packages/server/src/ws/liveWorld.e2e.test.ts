import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, neededExp, type Character, type RoomNode, type ServerEvent } from 'shared'
import { buildApp } from '../app.js'
import { goldToTrain } from '../progression/train.js'
import { trainingFlagsForClass } from '../progression/train.testutil.js'
import { resetConfigForTests } from '../config/env.js'
import { InMemorySessionAuthAdapter } from '../auth/inMemorySessionAuthAdapter.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { SaveEngine } from '../save/saveEngine.js'
import { NOOP_LOGGER } from '../save/logger.js'
import { FakeClock } from '../util/clock.testutil.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
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

// Story 8 — 라이브 월드 end-to-end 통합. Story 1~7이 세운 프로덕션 seam(진입·배치·이동·방 채널·세션 수명·
// 종료 수렴·저장 엔진)을 실 TCP 소켓 2개로 관통시켜, 입장→배치→이동→occupants 갱신→방 채팅 전파→종료 저장의
// 6단계를 한 흐름에서 순서대로 단언한다. 재접속 시 라이브 상태 보존은 자체 세션 수명을 갖는 별도 it()으로 검증한다.
//
// 이 파일은 테스트 전용이다 — 프로덕션 코드를 바꾸지 않는다. buildApp({ sessionAuth, liveWorldDeps })에
// 2계정 인증 어댑터와 라이브 월드 묶음(실 SaveEngine markDirty 결선 포함)을 주입해 관측한다.

// ── 결정적 인증 시드(2계정·2쿠키·2캐릭터) ─────────────────────────────────────────
const COOKIE_A = 'e2e-cookie-a'
const COOKIE_B = 'e2e-cookie-b'
const ACCOUNT_A = 'e2e-account-a'
const ACCOUNT_B = 'e2e-account-b'
const CHAR_A = 'e2e-char-a'
const CHAR_B = 'e2e-char-b'
// 연마 시나리오 전용 3번째 세션. 기존 이동·채팅 시나리오는 A·B만 관측하므로(occupants·updates.get(A/B))
// 이 시드는 그 케이스들에 inert하다 — 훈련방 플래그를 시작 방에 얹어 이동 게이트를 흔들지 않기 위해
// 별도 방·별도 캐릭터로 분리한다.
const COOKIE_C = 'e2e-cookie-c'
const ACCOUNT_C = 'e2e-account-c'
const CHAR_C = 'e2e-char-c'

// ── 월드 그래프 방 ID ────────────────────────────────────────────────────────
const ROOM_START = 1 // 두 캐릭터의 시작 방(char A 출발지, char B 상주지)
const ROOM_DEST = 2 // char A 이동 도착 방
const ROOM_TRAIN = 3 // char C 상주 훈련방(class 4 수련장 플래그)

/** 캐릭터 class — 문서 픽스처·세션 시드·훈련방 flag 파생이 모두 이 상수를 쓴다(동기화 강제). */
const CHAR_CLASS = 4

/** char C의 연마 전 레벨. 정확히 1레벨분 exp·gold를 실어 결정적으로 1레벨만 오르게 한다. */
const TRAIN_LEVEL = 7
const TRAIN_EXP = neededExp(TRAIN_LEVEL)
const TRAIN_GOLD = goldToTrain(TRAIN_LEVEL)

/** 시작 방에서 유효 출구 '동'으로 도착 방을 잇는 pass-move 픽스처(all-zero flags — 게이트 건틀릿 통과). */
const EXIT_EAST = '동'

/**
 * 최소 유효 Character 문서를 만든다(pluginLiveWorld.test.ts 픽스처 미러). hydrate/place가 읽는
 * currentRoom·_id·accountId와 characterSchema 필수 필드를 채운다.
 */
function makeCharacter(id: string, accountId: string, currentRoom: number): Character {
  return {
    _id: id,
    name: '테스토스',
    class: CHAR_CLASS,
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

/** all-zero flags 방(tryMove.test.ts pass-move 픽스처 미러 — 게이트 건틀릿 통과). */
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

/** 지정 class의 훈련방 — flags 규칙(base RTRAIN + class-bit 역순)은 train.testutil이 소유한다. */
function makeTrainingRoom(roomId: number, cls: number): RoomNode {
  return { ...makeRoom(roomId, []), flags: trainingFlagsForClass(cls) }
}

/** name·targetRoomId만 지정한 all-zero flags 출구(bits 없음 = 모든 게이트 통과). */
function makeExit(name: string, targetRoomId: number): RoomNode['exits'][number] {
  return { name, targetRoomId, flags: [0, 0, 0, 0], key: 0, ltime: 0, interval: 60 }
}

/**
 * 로드(findById)와 flush(updateById)를 한 객체에 둔 fake character repo. 로드한 방과 저장된 방을 같은
 * fake에서 관측한다 — findById는 라이브 hydrate가, updateById는 SaveEngine dispatch가 소비한다.
 * findById는 vi.fn으로 감싸 재접속 시 호출수 불변(재로드 없음)을 단언한다.
 */
interface FakeCharacterRepo {
  findById: ReturnType<typeof vi.fn<(id: string) => Promise<Character | null>>>
  /** id → 마지막 flush patch. SaveEngine dispatch가 characters.updateById로 호출한다. */
  readonly updates: Map<string, Partial<Character>>
  updateById(id: string, patch: Partial<Character>): Promise<void>
}

function makeCharacterRepo(seed: Character[]): FakeCharacterRepo {
  const store = new Map<string, Character>(seed.map((c) => [c._id, c]))
  const updates = new Map<string, Partial<Character>>()
  return {
    findById: vi.fn<(id: string) => Promise<Character | null>>((id) =>
      Promise.resolve(store.get(id) ?? null),
    ),
    updates,
    updateById(id, patch) {
      updates.set(id, patch)
      return Promise.resolve()
    },
  }
}

/** 라이브 월드 통합 하네스 — app·묶음·월드 그래프·저장 엔진·fake repo를 한 번에 조립한다. */
interface LiveWorldHarness {
  app: FastifyInstance
  roomStart: RoomNode
  roomDest: RoomNode
  roomTrain: RoomNode
  characterRepo: FakeCharacterRepo
  saveEngine: SaveEngine
}

/**
 * 라이브 월드 묶음을 실 SaveEngine markDirty에 결선한 app을 만든다.
 *
 * bundle.markDirty = saveEngine.markDirty로 이어, 이동 write-through와 종료 lifecycle markDirty가 모두
 * 저장 엔진 tracker에 쌓이고 saveEngine.shutdown()의 강제 flush로 fake repo.updateById에 도달한다.
 * SaveEngine 생성자는 concrete repo 클래스를 요구하므로(bank/world는 이 흐름에서 미사용) 최소 stub을
 * 캐스트로 채운다 — 실제 히트되는 것은 characters.updateById와 characterRepo.findById뿐이다.
 *
 * onRoomEntered/onRoomLeft/logger는 vi.fn() stub이다 — 검증 대상 로직을 지운 게 아니라 인접 스코프
 * 경계다. occupants 변이는 실 entry.place·실 tryMove가 소유하고(훅은 activeSet 활성화·perm 리스폰이라
 * 별도 토픽 계약), 이 스위트의 occupants 단언이 그 실 경로를 관통한다.
 */
function buildHarness(): LiveWorldHarness {
  const roomStart = makeRoom(ROOM_START, [makeExit(EXIT_EAST, ROOM_DEST)])
  // 도착 방은 back-exit이 없다 — 이 스위트는 start→dest 단방향 이동만 exercise한다.
  const roomDest = makeRoom(ROOM_DEST, [])
  // 훈련방은 시작 방과 분리한다 — 시작 방 flags는 기존 이동 시나리오의 tryMove 게이트 건틀릿 입력이라
  // RTRAIN 비트를 얹으면 무관한 케이스를 흔든다.
  const roomTrain = makeTrainingRoom(ROOM_TRAIN, CHAR_CLASS)
  const worldGraph = new Map<number, RoomNode>([
    [ROOM_START, roomStart],
    [ROOM_DEST, roomDest],
    [ROOM_TRAIN, roomTrain],
  ])

  const characterRepo = makeCharacterRepo([
    makeCharacter(CHAR_A, ACCOUNT_A, ROOM_START),
    makeCharacter(CHAR_B, ACCOUNT_B, ROOM_START),
    // char C는 훈련방에 상주하며 정확히 1레벨분 exp·gold를 갖는다(연마 시나리오 전용).
    {
      ...makeCharacter(CHAR_C, ACCOUNT_C, ROOM_TRAIN),
      level: TRAIN_LEVEL,
      experience: TRAIN_EXP,
      gold: TRAIN_GOLD,
    },
  ])

  // SaveEngine — CC#4 패턴 미러(FakeClock + 즉시 backoff). start() 후 markDirty는 app 흐름에서 일어나고
  // shutdown()의 직접 flush가 tracker 잔여를 큐로 넘겨 fake repo.updateById로 write한다.
  const bankStub = {} as unknown as BankRepository
  const worldStub = {} as unknown as WorldRepository
  const saveEngine = new SaveEngine(
    characterRepo as unknown as CharacterRepository,
    bankStub,
    worldStub,
    NOOP_LOGGER,
    { clock: new FakeClock(), queueOptions: { sleep: () => Promise.resolve() } },
  )
  saveEngine.start()

  const liveRegistry = createLiveCharacterRegistry()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: { findById: (id) => characterRepo.findById(id) },
    markDirty: (collection, id, snapshot) => saveEngine.markDirty(collection, id, snapshot),
    currentHour: () => 12, // pass-move 시간 게이트 통과(밤 게이트 회피)
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn() },
  }

  const sessionAuth = new InMemorySessionAuthAdapter({
    cookieToAccount: { [COOKIE_A]: ACCOUNT_A, [COOKIE_B]: ACCOUNT_B, [COOKIE_C]: ACCOUNT_C },
    characters: {
      [ACCOUNT_A]: [{ characterId: CHAR_A, name: '무한전사', class: CHAR_CLASS, race: 1, level: 7 }],
      [ACCOUNT_B]: [{ characterId: CHAR_B, name: '무한도적', class: CHAR_CLASS, race: 1, level: 7 }],
      [ACCOUNT_C]: [
        { characterId: CHAR_C, name: '무한수련생', class: CHAR_CLASS, race: 1, level: 7 },
      ],
    },
  })

  const app = buildApp({ sessionAuth, liveWorldDeps: bundle })
  return { app, roomStart, roomDest, roomTrain, characterRepo, saveEngine }
}

/**
 * 소켓을 connect→hello→ready→characterList→prompt→selectCharacter→entered→world:room까지 왕복시킨다.
 *
 * 라이브 월드 주입 시 배치가 entered 직후 world:room을 발화하므로(constraint #5), 그 여분 프레임을 명시적으로
 * 소비해 이후 chat/echo 단언이 어긋나지 않게 한다. 진입 프레임(session:entered 또는 session:resumed)과 뒤이은
 * world:room을 함께 돌려줘 호출자가 재접속(resumed) 여부를 단언하게 한다.
 */
async function enterWorld(
  client: WebSocket,
  characterId: string,
): Promise<{ reader: MessageReader; entered: ServerEvent; room: ServerEvent }> {
  const reader = createMessageReader(client)
  await waitForOpen(client)
  await reader.next() // system:hello
  client.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
  await reader.next() // session:characterList
  await reader.next() // session:prompt(selectCharacter)
  client.send(JSON.stringify({ type: 'session:selectCharacter', characterId }))
  const entered = await reader.next() // session:entered | session:resumed
  const room = await reader.next() // world:room(배치 통지)
  return { reader, entered, room }
}

/**
 * reader에서 `chat:said` 프레임이 나올 때까지 소비한다 — 비-chat 프레임(향후 이동 leave/join 방송 등)은
 * 건너뛴다. 방 채팅 부정 단언이 "아무 프레임도 안 옴"(실시간 타임아웃 race)이 아니라 "다음 chat:said는
 * 반드시 B 자신의 것"이라는 predicate가 되게 해, 미래의 무관한 이동-통지 기능이 landing해도 취약해지지 않는다.
 */
async function nextChatSaid(reader: MessageReader, timeoutMs = 1000): Promise<ServerEvent> {
  for (;;) {
    const frame = await reader.next(timeoutMs)
    if (frame.type === 'chat:said') return frame
  }
}

describe('라이브 월드 end-to-end (실 소켓 2세션)', () => {
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    // 재접속이 확실히 grace 창 안에 들도록 넉넉히 잡는다(constraint #3 — 짧으면 flaky).
    process.env.WS_RECONNECT_GRACE_MS = '60000'
    resetConfigForTests()
    apps = []
    clients = []
  })

  afterEach(async () => {
    // 클라이언트를 먼저 닫는다. 마지막 close는 살아 있는 세션에 새 실 grace 타이머(최대 60s, unref 아님)를
    // arm하므로, app close 전에 markShuttingDown→converge로 등록 바인딩을 일괄 종결해 grace·idle 타이머를
    // clear하고 뒤늦은 close의 재-arm을 차단한다(vitest 열린 핸들 hang 방지).
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

  it('입장→배치→이동→occupants 갱신→방 채팅 전파→종료 저장을 한 흐름으로 관통한다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // ── 1) 입장 — 두 세션이 각자 캐릭터로 월드에 진입한다(session:entered). ──────────────
    const clientA = trackedClient(url, COOKIE_A)
    const a = await enterWorld(clientA, CHAR_A)
    expect(a.entered).toMatchObject({ type: 'session:entered', characterId: CHAR_A })
    expect(a.room).toMatchObject({ type: 'world:room', roomId: ROOM_START })

    const clientB = trackedClient(url, COOKIE_B)
    const b = await enterWorld(clientB, CHAR_B)
    expect(b.entered).toMatchObject({ type: 'session:entered', characterId: CHAR_B })
    expect(b.room).toMatchObject({ type: 'world:room', roomId: ROOM_START })

    // ── 2) 배치 — 두 캐릭터가 시작 방 occupants에 등록된다. ─────────────────────────────
    await waitFor(() => h.roomStart.occupants.has(CHAR_A) && h.roomStart.occupants.has(CHAR_B))
    expect(h.roomStart.occupants.has(CHAR_A)).toBe(true)
    expect(h.roomStart.occupants.has(CHAR_B)).toBe(true)

    // ── 3) 방 채팅 전파(co-located 긍정) — A가 시작 방에서 발화하면 A·B 모두 chat:said를 받는다. ──
    clientA.send(JSON.stringify({ type: 'chat:message', channel: 'say', text: '안녕', id: 'a1' }))
    const aHeardOwn = await a.reader.next()
    expect(aHeardOwn).toMatchObject({
      type: 'chat:said',
      channel: 'say',
      speakerCharacterId: CHAR_A,
      text: '안녕',
    })
    const bHeardA = await b.reader.next()
    expect(bHeardA).toMatchObject({
      type: 'chat:said',
      channel: 'say',
      speakerCharacterId: CHAR_A,
      text: '안녕',
    })

    // ── 4) 이동 — A가 '동' 출구로 도착 방에 이동한다(world:room{도착 방}). ────────────────
    clientA.send(JSON.stringify({ type: 'world:move', direction: EXIT_EAST, id: 'm1' }))
    const moved = await a.reader.next()
    expect(moved).toMatchObject({ type: 'world:room', roomId: ROOM_DEST })

    // ── 5) occupants 갱신 — 이동 후 A는 도착 방, B는 시작 방에 홀로 남는다. ────────────────
    await waitFor(() => h.roomDest.occupants.has(CHAR_A) && !h.roomStart.occupants.has(CHAR_A))
    expect(h.roomDest.occupants.has(CHAR_A)).toBe(true)
    expect(h.roomStart.occupants.has(CHAR_A)).toBe(false)
    expect(h.roomStart.occupants.has(CHAR_B)).toBe(true)

    // ── 6) 방 채팅(분리 후 방 경계 준수 + liveness 대조군) ────────────────────────────
    // A가 도착 방에서 발화 → A는 자기 것을 받는다(fan-out 완료 증명). 분리된 B에는 도달하지 않아야 한다.
    clientA.send(JSON.stringify({ type: 'chat:message', channel: 'say', text: '멀리서', id: 'a2' }))
    const aHeardOwn2 = await a.reader.next()
    expect(aHeardOwn2).toMatchObject({ type: 'chat:said', speakerCharacterId: CHAR_A, text: '멀리서' })

    // A의 발화 fan-out이 완결된 뒤 B가 시작 방에서 sentinel을 발화한다. A의 chat이 방 경계를 넘어 B에 샜다면
    // 서버 처리 순서상 B 큐에서 sentinel보다 앞에 놓이므로, B가 받는 다음 chat:said는 반드시 B 자신의
    // sentinel이어야 한다 — 방 경계 준수(A 미도달)와 소켓 liveness(B 수신)를 한 단언으로 증명한다. 타임아웃
    // race('아무 것도 안 옴') 대신 결정적 predicate라 CI 지터에 강하고, nextChatSaid가 비-chat 프레임을 걸러
    // 미래 이동-방송 기능에도 견고하다.
    clientB.send(JSON.stringify({ type: 'chat:message', channel: 'say', text: '여기있음', id: 'b2' }))
    const bNextChat = await nextChatSaid(b.reader)
    expect(bNextChat).toMatchObject({ type: 'chat:said', speakerCharacterId: CHAR_B, text: '여기있음' })

    // ── 7) 종료 저장 — 서버 주도 수렴으로 onSessionEnd(markDirty→release)를 구동한 뒤 강제 flush. ──
    // 소켓 close 단독으로는 onSessionEnd가 발화하지 않으므로(link-dead만 표시), markShuttingDown→converge로
    // 등록 바인딩을 일괄 종결해 lifecycle 어댑터를 구동한다.
    h.app.wsShutdown.markShuttingDown()
    h.app.wsShutdown.converge()
    await h.saveEngine.shutdown()

    // A 저장 = 도착 방(load-time 아닌 post-move 값). B 저장 = 시작 방 — B는 이동한 적 없어 오직 onSessionEnd의
    // markDirty에서만 온다(종료 lifecycle 경로가 실제 구동됐음 증명, constraint #2).
    expect(h.characterRepo.updates.get(CHAR_A)).toMatchObject({ currentRoom: ROOM_DEST })
    expect(h.characterRepo.updates.get(CHAR_B)).toMatchObject({ currentRoom: ROOM_START })
  })

  it('훈련방에서 progress:train으로 레벨업하고 상승한 level·차감된 gold가 전체 문서로 저장된다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // ── 1) 입장 — char C가 훈련방에 진입한다. ─────────────────────────────────────────
    const clientC = trackedClient(url, COOKIE_C)
    const c = await enterWorld(clientC, CHAR_C)
    expect(c.entered).toMatchObject({ type: 'session:entered', characterId: CHAR_C })
    expect(c.room).toMatchObject({ type: 'world:room', roomId: ROOM_TRAIN })
    await waitFor(() => h.roomTrain.occupants.has(CHAR_C))

    // ── 2) 연마 — progress:train이 progress:trained로 되돌아온다(상태 이벤트, 상관 키 없음). ──
    clientC.send(JSON.stringify({ type: 'progress:train', id: 't1' }))
    const trained = await c.reader.next()
    expect(trained).toMatchObject({
      type: 'progress:trained',
      level: TRAIN_LEVEL + 1,
      levelsGained: 1,
      gold: 0,
      prestige: 'none',
    })
    expect(trained).not.toHaveProperty('correlationId')

    // ── 3) 종료 저장 — 수렴 후 강제 flush로 write-behind 스냅샷을 fake repo에 도달시킨다. ──
    h.app.wsShutdown.markShuttingDown()
    h.app.wsShutdown.converge()
    await h.saveEngine.shutdown()

    // 상승한 level·차감된 gold가 저장된다(load-time 값 7/TRAIN_GOLD가 아니다).
    const saved = h.characterRepo.updates.get(CHAR_C)
    expect(saved).toMatchObject({ level: TRAIN_LEVEL + 1, gold: 0, currentRoom: ROOM_TRAIN })
    // 부분 패치가 아니라 characters 전체 문서 스냅샷이다(LWW write-loss 봉쇄 계약) — 연마와 무관한
    // 필드까지 함께 실린다. 단 두 필드는 설계상 제외된다: `_id`는 SaveEngine.stripImmutableId가 벗기고
    // (Mongo immutable-`_id`), `status`는 markCharacterDirty가 뺀다(라이브가 소유하지 않는 권한 필드).
    expect(saved).toMatchObject({
      name: '테스토스',
      accountId: ACCOUNT_C,
      class: CHAR_CLASS,
      race: 1,
      experience: TRAIN_EXP,
      schemaVersion: 2,
    })
    expect(saved?.stats).toHaveLength(5)
    expect(saved?.spells).toHaveLength(16)
    expect(saved?.realm).toHaveLength(4)
    expect(saved).not.toHaveProperty('_id')
    expect(saved).not.toHaveProperty('status')
  })

  it('이동 후 재접속 시 라이브 상태(도착 방)를 보존하고 재로드하지 않는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // 최초 접속 — char A가 시작 방에 진입한 뒤 '동' 출구로 도착 방에 이동한다.
    const clientA = trackedClient(url, COOKIE_A)
    const first = await enterWorld(clientA, CHAR_A)
    expect(first.entered).toMatchObject({ type: 'session:entered', characterId: CHAR_A })
    clientA.send(JSON.stringify({ type: 'world:move', direction: EXIT_EAST, id: 'm1' }))
    expect(await first.reader.next()).toMatchObject({ type: 'world:room', roomId: ROOM_DEST })

    // hydrate가 최초 1회 findById로 로드했다(도착 이동 후에도 재로드 없음의 기준선).
    const findByIdCallsForA = (): number =>
      h.characterRepo.findById.mock.calls.filter((call) => call[0] === CHAR_A).length
    expect(findByIdCallsForA()).toBe(1)

    // transient close — 소켓만 닫으면 link-dead로 표시되고 라이브 엔트리는 grace 동안 살아 있다.
    clientA.close()
    await waitFor(() => h.app.wsSessionRegistry.get(CHAR_A)?.link === 'link-dead')

    // grace 창 안에서 같은 계정으로 재접속 → enterWorld가 rebind로 이어 session:resumed를 발화한다.
    // rebind가 아니라 register(evict-old)를 탔다면 findById 재호출·재hydrate가 일어나므로, resumed 프레임이
    // rebind 경로를 탔음을 증명하는 유일한 신호다(constraint #3).
    const clientA2 = trackedClient(url, COOKIE_A)
    const second = await enterWorld(clientA2, CHAR_A)
    expect(second.entered).toMatchObject({ type: 'session:resumed', characterId: CHAR_A })
    // 라이브 currentRoom(도착 방)이 world:room에 보존돼 통지된다.
    expect(second.room).toMatchObject({ type: 'world:room', roomId: ROOM_DEST })

    // 재접속은 재로드하지 않는다 — findById 호출수가 초기값(캐릭터당 1)으로 불변이다.
    expect(findByIdCallsForA()).toBe(1)
    // 라이브 레지스트리의 단일 출처(currentRoom)도 도착 방을 유지한다.
    expect(h.app.wsSessionRegistry.get(CHAR_A)?.link).toBe('live')
  })
})
