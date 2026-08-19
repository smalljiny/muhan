import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  objectSchema,
  spellByNo,
  isKnown,
  type Character,
  type ObjectInstance,
  type RoomNode,
  type ServerEvent,
} from 'shared'
import { buildApp } from '../app.js'
import { resetConfigForTests } from '../config/env.js'
import { InMemorySessionAuthAdapter } from '../auth/inMemorySessionAuthAdapter.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { makeRoom } from '../world/roomFixtures.testutil.js'
import { SaveEngine } from '../save/saveEngine.js'
import { NOOP_LOGGER } from '../save/logger.js'
import { FakeClock } from '../util/clock.testutil.js'
import { loadObjectTemplates, type ObjectTemplate } from '../items/objectTemplate.js'
import { SCROLL } from '../items/taxonomy.js'
import { F_ISSET, OGOODO, OEVILO, OCLSEL, OINVIS } from '../world/hexFlags.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
import type { ObjectRepository } from '../repo/objectRepository.js'
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

// Story 8 — 학습(비법서 연마) end-to-end 통합. 형제 스위트 `liveWorld.e2e.test.ts`가 이동·채팅·연마를
// 관통시키는 것과 같은 하네스 골격을 쓰되, **진입 → 인벤 적재 → 연마 → 통지 → 영속화** 한 흐름만 남긴다.
// 계층별 단위 테스트(Story 1~7)는 각 seam을 고정했지만 그 사이의 결선이 실제로 이어졌는지는 증명하지
// 못한다 — 이 파일이 실 TCP 소켓 1개로 그 결선을 관통시킨다.
//
// ## 형제 스위트와의 결정적 차이 — 정본 템플릿 인덱스를 싣는다
// `liveWorld.e2e.test.ts`는 `objectTemplates: new Map()`(합성 빈 인덱스)을 싣기 때문에 정본 데이터가
// 실제로 연마 가능한지를 검출하지 못한다. 이 스위트는 `loadObjectTemplates()`로 `data/world/objects.json`
// 정본 709엔트리를 그대로 실어, 시드한 비법서가 **실 콘텐츠**로 해소되고 게이트를 통과하는 것까지
// 관통시킨다.
//
// ⚠ 닫히는 것은 그 하나뿐이다. **boot(`index.ts`)의 묶음 조립은 여전히 미검증**이다 — 이 파일도
// `LiveWorldWiringBundle` 리터럴을 자체 구성하므로, boot가 `objectTemplates`에 무엇을 싣는지는 여기서
// 검출되지 않는다(`index.ts`는 커버리지 제외 배선 코드라 설계상 그렇다).
//
// ## 하네스 최소화 — 방 1개·계정 1개
// 연마는 방을 읽지 않고(대상이 소지품 스코프다) 다른 세션과 상호작용하지도 않는다. 형제 스위트의
// 3방·3계정을 복사하지 않고 방 1개·계정 1개로 줄인다 — 배치가 성립하려면 해소되는 방 하나가 필요할
// 뿐이다(`entry.place`가 미해소 방에 던진다).
//
// 이 파일은 테스트 전용이다 — 프로덕션 코드를 바꾸지 않는다.

// ── 결정적 인증 시드(1계정·1쿠키·1캐릭터) ────────────────────────────────────
const COOKIE = 'study-e2e-cookie'
const ACCOUNT = 'study-e2e-account'
const CHAR = 'study-e2e-char'

/** 유일한 방. 연마는 방을 읽지 않으므로 출구도 훈련 플래그도 필요 없다(배치용 최소 노드). */
const ROOM_STUDY = 1

/** 캐릭터 class — MAGE(5). 시드 비법서에 `OCLSEL`이 없어 클래스 게이트는 미발화하지만, 마법 계열
 *  클래스를 골라 시나리오 의미를 맞춘다. */
const CHAR_CLASS = 5

/**
 * 시드 비법서 objnum — 정본 `objects.json`의 `혼동비서`(id 142).
 *
 * 선정 기준(전부 `magic/learning.ts:study`의 게이트 입력이다):
 *  - `type === 7`(SCROLL) — ② SCROLL 게이트 통과.
 *  - `ndice === 20` ≤ 캐릭터 레벨 20 — ③ 레벨 게이트를 **경계값 등호**로 통과한다(`ndice > level`이
 *    거부 조건이므로 같으면 통과). ndice가 0이 아닌 후보를 고른 이유가 이것이다 — 0을 고르면 레벨
 *    게이트가 어떤 값에서도 통과해 관통 경로에서 사실상 사라진다. 정본 SCROLL의 ndice 값역은
 *    {0,16,20,28,32,36,39,40,43,48,52,60,70}이라 20이 저레벨 쪽 최소에 가깝다.
 *  - `flags === '0000000000000000'` — `OGOODO`·`OEVILO`(④ 정렬)·`OCLSEL`(⑤ 클래스) 미세팅이라 두
 *    게이트가 통과하고, `OINVIS` 미세팅이라 소지품 해소자의 가시성 게이트도 통과한다.
 *  - `magicpower === 13` → 주문번호 12(`혼동`)가 카탈로그 멤버라 ⑥ 주문 존재 게이트를 통과한다.
 *
 * 아래 첫 it()이 이 조건들을 정본 인덱스에 대해 직접 단언한다 — 정본 데이터가 바뀌면 시나리오가
 * 알 수 없는 이유로 깨지는 대신 그 단언이 먼저 터진다.
 */
const BOOK_OBJNUM = 142
/** 시드 비법서가 담은 주문번호(`magicpower - 1`) — 카탈로그 12번 `혼동`. */
const BOOK_SPELL_NO = 12
/** 시드 인스턴스 `_id` — `progress:studied.consumedObjectId`·`objects.deleteById` 단언의 기준값이다. */
const BOOK_INSTANCE_ID = 'study-e2e-book-1'
/** 캐릭터 레벨 — 시드 비법서 `ndice`(20)와 같게 잡아 레벨 게이트 경계를 통과시킨다. */
const CHAR_LEVEL = 20

/** 정본 템플릿 인덱스 — 파일당 1회 로드해 하네스마다 재파싱하지 않는다(206KB JSON, 읽기 전용). */
const OBJECT_TEMPLATES = loadObjectTemplates()

/** 시드 비법서 템플릿(정본). 위 상수들의 실제 출처이며 아래 단언·시드가 함께 참조한다. */
const BOOK_TEMPLATE: ObjectTemplate | undefined = OBJECT_TEMPLATES.get(BOOK_OBJNUM)

/** 최소 유효 Character 문서(형제 스위트 `makeCharacter` 미러 — 학습에 필요한 필드만 조정한다). */
function makeCharacter(): Character {
  return {
    _id: CHAR,
    name: '테스토스',
    class: CHAR_CLASS,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom: ROOM_STUDY,
    hpCurrent: 42,
    mpCurrent: 15,
    level: CHAR_LEVEL,
    experience: 0,
    // 지식 비트가 전부 0인 상태에서 출발한다 — 연마 후 12번 비트만 서는 것을 단언한다.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 2,
    accountId: ACCOUNT,
    status: 'active',
    alignment: 1,
  }
}

/**
 * 시드 비법서 인스턴스 — `objectSchema.parse`를 통과시켜 만든다.
 *
 * 리터럴을 그대로 쓰지 않는 이유는 형상 계약을 **런타임에** 강제하기 위해서다. 이 스위트의 fake repo는
 * 인스턴스를 검증 없이 돌려주므로(실 `ObjectRepository.findByOwner`는 `objectSchema.parse`한다), 파싱을
 * 끼우지 않으면 스키마가 거부할 시드로도 시나리오가 통과해 배선 검출력이 떨어진다.
 */
function makeBookInstance(): ObjectInstance {
  return objectSchema.parse({
    _id: BOOK_INSTANCE_ID,
    objnum: BOOK_OBJNUM,
    // ⚠ 인스턴스의 type은 스키마 필수 필드를 채울 뿐이다 — study()의 ② SCROLL 게이트가 읽는 것은
    //   `found.template.type`(정본 인덱스)이지 이 값이 아니다. 여기를 바꿔도 게이트는 흔들리지 않는다.
    type: SCROLL,
    owner: { type: 'character', id: CHAR },
    slot: null,
    equipped: false,
    value: BOOK_TEMPLATE?.value ?? 0,
    shotscur: 1,
    schemaVersion: 1,
  })
}

/**
 * 두 write 시도 순서를 한 배열에 기록하는 라우트 태그. `characters`가 `objectDeletions`보다 먼저
 * 나와야 한다(study 핸들러의 마킹 순서 계약 — `ws/handlers/study.ts` 헤더 "마킹 순서" 참조).
 */
type WriteRoute = 'characters' | 'objectDeletions'

/**
 * 로드(findById·hydrateInventory)와 flush(updateById)를 한 객체에 둔 fake character repo.
 * 형제 스위트의 것을 미러링하되 `hydrateInventory`가 **비법서 1건**을 돌려주고, `updateById`도
 * `vi.fn`으로 감싸 호출 순서·호출수를 함께 관측한다(실패 시나리오의 "미호출" 단언이 이 spy에 선다).
 */
interface FakeCharacterRepo {
  findById: ReturnType<typeof vi.fn<(id: string) => Promise<Character | null>>>
  hydrateInventory: ReturnType<typeof vi.fn<(id: string) => Promise<ObjectInstance[]>>>
  /**
   * SaveEngine dispatch가 characters 라우트로 호출한다. spy 하나가 호출 여부·순서·patch를 모두
   * 들고 있으므로 patch를 따로 보관하는 Map을 두지 않는다(파생 상태 중복 회피).
   */
  updateById: ReturnType<typeof vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>>
}

/** 삭제 write만 관측하는 fake object repo — 형제 스위트의 빈 `objectStub`을 대체한다. */
interface FakeObjectRepo {
  deleteById: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
}

function makeCharacterRepo(
  seed: Character,
  inventory: readonly ObjectInstance[],
  writeOrder: WriteRoute[],
): FakeCharacterRepo {
  return {
    findById: vi.fn<(id: string) => Promise<Character | null>>((id) =>
      Promise.resolve(id === seed._id ? seed : null),
    ),
    hydrateInventory: vi.fn<(id: string) => Promise<ObjectInstance[]>>((id) =>
      Promise.resolve(id === seed._id ? [...inventory] : []),
    ),
    updateById: vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>(() => {
      writeOrder.push('characters')
      return Promise.resolve()
    }),
  }
}

function makeObjectRepo(writeOrder: WriteRoute[]): FakeObjectRepo {
  return {
    deleteById: vi.fn<(id: string) => Promise<void>>(() => {
      writeOrder.push('objectDeletions')
      return Promise.resolve()
    }),
  }
}

/** 학습 통합 하네스 — app·묶음·월드 그래프·저장 엔진·두 fake repo를 한 번에 조립한다. */
interface StudyHarness {
  app: FastifyInstance
  room: RoomNode
  liveRegistry: LiveCharacterRegistry
  characterRepo: FakeCharacterRepo
  objectRepo: FakeObjectRepo
  saveEngine: SaveEngine
  /** repo에 도달한 write의 시도 순서(라우트 태그 시퀀스). */
  writeOrder: WriteRoute[]
}

/**
 * 라이브 월드 묶음을 실 SaveEngine에 결선한 app을 만든다.
 *
 * 형제 스위트와 두 곳이 다르다:
 *  1. `objectTemplates`가 정본 인덱스다(합성 빈 Map이 아니다) — 이 파일의 존재 이유(위 헤더 참조).
 *  2. objects repo가 빈 stub이 아니라 `deleteById`를 관측하는 fake다 — 학습이 유발하는 두 번째 write가
 *     실제로 repo까지 도달하는지, 그리고 어느 순서로 도달하는지를 여기서만 볼 수 있다.
 *
 * bank/world repo는 이 흐름에서 미사용이라 최소 stub을 캐스트로 채운다(형제 스위트 관례 미러).
 */
function buildHarness(): StudyHarness {
  const room = makeRoom({ roomId: ROOM_STUDY })
  const worldGraph = new Map<number, RoomNode>([[ROOM_STUDY, room]])

  const writeOrder: WriteRoute[] = []
  const characterRepo = makeCharacterRepo(makeCharacter(), [makeBookInstance()], writeOrder)
  const objectRepo = makeObjectRepo(writeOrder)

  // SaveEngine — FakeClock + 즉시 backoff. 주기 tick이 발화하지 않으므로 flush 시점은 오직
  // `shutdown()`의 강제 flush뿐이고, 그 덕에 "study 마킹 → 종료 마킹"이 **한 flush 안에서** 드레인돼
  // 순서 계약(markDirty 호출 순서 = write 시도 순서)이 그대로 관측된다.
  const bankStub = {} as unknown as BankRepository
  const worldStub = {} as unknown as WorldRepository
  const saveEngine = new SaveEngine(
    characterRepo as unknown as CharacterRepository,
    bankStub,
    worldStub,
    objectRepo as unknown as ObjectRepository,
    NOOP_LOGGER,
    { clock: new FakeClock(), queueOptions: { sleep: () => Promise.resolve() } },
  )
  saveEngine.start()

  const liveRegistry = createLiveCharacterRegistry()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: (id) => characterRepo.findById(id),
      hydrateInventory: (id) => characterRepo.hydrateInventory(id),
    },
    // 정본 인덱스 — boot(`index.ts`)가 싣는 것과 같은 `loadObjectTemplates()` 산출물이다.
    objectTemplates: OBJECT_TEMPLATES,
    markDirty: (collection, id, snapshot) => saveEngine.markDirty(collection, id, snapshot),
    peekPending: (collection, id) => saveEngine.peekPending(collection, id),
    // 이 흐름은 currentHour를 소비하지 않는다(학습 경로에 방·시간 게이트가 없다) — 묶음 필수 필드
    // 충족용이다. 형제 스위트에서는 이 값이 이동 시간 게이트의 실 입력이라 의미가 다르다.
    currentHour: () => 12,
    // P-flag 합성 시점 seam. 고정 틱을 쓴다 — 시드 캐릭터에 statusEffects·buffs가 없어 어떤 틱에서도
    // 합성 결과는 all-zero hex이고(PBLIND 미세팅 → 실명 게이트 통과), 그 사실을 시간에서 분리한다.
    now: () => 0,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  }

  const sessionAuth = new InMemorySessionAuthAdapter({
    cookieToAccount: { [COOKIE]: ACCOUNT },
    characters: {
      [ACCOUNT]: [
        { characterId: CHAR, name: '무한도사', class: CHAR_CLASS, race: 1, level: CHAR_LEVEL },
      ],
    },
  })

  const app = buildApp({ sessionAuth, liveWorldDeps: bundle })
  return { app, room, liveRegistry, characterRepo, objectRepo, saveEngine, writeOrder }
}

/**
 * 소켓을 connect→hello→ready→characterList→prompt→selectCharacter→entered→world:room까지 왕복시킨다
 * (형제 스위트 `enterWorld` 미러 — 배치가 발화하는 여분 `world:room` 프레임을 명시 소비한다).
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
  const entered = await reader.next() // session:entered
  const room = await reader.next() // world:room(배치 통지)
  return { reader, entered, room }
}

describe('학습 end-to-end (실 소켓 · 정본 템플릿 인덱스)', () => {
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
    // 형제 스위트의 정리 순서를 그대로 따른다 — 클라이언트를 먼저 닫고, app close 전에
    // markShuttingDown→converge로 등록 바인딩을 종결해 grace·idle 타이머 재-arm을 차단한다.
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

  function trackedClient(url: string): WebSocket {
    const client = newAuthedClient(url, { cookie: COOKIE })
    clients.push(client)
    return client
  }

  it('정본 objects.json이 시드 비법서를 연마 가능한 SCROLL로 싣는다', () => {
    // 시나리오의 전제를 정본 데이터에 대해 직접 고정한다 — 데이터가 바뀌면 아래 시나리오가 알 수 없는
    // 이유로 깨지는 대신 여기가 먼저 터져 원인을 가리킨다.
    expect(BOOK_TEMPLATE).toBeDefined()
    expect(BOOK_TEMPLATE?.type).toBe(SCROLL)
    // ③ 레벨 게이트 — 경계값 등호로 통과한다(`ndice > level`이 거부 조건).
    expect(BOOK_TEMPLATE?.ndice).toBe(CHAR_LEVEL)
    // ⑥ 주문 존재 게이트 — magicpower-1이 카탈로그 멤버다.
    expect(BOOK_TEMPLATE?.magicpower).toBe(BOOK_SPELL_NO + 1)
    expect(spellByNo(BOOK_SPELL_NO)).toBeDefined()
    // ④⑤ 정렬·클래스 게이트와 소지품 가시성 게이트가 모두 미발화하는 flags다.
    const flags = BOOK_TEMPLATE?.flags ?? ''
    expect(F_ISSET(flags, OGOODO)).toBe(false)
    expect(F_ISSET(flags, OEVILO)).toBe(false)
    expect(F_ISSET(flags, OCLSEL)).toBe(false)
    expect(F_ISSET(flags, OINVIS)).toBe(false)
  })

  it('진입→인벤 적재→연마→통지→영속화를 관통하고, 종료 재마킹을 지나서도 characters가 먼저 write된다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    // ── 1) 진입 — 캐릭터가 방에 배치된다. ──────────────────────────────────────────
    const client = trackedClient(url)
    const s = await enterWorld(client, CHAR)
    expect(s.entered).toMatchObject({ type: 'session:entered', characterId: CHAR })
    expect(s.room).toMatchObject({ type: 'world:room', roomId: ROOM_STUDY })
    await waitFor(() => h.room.occupants.has(CHAR))

    // ── 2) 인벤 적재 — 진입이 소지품을 라이브 엔트리에 실었다(진입당 1회). ────────────
    expect(h.characterRepo.hydrateInventory).toHaveBeenCalledTimes(1)
    expect(h.liveRegistry.get(CHAR)?.inventory).toHaveLength(1)
    expect(h.liveRegistry.get(CHAR)?.inventory[0]?._id).toBe(BOOK_INSTANCE_ID)

    // ── 3) 연마 — 정본 이름으로 지목한다. 이 이름은 합성 픽스처가 아니라 objects.json의 값이다. ──
    const bookName = BOOK_TEMPLATE?.name ?? ''
    client.send(JSON.stringify({ type: 'progress:study', target: bookName, id: 'st1' }))

    // ── 4) 통지 — progress:studied가 시드한 주문번호·인스턴스 id를 그대로 싣는다. ────────
    const studied = await s.reader.next()
    expect(studied).toMatchObject({
      type: 'progress:studied',
      spellNo: BOOK_SPELL_NO,
      spellName: spellByNo(BOOK_SPELL_NO)?.koreanName,
      consumedObjectId: BOOK_INSTANCE_ID,
    })
    // 상태 이벤트라 상관 키를 반향하지 않는다(progress:trained 선례).
    expect(studied).not.toHaveProperty('correlationId')

    // 라이브 상태도 함께 움직였다 — 지식 비트가 서고 소모된 비법서가 인벤에서 빠졌다.
    const live = h.liveRegistry.get(CHAR)
    expect(isKnown(live?.character.spells ?? [], BOOK_SPELL_NO)).toBe(true)
    expect(live?.inventory).toHaveLength(0)

    // ── 5) 영속화 — 서버 주도 수렴으로 onSessionEnd(markDirty→release)를 구동한 뒤 강제 flush. ──
    // 이 시나리오가 하위 층 테스트와 **다르게** 증명하는 것이 여기 있다. 종료 lifecycle이 characters를
    // **한 번 더** markDirty하므로, `save/saveEngine.ts` 헤더가 순서 계약의 전제로 명시한
    // "두 키가 모두 해당 flush에서 **처음** 마킹될 때"를 벗어난다. 그래도 순서가 살아남는 근거는
    // 코얼레싱이 최초 삽입 위치를 보존한다는 Map 의미론이고, 그 성질 자체는
    // `save/dirtyTracker.test.ts`가 자기 층에서 고정한다(여기가 유일한 감시자가 아니다).
    // 아래 `writeOrder` 단언이 그 재-mark 경로를 실 소켓 흐름에서 관통 확인한다.
    h.app.wsShutdown.markShuttingDown()
    h.app.wsShutdown.converge()
    await h.saveEngine.shutdown()

    // 두 write가 각 1회씩 도달했고 characters가 objectDeletions보다 **먼저**다.
    // `writeOrder`는 두 spy 안에서 push되므로 호출 횟수·순서를 한 단언에 담는다 — `invocationCallOrder`로
    // 다시 확인해도 같은 spy의 같은 호출을 보는 것이라 독립된 증거가 아니다(이중 관측하지 않는다).
    expect(h.writeOrder).toEqual(['characters', 'objectDeletions'])
    expect(h.objectRepo.deleteById).toHaveBeenCalledWith(BOOK_INSTANCE_ID)

    // 저장된 characters 스냅샷에 학습한 지식 비트가 실려 있다(load-time all-zero가 아니다).
    const saved = h.characterRepo.updateById.mock.calls.at(-1)?.[1]
    expect(isKnown(saved?.spells ?? [], BOOK_SPELL_NO)).toBe(true)
    expect(saved).toMatchObject({ currentRoom: ROOM_STUDY, level: CHAR_LEVEL })
  })

  it('소지하지 않은 이름을 지목하면 rule_rejected를 내고 두 write를 모두 유발하지 않는다', async () => {
    const h = buildHarness()
    const url = await startTracked(h.app)

    const client = trackedClient(url)
    const s = await enterWorld(client, CHAR)
    expect(s.entered).toMatchObject({ type: 'session:entered', characterId: CHAR })
    await waitFor(() => h.room.occupants.has(CHAR))

    // 정본 인덱스에 없는 이름이 아니라 **소지하지 않은** 이름을 지목한다 — 해소자 스코프가 소지품임을
    // 검출하려면 질의가 인덱스 밖이면 안 된다(인덱스 밖 이름은 스코프와 무관하게 실패한다).
    client.send(JSON.stringify({ type: 'progress:study', target: '단도', id: 'st-fail' }))

    const rejected = await s.reader.next()
    expect(rejected).toMatchObject({
      type: 'error',
      code: 'rule_rejected',
      correlationId: 'st-fail',
    })

    // 강제 flush로 tracker 잔여를 큐까지 밀어낸다. 여기서 세션 종료 수렴을 **일부러 돌리지 않는다** —
    // 종료 lifecycle은 성공/실패와 무관하게 characters를 markDirty하므로, 그것까지 포함하면 이 단언이
    // "거부는 write를 유발하지 않는다"가 아니라 "종료가 write를 유발한다"를 보게 된다.
    await h.saveEngine.shutdown()

    // 빈 배열은 "flush가 안 돌았다"가 아니라 "아무것도 스테이징되지 않았다"를 뜻한다 — 위에서
    // `shutdown()`이 tracker를 강제 드레인했고, 핸들러가 동기라 거부 프레임 수신 시점에 마킹이
    // 있었다면 이미 tracker에 들어와 있다.
    expect(h.writeOrder).toEqual([])

    // 라이브 상태도 무변이다 — 비법서가 인벤에 남고 지식 비트도 서지 않는다.
    const live = h.liveRegistry.get(CHAR)
    expect(live?.inventory).toHaveLength(1)
    expect(isKnown(live?.character.spells ?? [], BOOK_SPELL_NO)).toBe(false)
  })
})
