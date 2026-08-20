import { expect, vi } from 'vitest'
import {
  characterSchema,
  objectSchema,
  isKnown,
  neededExp,
  type Character,
  type ClientCommand,
  type ObjectInstance,
  type RoomNode,
  type ServerEvent,
} from 'shared'
import { SaveEngine } from '../save/saveEngine.js'
import { OBJECT_DELETIONS_COLLECTION } from '../save/markObjectDeleted.js'
import type { SaveLogger } from '../save/logger.js'
import { normalizeHandlerEvents } from './router.js'
import { FakeClock } from '../util/clock.testutil.js'
import { DocumentNotFoundError } from '../repo/types.js'
import { characterPatchSchema } from '../repo/characterRepository.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
import type { ObjectRepository } from '../repo/objectRepository.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { CHARACTERS_COLLECTION } from '../world/markCharacterDirty.js'
import { makeRoom, makeExitTo } from '../world/roomFixtures.testutil.js'
import { trainingFlagsForClass } from '../progression/train.testutil.js'
import { goldToTrain } from '../progression/train.js'
import { loadObjectTemplates, type ObjectTemplate } from '../items/objectTemplate.js'
import { SCROLL } from '../items/taxonomy.js'
import { createStudyHandler } from './handlers/study.js'
import { createTrainHandler } from './handlers/train.js'
import { createMoveHandler } from './handlers/move.js'
import { createLiveWorldWiring } from './liveWorldWiring.js'
import type { LiveWorldWiring, LiveWorldWiringBundle } from './liveWorldWiring.js'
import type { ActorContext } from './actorContext.js'

/**
 * #124 회귀 스위트가 공유하는 시드·픽스처·하네스 — `reconnectRevert.regression.test.ts`와
 * `reconnectRevert.settleFailure.regression.test.ts`가 여기서 가져다 쓴다.
 *
 * ## 왜 소켓을 쓰지 않는가
 * 하네스 골격(실 `SaveEngine` + `FakeClock` + 페이크 repo + `LiveWorldWiringBundle` 리터럴)은 형제
 * 스위트 `studyLiveWorld.e2e.test.ts`를 그대로 미러하되, transport(실 TCP 소켓)는 싣지 않는다. 이
 * 스위트가 고정하려는 것은 **세이브 계층과 진입 코어 사이의 인터리빙**이라, 검증에 필요한 제어점이
 * 소켓 왕복이 아니라 (a) `lifecyclePort.onSessionEnd({reason:'graceExpired'})` 직접 구동, (b) 큐
 * backpressure·`findById` 지연의 게이트 고정, (c) `FakeClock` tick 시점이다. 소켓을 끼우면 그 세 축이
 * 전부 비결정 대기 뒤로 숨어 §8.4·§8.5를 "결정적으로" 구성할 수 없다.
 *
 * ## 소켓 관통은 어디가 덮는가 (경로별로 다르다 — 뭉뚱그리지 마라)
 * transport 일반(진입·이동·채팅·연마의 소켓 왕복)은 형제 두 e2e 스위트 `liveWorld.e2e.test.ts`·
 * `studyLiveWorld.e2e.test.ts`가 덮는다. 그러나 **이 스위트가 겨냥하는 결함 경로**(release → 재접속 →
 * pending overlay)의 소켓판은 그 일반 커버리지에 포함되지 않는다 — `liveWorld.e2e.test.ts`의 재접속
 * 케이스(`이동 후 재접속 시 라이브 상태(도착 방)를 보존하고 재로드하지 않는다`)는 엔트리가 레지스트리에
 * **살아 있는** grace 창 안의 rebind만 타므로 `hydrate`가 `peekPendingCharacter`를 부르는 지점에 도달조차
 * 하지 않는다(D-G 1 조기 반환).
 *
 * 그 공백은 `studyLiveWorld.e2e.test.ts`의 케이스
 * `grace 만료로 release된 뒤 flush 이전에 새 소켓으로 재접속해도 학습한 주문이 살아남는다`가 닫는다 —
 * grace 만료로 엔트리를 실제로 release시킨 뒤 새 소켓으로 재접속해 overlay 경로를 관통시킨다.
 *
 * ## 이 파일은 테스트 전용이다 — 프로덕션 코드를 바꾸지 않는다.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽
 * glob에서 자동 제외된다(테스트 인프라, 프로덕션 코드 아님).
 */

// ── 결정적 시드 ────────────────────────────────────────────────────────────────
export const ACCOUNT = 'revert-account'
export const CHAR = 'revert-char'
/** backpressure 케이스에서 큐를 점유할 filler 키 2개(캐릭터 문서로 둔다 — 어댑터를 추가하지 않는다). */
export const FILLER_A = 'revert-filler-a'
export const FILLER_B = 'revert-filler-b'

/** 출발 방 — 시드 캐릭터 클래스의 훈련방이다(§8.2 train이 여기서 발화한다). */
export const ROOM_TRAIN = 1
/** 도착 방 — all-zero flags라 이동 게이트 건틀릿을 통과한다. */
export const ROOM_DEST = 2
/** 두 방을 잇는 출구 이름(플래그 없음 = 모든 게이트 통과). */
export const EXIT_EAST = '동'

/** 캐릭터 class — MAGE(5). 훈련방 flags·세션 시드가 모두 이 상수에서 파생된다. */
export const CHAR_CLASS = 5
/** 캐릭터 레벨 — 시드 비법서 `ndice`(20)와 같게 잡아 study 레벨 게이트 경계(등호)를 통과시킨다. */
export const CHAR_LEVEL = 20

/** 시드 비법서 objnum — 정본 `objects.json`의 `혼동비서`(선정 근거는 형제 스위트 헤더 참조). */
export const BOOK_OBJNUM = 142
/** 시드 비법서가 담은 주문번호(`magicpower - 1`) — 카탈로그 12번. */
export const BOOK_SPELL_NO = 12
/** 시드 비법서 인스턴스 `_id` — objectDeletions 마킹·삭제 단언의 기준값이다. */
export const BOOK_INSTANCE_ID = 'revert-book-1'

/** 정본 템플릿 인덱스 — 파일당 1회 로드한다(읽기 전용, 206KB JSON). */
export const OBJECT_TEMPLATES = loadObjectTemplates()
export const BOOK_TEMPLATE: ObjectTemplate | undefined = OBJECT_TEMPLATES.get(BOOK_OBJNUM)

/** 세이브 키 — flush 종결 판정(`peekPending === undefined`)의 대상이다. */
export const KEY_CHARACTER: readonly [string, string] = [CHARACTERS_COLLECTION, CHAR]
export const KEY_BOOK: readonly [string, string] = [OBJECT_DELETIONS_COLLECTION, BOOK_INSTANCE_ID]
export const KEY_FILLER_A: readonly [string, string] = [CHARACTERS_COLLECTION, FILLER_A]
export const KEY_FILLER_B: readonly [string, string] = [CHARACTERS_COLLECTION, FILLER_B]

/** 명령 디스패치용 actor — 라우터가 command 상태에서 만드는 것과 같은 최소 형태다. */
export const ACTOR: ActorContext = { accountId: ACCOUNT, characterId: CHAR }

/**
 * 시드 캐릭터가 실을 필수 필드 키 집합(`_id`·`status` 제외).
 *
 * `peekPending`이 돌려주는 실 스냅샷의 키 집합을 여기에 **정확히** 대조한다(§8.10 케이스 3의 앵커).
 * `snapshotCharacter`가 스키마 밖 키를 하나 더 싣기 시작하면 `characterPatchSchema`(strict)가 patch를
 * 거부하는데, 그 거부는 hydrate에서 `stored` 폴백으로 조용히 흡수된다 — 여기가 먼저 터져 원인을 가리킨다.
 * `_id`는 `peekPending`·flush 어댑터가 공유하는 `stripImmutableId`가 벗기고, `status`는 라이브가 소유하지
 * 않는 필드라 `snapshotCharacter`가 애초에 싣지 않는다.
 */
export const SNAPSHOT_KEYS = [
  'accountId',
  'alignment',
  'class',
  'currentRoom',
  'experience',
  'gold',
  'hpCurrent',
  'level',
  'mpCurrent',
  'name',
  'race',
  'realm',
  'schemaVersion',
  'spells',
  'stats',
].sort()

// ── 픽스처 ────────────────────────────────────────────────────────────────────

/**
 * 최소 유효 Character 문서. `characterSchema.parse`를 통과시켜 만든다 — 리터럴을 그대로 쓰면 스키마가
 * 거부할 시드로도 시나리오가 통과해(페이크 repo는 로드 시 검증하지 않는다) 배선 검출력이 떨어진다.
 *
 * exp·gold는 정확히 1레벨분만 싣는다(`neededExp`/`goldToTrain` 재유도 금지 — 임계의 단일 출처는
 * 그 두 함수다). 배치 do-while이 두 번째 반복에서 gold 부족으로 종료하므로 `levelsGained`가 결정적으로 1이다.
 */
export function makeCharacter(overrides: Partial<Character> = {}): Character {
  return characterSchema.parse({
    _id: CHAR,
    name: '테스토스',
    class: CHAR_CLASS,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: goldToTrain(CHAR_LEVEL),
    currentRoom: ROOM_TRAIN,
    hpCurrent: 42,
    mpCurrent: 15,
    level: CHAR_LEVEL,
    experience: neededExp(CHAR_LEVEL),
    // 지식 비트가 전부 0인 상태에서 출발한다 — 연마 후 12번 비트만 서는 것을 단언한다.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: ACCOUNT,
    status: 'active',
    alignment: 1,
    ...overrides,
  })
}

/** 시드 비법서 인스턴스 — `objectSchema.parse`로 형상 계약을 런타임에 강제한다(형제 스위트 관례). */
export function makeBookInstance(): ObjectInstance {
  return objectSchema.parse({
    _id: BOOK_INSTANCE_ID,
    objnum: BOOK_OBJNUM,
    type: SCROLL,
    owner: { type: 'character', id: CHAR },
    slot: null,
    equipped: false,
    value: BOOK_TEMPLATE?.value ?? 0,
    shotscur: 1,
    schemaVersion: 1,
  })
}

// ── 결정적 게이트 ─────────────────────────────────────────────────────────────

/** 수동 개방 게이트 — `setTimeout` 경합 대신 promise로 인터리빙을 고정한다. */
export interface Gate {
  readonly promise: Promise<void>
  open(): void
}

export function makeGate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

/** 페이크 repo의 지연·실패 주입 손잡이. 케이스별로 필요한 것만 켠다. */
export interface Controls {
  /** 세팅되면 `findById`가 **문서를 캡처한 뒤** 이 게이트에서 대기한다(스냅샷 격리 모델). */
  findByIdGate: Gate | null
  /** id별 write 게이트 — 해당 캐릭터 write가 어댑터 진입 직후 대기한다. */
  readonly writeGates: Map<string, Gate>
  /** id별 write 실패 주입 — 어댑터가 이 에러를 던진다(permanent 분류 확인용). */
  readonly writeFailures: Map<string, Error>
}

// ── 페이크 repo ───────────────────────────────────────────────────────────────

export interface FakeCharacterRepo {
  findById: ReturnType<typeof vi.fn<(id: string) => Promise<Character | null>>>
  hydrateInventory: ReturnType<typeof vi.fn<(id: string) => Promise<ObjectInstance[]>>>
  updateById: ReturnType<typeof vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>>
}

export interface FakeObjectRepo {
  deleteById: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
}

/**
 * 인메모리 문서 저장소 + 페이크 repo.
 *
 * `findById`는 **호출 시점에 문서를 캡처한 뒤** 게이트를 기다린다. 실 DB 읽기의 스냅샷 격리를 그대로
 * 옮긴 것이며, §8.5가 성립하는 근거다 — 읽기가 커밋 이전에 발행됐다면 그 사이 완료된 write는 결과에
 * 보이지 않는다. 게이트 뒤에서 `docs.get`을 다시 읽으면 TOCTOU 창이 사라져 시나리오가 vacuous해진다.
 *
 * `updateById`는 실 repo 경계를 미러해 `characterPatchSchema.parse`를 통과시킨다 — 스냅샷이 strict
 * 스키마를 통과하지 못하면 여기서 ZodError가 나 permanent 폐기로 이어지고, 그 폐기가 곧 진행도 손실이다.
 */
export function createFakeRepos(controls: Controls): {
  docs: Map<string, Character>
  objects: Map<string, ObjectInstance>
  characterRepo: FakeCharacterRepo
  objectRepo: FakeObjectRepo
} {
  const docs = new Map<string, Character>()
  const objects = new Map<string, ObjectInstance>()

  const characterRepo: FakeCharacterRepo = {
    findById: vi.fn<(id: string) => Promise<Character | null>>(async (id) => {
      const doc = docs.get(id)
      const captured = doc === undefined ? null : structuredClone(doc)
      if (controls.findByIdGate !== null) await controls.findByIdGate.promise
      return captured
    }),
    hydrateInventory: vi.fn<(id: string) => Promise<ObjectInstance[]>>((id) =>
      Promise.resolve(
        [...objects.values()]
          .filter((obj) => obj.owner.type === 'character' && obj.owner.id === id)
          .sort((a, b) => a._id.localeCompare(b._id)),
      ),
    ),
    updateById: vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>(
      async (id, patch) => {
        const gate = controls.writeGates.get(id)
        if (gate !== undefined) await gate.promise
        const failure = controls.writeFailures.get(id)
        if (failure !== undefined) throw failure
        // 실 CharacterRepository.updateById와 같은 검증 경계다(스냅샷 형태 계약을 런타임에 강제).
        const validated = characterPatchSchema.parse(patch)
        const current = docs.get(id)
        if (current === undefined) throw new DocumentNotFoundError(CHARACTERS_COLLECTION, id)
        docs.set(id, { ...current, ...validated })
      },
    ),
  }

  const objectRepo: FakeObjectRepo = {
    deleteById: vi.fn<(id: string) => Promise<void>>(async (id) => {
      if (!objects.delete(id)) throw new DocumentNotFoundError('objects', id)
      await Promise.resolve()
    }),
  }

  return { docs, objects, characterRepo, objectRepo }
}

// ── 하네스 ────────────────────────────────────────────────────────────────────

/** `peekPending` 호출 관측 1건 — 호출 시점의 반환값과 라이브 등록 여부를 함께 붙든다. */
export interface PeekObservation {
  readonly collection: string
  readonly id: string
  readonly value: unknown
  /** 이 조회 시점에 해당 id가 라이브 레지스트리에 있었는가(= 그 캐릭터의 writer가 존재하는가). */
  readonly liveRegistered: boolean
}

export interface Harness {
  readonly clock: FakeClock
  readonly saveEngine: SaveEngine
  readonly liveRegistry: LiveCharacterRegistry
  readonly worldGraph: Map<number, RoomNode>
  readonly docs: Map<string, Character>
  readonly objects: Map<string, ObjectInstance>
  readonly characterRepo: FakeCharacterRepo
  readonly objectRepo: FakeObjectRepo
  readonly controls: Controls
  readonly wiring: LiveWorldWiring
  readonly logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  readonly saveLogger: { error: ReturnType<typeof vi.fn> }
  /** hydrate 내부 두 조회의 실제 발화 순서(`peekPending` → `findById` 선형화 지점 확인용). */
  readonly callOrder: string[]
  readonly peekLog: PeekObservation[]
  readonly study: (command: ClientCommand) => ServerEvent | undefined
  readonly train: (command: ClientCommand) => ServerEvent | undefined
  readonly move: (command: ClientCommand) => ServerEvent | undefined
}

/**
 * 실 `SaveEngine`에 결선한 라이브 월드 묶음을 조립한다.
 *
 * `createLiveWorldWiring`을 그대로 통과시키므로 `markCharacterDirty`(실 `snapshotCharacter`)·
 * `peekPendingCharacter`(`'characters'` 1회 좁힘)·`entry`·`lifecyclePort`가 전부 프로덕션과 같은
 * 파생 경로로 만들어진다. 이 스위트가 손으로 만든 pending 리터럴을 쓰지 않는 근거가 여기다.
 */
export function buildHarness(options: { capacity?: number } = {}): Harness {
  const controls: Controls = {
    findByIdGate: null,
    writeGates: new Map<string, Gate>(),
    writeFailures: new Map<string, Error>(),
  }
  const { docs, objects, characterRepo, objectRepo } = createFakeRepos(controls)

  docs.set(CHAR, makeCharacter())
  docs.set(FILLER_A, makeCharacter({ _id: FILLER_A }))
  docs.set(FILLER_B, makeCharacter({ _id: FILLER_B }))
  objects.set(BOOK_INSTANCE_ID, makeBookInstance())

  const trainRoom: RoomNode = {
    ...makeRoom({ roomId: ROOM_TRAIN, exits: [makeExitTo(EXIT_EAST, ROOM_DEST)] }),
    flags: trainingFlagsForClass(CHAR_CLASS),
  }
  const destRoom = makeRoom({ roomId: ROOM_DEST })
  const worldGraph = new Map<number, RoomNode>([
    [ROOM_TRAIN, trainRoom],
    [ROOM_DEST, destRoom],
  ])

  const clock = new FakeClock()
  const saveLogger = { error: vi.fn() }
  const saveEngine = new SaveEngine(
    characterRepo as unknown as CharacterRepository,
    {} as unknown as BankRepository,
    {} as unknown as WorldRepository,
    objectRepo as unknown as ObjectRepository,
    saveLogger satisfies SaveLogger,
    {
      clock,
      // backoff를 즉시 resolve로 대체해 재시도 경로가 실타이머에 기대지 않게 한다.
      queueOptions: { sleep: () => Promise.resolve(), capacity: options.capacity },
    },
  )

  const liveRegistry = createLiveCharacterRegistry()
  const logger = { warn: vi.fn(), error: vi.fn() }
  const callOrder: string[] = []
  const peekLog: PeekObservation[] = []

  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: (id) => {
        callOrder.push(`findById:${id}`)
        return characterRepo.findById(id)
      },
      hydrateInventory: (id) => characterRepo.hydrateInventory(id),
    },
    objectTemplates: OBJECT_TEMPLATES,
    markDirty: (collection, id, snapshot) => saveEngine.markDirty(collection, id, snapshot),
    // 관측만 얹고 값은 손대지 않는다 — hydrate가 보는 pending과 테스트가 보는 pending이 같은 객체다.
    peekPending: (collection, id) => {
      callOrder.push(`peekPending:${collection}:${id}`)
      const value = saveEngine.peekPending(collection, id)
      peekLog.push({ collection, id, value, liveRegistered: liveRegistry.get(id) !== undefined })
      return value
    },
    currentHour: () => 12,
    now: () => 0,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger,
  }

  const wiring = createLiveWorldWiring(bundle)
  const studyHandler = createStudyHandler(wiring.studyDeps)
  const trainHandler = createTrainHandler(wiring.trainDeps)
  const moveHandler = createMoveHandler(wiring.moveDeps)

  return {
    clock,
    saveEngine,
    liveRegistry,
    worldGraph,
    docs,
    objects,
    characterRepo,
    objectRepo,
    controls,
    wiring,
    logger,
    saveLogger,
    callOrder,
    peekLog,
    // 이 하네스는 dispatch를 거치지 않고 핸들러를 직접 부르므로 정규화를 직접 한다. 캐스트로 좁히지
    // 않는 것이 load-bearing이다 — 캐스트는 "이 핸들러는 이벤트를 하나만 낸다"는 단언인데, 성장 명령이
    // 스탯 통지를 덧붙이는 순간 거짓이 된다. 첫 이벤트를 집는 것이 이 하네스가 뜻하는 바다(도메인 이벤트).
    study: (command) => normalizeHandlerEvents(studyHandler(command, ACTOR))[0],
    train: (command) => normalizeHandlerEvents(trainHandler(command, ACTOR))[0],
    move: (command) => normalizeHandlerEvents(moveHandler(command, ACTOR))[0],
  }
}

// ── 결정적 진행 헬퍼 ───────────────────────────────────────────────────────────

/** 매크로태스크 1회 양보 — 백그라운드 워커·마이크로태스크 pump를 진행시킨다. */
export const barrier = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 조건이 성립할 때까지 배리어를 돈다. 고정 대기(sleep N ms)를 쓰지 않으므로 느린 CI에서 조용히
 * 통과하거나 실패하지 않고, 상한을 넘으면 **크게 던진다**(무성 통과 금지).
 */
export async function waitUntil(
  predicate: () => boolean,
  what: string,
  rounds = 200,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return
    await barrier()
  }
  throw new Error(`waitUntil 시간 초과: ${what}`)
}

/**
 * 지정 키가 전부 종결(`peekPending === undefined`)될 때까지 tick + 배리어를 반복한다.
 *
 * 한 번의 tick으로 끝나지 않는 이유는 두 가지다 — (a) flush 진행 중 tick은 re-entrancy 플래그로
 * no-op이고, (b) 이동 마킹처럼 앞선 flush 이후 도착한 스냅샷은 다음 checkout이 있어야 나간다.
 * 종결 판정을 `peekPending`으로 하므로 "몇 번 tick하면 되는가"를 추측하지 않는다.
 */
export async function flushUntilSettled(
  h: Harness,
  keys: readonly (readonly [string, string])[],
  rounds = 200,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (keys.every(([collection, id]) => h.saveEngine.peekPending(collection, id) === undefined)) {
      return
    }
    h.clock.tick()
    await barrier()
  }
  throw new Error('flushUntilSettled 시간 초과 — 큐가 종결되지 않았다')
}

/** 첫 세션 진입(hydrate → place). */
export async function enterSession(h: Harness): Promise<void> {
  const live = await h.wiring.liveWorldBinding.entry.hydrate(CHAR)
  h.wiring.liveWorldBinding.entry.place(live)
}

/**
 * grace 만료 비정상 종료(§8.12) — 정상 로그아웃이 아니라 이 사유로만 시나리오를 연다.
 *
 * 다만 `createLiveSessionLifecycleAdapter`는 `ctx.reason`을 읽지 않는다(그 파일이 스스로 명시한다).
 * 따라서 이 고정은 경로 **이름** 수준이며, 어떤 단언도 graceExpired를 정상 로그아웃과 구별하지
 * 못한다. reason 분기가 존재한다고 읽고 "보존"하려 들지 마라.
 */
export function expireGrace(h: Harness): void {
  h.wiring.lifecyclePort.onSessionEnd({
    accountId: ACCOUNT,
    characterId: CHAR,
    reason: 'graceExpired',
  })
}

/** 비법서를 연마해 주문을 학습한다(`characters`·`objectDeletions` 두 키를 교차 마킹). */
export function studyBook(h: Harness): ServerEvent | undefined {
  return h.study({ type: 'progress:study', target: BOOK_TEMPLATE?.name ?? '' })
}

/** 라이브 캐릭터가 시드 주문을 알고 있는가. */
export function liveKnowsSpell(h: Harness): boolean {
  return isKnown(h.liveRegistry.get(CHAR)?.character.spells ?? [], BOOK_SPELL_NO)
}

/** 영속 문서가 시드 주문을 알고 있는가. */
export function storedKnowsSpell(h: Harness): boolean {
  return isKnown(h.docs.get(CHAR)?.spells ?? [], BOOK_SPELL_NO)
}

/**
 * overlay가 **조용히** 폴백하지 않았음을 고정한다.
 *
 * `hydrate`는 pending 검증 실패를 던지지 않고 `logger.error` 1건만 남긴 뒤 저장소 문서를 쓴다. 그
 * 폴백은 진행도를 잃으면서도 예외를 내지 않으므로, 회귀가 "통과했는데 실은 보장이 꺼져 있었다"가 되지
 * 않으려면 로그 0건을 함께 봐야 한다.
 */
export function expectNoSilentFallback(h: Harness): void {
  expect(h.logger.error).not.toHaveBeenCalled()
}
