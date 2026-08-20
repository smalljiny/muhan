import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  type Character,
  type CreatureInstance,
  type RoomNode,
  type ServerEvent,
} from 'shared'
import { buildApp } from '../app.js'
import { resetConfigForTests } from '../config/env.js'
import { InMemorySessionAuthAdapter } from '../auth/inMemorySessionAuthAdapter.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { makeCharacter } from '../world/characterFixtures.testutil.js'
import { makeCreature, makeRoom } from '../world/roomFixtures.testutil.js'
import { createWorldRuntime } from '../world/worldRuntime.js'
import { WorldClock } from '../world/worldClock.js'
import { ATTACK_COOLDOWN_INTERVAL } from '../combat/constants.js'
import { hitThreshold, playerBaseDamage } from '../combat/attackStats.js'
import { toCombatant } from '../combat/combatant.js'
import { assemblePlayerCombatState, type PlayerCombatState } from '../combat/index.js'
import { minRollRng, maxRollRng } from '../combat/dice.testutil.js'
import { F_ISSET, PBLIND, PFEARS } from '../world/hexFlags.js'
import { SaveEngine } from '../save/saveEngine.js'
import { NOOP_LOGGER } from '../save/logger.js'
import { FakeClock } from '../util/clock.testutil.js'
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

// Story 9 — 공격(combat:attack) end-to-end 통합. 형제 스위트 `liveWorld.e2e.test.ts`(이동·채팅·연마)·
// `studyLiveWorld.e2e.test.ts`(학습)와 같은 하네스 골격을 쓰되, **진입 → 지목 → 타격 → 통지 → 처치 →
// 보상**의 한 흐름만 남긴다. 계층별 단위 테스트(Story 1~8)는 각 seam을 고정했지만 그 사이의 결선이
// 실제로 이어졌는지는 증명하지 못한다 — 이 파일이 실 TCP 소켓 1개로 그 결선을 관통시킨다.
//
// ## 이 스위트가 **단독으로** 닫는 구멍 — plugin.ts의 조립 한 줄
// Story 7 시점에 `ws/plugin.ts`의 `attack: wiring.attackDeps` 한 줄을 지워도 전 스위트가 통과했다.
// `liveWorldWiring.test.ts`는 `attackDeps`가 **조립되는지**를 보고, `handlers/attack.test.ts`는 그 deps로
// 핸들러가 **동작하는지**를 보지만, 둘 사이의 등록(`createCommandRegistry`의 attack 필드)을 지나는
// 테스트가 없었다. 이 e2e가 실 소켓으로 그 줄을 관통하므로, 줄이 사라지면 아래 시나리오가 첫
// `combat:attacked` 대신 `error{unknown_type}`을 받아 실패한다.
//
// ## 형제 스위트와의 두 번째 차이 — 실 월드 틱을 싣는다
// 형제 스위트는 `onRoomEntered`/`onRoomLeft`를 `vi.fn()` stub으로 채우고 월드 런타임을 조립하지 않는다.
// 이 스위트는 boot(`index.ts`)와 같이 `createWorldRuntime`을 세워 훅·`spawnTemplates`·`alloc`을 그
// 산출물에서 가져오고(사망 seam이 실제로 소비하는 원재료다), `WorldClock`에 슬롯을 등록해 1Hz 틱을
// 수동 구동한다. 그래야 "월드 틱이 도는데도 몬스터가 반격하지 않는다"(#99가 이 토픽 밖)를 회귀로
// 잠글 수 있다 — 틱이 아예 없으면 그 단언은 공허하다.
//
// ⚠ 여기서도 boot의 묶음 조립 자체는 미검증이다 — 이 파일 역시 `LiveWorldWiringBundle` 리터럴을 자체
// 구성하므로, boot가 각 필드에 무엇을 싣는지는 검출되지 않는다(`index.ts`는 커버리지 제외 배선 코드라
// 설계상 그렇다).
//
// 이 파일은 테스트 전용이다 — 프로덕션 코드를 바꾸지 않는다.

// ── 결정적 인증 시드(1계정·1쿠키·1캐릭터) ────────────────────────────────────
const COOKIE = 'attack-e2e-cookie'
const ACCOUNT = 'attack-e2e-account'
const CHAR = 'attack-e2e-char'

/** 유일한 방(전투장). 출구가 없어 이동 게이트가 시나리오에 개입하지 않는다. */
const ROOM_ARENA = 1

// ── 결정성 확보 (★ 이 스위트의 설계 핵심) ────────────────────────────────────
//
// 전투 판정은 `rng`를 탄다. 그런데 `createLiveWorldWiring`이 `rng: defaultCombatRng`를 **하드코딩**해
// 싣고(`liveWorldWiring.ts`), `LiveWorldWiringBundle`에는 굴림 seam 필드가 없다 — 즉 묶음을 통해
// rng를 주입할 경로가 프로덕션에 존재하지 않는다.
//
// 그래서 묶음에 테스트용 optional 필드를 새로 뚫지 않고 **입력 스탯으로 결과를 강제**한다. 프로덕션
// 표면을 넓히지 않는 쪽이 싸고, 아래 값들이 어느 굴림에서도 같은 결과를 내는 근거는 첫 it()이
// **프로덕션 공식**(`hitThreshold`·`playerBaseDamage`)을 직접 호출해 단언한다 — 테이블만 대조하면
// 공식이 바뀔 때 이 전제가 조용히 무너진다. 확률에 기대는 단언은 이 파일에 하나도 없다.
//
//   ① 명중 — `hitThreshold = thaco - trunc(defender.armor/8)`이고 `rng(1,30) < threshold`가 빗나감이다
//      (`combat/attackStats.ts`·`resolveAttack.performStrike`). 크리처 armor를 크게 잡아 threshold를
//      1 이하로 눌러 두면 굴림 최솟값 1에서도 명중한다.
//   ② 피해 — 맨손(`weapon === null`)이면 숙련 p=0이라 크리 굴림 `rng(1,100) <= 0`이 항상 거짓이고,
//      불발 굴림은 무기 착용 시에만 소비된다. 다중공격은 `multiAttackCount`가 초인(class 9)·초과
//      클래스에서만 2 이상이라 class 5는 **PUPDMG를 갖고 있어도** 항상 1타다. 남는 것은
//      `mdice(class_stats[class]) + bonus[strength]`뿐이라 값역이 닫힌 구간이 된다.
//   ③ 그 닫힌 구간을 크리처 hp 양쪽에 둔다 — 생존 시나리오는 hp를 최대 피해보다 크게, 처치 시나리오는
//      hp를 최소 피해보다 작게 잡는다.

/** 캐릭터 class — MAGE(5). 맨손 피해 값역이 `class_stats[5]`(1d3)로 좁아 ③의 여유가 가장 크다. */
const CHAR_CLASS = 5
/** 캐릭터 레벨 — THAC0 조회(circle = trunc((level+3)/4))의 입력. */
const CHAR_LEVEL = 20
/** 능력치 튜플: strength0·dexterity1·constitution2·intelligence3·piety4. 힘은 피해·THAC0 양쪽 입력이다. */
const CHAR_STRENGTH = 16
const CHAR_STATS: [number, number, number, number, number] = [CHAR_STRENGTH, 18, 12, 10, 14]
/** 공격 전 경험치 — 처치 보상 단언의 기준선이다(0에서 출발해 증가를 관측한다). */
const CHAR_EXPERIENCE = 0
/** 캐릭터 문서의 현재 HP — 반격 부재(T9.4) 단언의 기준값이다. */
const CHAR_HP = 42

/** 크리처 armor — ①을 성립시킨다(trunc(160/8)=20 ≥ 어떤 클래스의 THAC0 상한 20). */
const CREATURE_ARMOR = 160
/** 생존 시나리오 크리처 HP — ③의 위쪽(최대 피해보다 크다). */
const SURVIVOR_HP = 100
/** 처치 시나리오 크리처 HP — ③의 아래쪽(최소 피해보다 작다). */
const KILL_HP = 1
/**
 * 처치 시나리오 크리처의 보유 경험치. `hpmax === KILL_HP === 1`이라 분배식
 * `trunc(experience * damage / max(hpmax,1))`의 damage가 오버킬 캡으로 1이 되고, 기여자가 혼자라
 * 그룹킬 보너스도 없어 **정확히 이 값**이 적립된다(`combat/deathDistribution.ts`).
 */
const KILL_EXP = 500

/** 크리처 표시 이름 = 지목 질의. 방 목록·`combat:attacked.targetName`·질의가 모두 이 값을 쓴다. */
const CREATURE_NAME = '고블린'
/** 크리처 instanceId — `combat:attacked.targetInstanceId`·방 재투영 부재 단언의 기준값이다. */
const CREATURE_ID = `${ROOM_ARENA}:c0`

/** 시드 캐릭터 문서 — 공유 픽스처에 이 시나리오가 근거로 삼는 필드만 명시 override한다. */
function seedCharacter(): Character {
  return makeCharacter({
    _id: CHAR,
    accountId: ACCOUNT,
    currentRoom: ROOM_ARENA,
    class: CHAR_CLASS,
    level: CHAR_LEVEL,
    stats: CHAR_STATS,
    experience: CHAR_EXPERIENCE,
    hpCurrent: CHAR_HP,
  })
}

/**
 * 시드 캐릭터의 전투상태 — 명중·피해 값역을 **프로덕션 공식으로** 평가하는 데 쓴다.
 * 인벤을 비워 맨손으로 둔다(크리·불발·내구도 굴림이 전부 `weapon !== null` 게이트 뒤에 있다).
 */
function seedCombatState(): PlayerCombatState {
  return assemblePlayerCombatState({ character: seedCharacter(), inventory: [] }, new Map(), '')
}

/**
 * 라운드 피해의 값역 — `playerBaseDamage`를 굴림 하한·상한 stub으로 평가한 값이다.
 * 손으로 재구현하지 않는다(공식이 바뀌면 값이 따라 움직여야 시나리오가 흔들리지 않는다).
 */
const MIN_DAMAGE = playerBaseDamage(toCombatant(seedCombatState()), minRollRng)
const MAX_DAMAGE = playerBaseDamage(toCombatant(seedCombatState()), maxRollRng)

/** 생존 크리처 — 한 타격을 견딘다(T9.2·T9.4). */
function survivorCreature(): CreatureInstance {
  return makeCreature(CREATURE_ID, CREATURE_NAME, {
    armor: CREATURE_ARMOR,
    hpmax: SURVIVOR_HP,
    hpcur: SURVIVOR_HP,
    experience: KILL_EXP,
  })
}

/** 처치 크리처 — 어떤 굴림에서도 한 타격에 죽는다(T9.3). */
function killableCreature(): CreatureInstance {
  return makeCreature(CREATURE_ID, CREATURE_NAME, {
    armor: CREATURE_ARMOR,
    hpmax: KILL_HP,
    hpcur: KILL_HP,
    experience: KILL_EXP,
  })
}

/**
 * 로드(findById·hydrateInventory)와 flush(updateById)를 한 객체에 둔 fake character repo
 * (형제 스위트 미러). 인벤은 비어 있다 — 이 시나리오는 맨손 전투이고, 그 맨손 조건이 위 ②의 전제다.
 */
interface FakeCharacterRepo {
  findById: ReturnType<typeof vi.fn<(id: string) => Promise<Character | null>>>
  hydrateInventory: ReturnType<typeof vi.fn<(id: string) => Promise<never[]>>>
  updateById: ReturnType<typeof vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>>
}

function makeCharacterRepo(seed: Character): FakeCharacterRepo {
  return {
    findById: vi.fn<(id: string) => Promise<Character | null>>((id) =>
      Promise.resolve(id === seed._id ? seed : null),
    ),
    hydrateInventory: vi.fn<(id: string) => Promise<never[]>>(() => Promise.resolve([])),
    updateById: vi.fn<(id: string, patch: Partial<Character>) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  }
}

/** 공격 통합 하네스 — app·묶음·월드 그래프·월드 틱·저장 엔진·fake repo를 한 번에 조립한다. */
interface AttackHarness {
  app: FastifyInstance
  room: RoomNode
  liveRegistry: LiveCharacterRegistry
  characterRepo: FakeCharacterRepo
  saveEngine: SaveEngine
  worldClock: WorldClock
  /** 1Hz 월드 틱을 `seconds`초만큼 수동 진행시킨다(실타이머 없음 — FakeClock 구동). */
  advanceWorld(seconds: number): void
}

/**
 * 라이브 월드 묶음을 실 SaveEngine·실 월드 런타임에 결선한 app을 만든다.
 *
 * 형제 스위트와 다른 두 곳:
 *  1. `createWorldRuntime`을 세워 `onRoomEntered`/`onRoomLeft`·`spawnTemplates`·`alloc`을 그 산출물에서
 *     가져온다(boot `index.ts`의 조립 미러). 사망 seam이 소비하는 원재료라 stub으로 두면 처치 경로가
 *     프로덕션과 다른 인스턴스를 보게 된다 — `alloc`은 `createInstanceIdAllocator(worldGraph.values())`로
 *     방을 seed한 그 발급기다.
 *  2. `WorldClock`을 `FakeClock`으로 구동해 슬롯을 수동 진행시킨다. `now`도 boot와 같이
 *     `() => worldClock.currentTick()`이라 공격 쿨다운·틱·P-flag 만료가 **한 시각 도메인**을 공유한다.
 *
 * `objectTemplates`는 빈 인덱스다 — 시드 인벤이 비어 있어 페어링 대상이 없고(맨손 전제), 정본 인덱스가
 * 실제로 소비되는지는 `studyLiveWorld.e2e.test.ts`가 자기 흐름에서 검출한다(중복 관측 회피).
 *
 * bank/world/objects repo는 이 흐름에서 미사용이라 최소 stub을 캐스트로 채운다(형제 스위트 관례 미러).
 */
function buildHarness(creature: CreatureInstance): AttackHarness {
  const room = makeRoom({ roomId: ROOM_ARENA, creatures: [creature] })
  const worldGraph = new Map<number, RoomNode>([[ROOM_ARENA, room]])

  const characterRepo = makeCharacterRepo(seedCharacter())

  // SaveEngine — FakeClock + 즉시 backoff(형제 스위트 미러). 주기 flush가 발화하지 않아 저장 타이밍이
  // 시나리오에 개입하지 않는다.
  const bankStub = {} as unknown as BankRepository
  const worldStub = {} as unknown as WorldRepository
  const objectStub = {} as unknown as ObjectRepository
  const saveEngine = new SaveEngine(
    characterRepo as unknown as CharacterRepository,
    bankStub,
    worldStub,
    objectStub,
    NOOP_LOGGER,
    { clock: new FakeClock(), queueOptions: { sleep: () => Promise.resolve() } },
  )
  saveEngine.start()

  // 월드 틱 — SaveEngine과 **별도** FakeClock을 쓴다. 두 스케줄러가 한 시계를 공유하면 월드 틱을
  // 진행시킬 때마다 저장 flush가 함께 돌아 관측이 섞인다.
  const worldTickClock = new FakeClock()
  const worldClock = new WorldClock({ clock: worldTickClock })
  const now = (): number => worldClock.currentTick()
  // boot와 같은 조립. `templates`·`events`만 주입해 디스크 로드를 격리한다(worldRuntime의 명시 seam).
  const worldRuntime = createWorldRuntime(worldGraph, {
    now,
    templates: new Map(),
    events: [],
  })
  for (const slot of worldRuntime.slots) worldClock.register(slot)
  worldClock.start()

  const liveRegistry = createLiveCharacterRegistry()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: (id) => characterRepo.findById(id),
      hydrateInventory: (id) => characterRepo.hydrateInventory(id),
    },
    objectTemplates: new Map(),
    spawnTemplates: worldRuntime.templates,
    alloc: worldRuntime.alloc,
    markDirty: (collection, id, snapshot) => saveEngine.markDirty(collection, id, snapshot),
    peekPending: (collection, id) => saveEngine.peekPending(collection, id),
    // 이 흐름은 currentHour를 소비하지 않는다(전투 경로에 시간 게이트가 없다) — 묶음 필수 필드 충족용이다.
    currentHour: () => 12,
    now,
    onRoomEntered: worldRuntime.onRoomEntered,
    onRoomLeft: worldRuntime.onRoomLeft,
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
  return {
    app,
    room,
    liveRegistry,
    characterRepo,
    saveEngine,
    worldClock,
    advanceWorld: (seconds) => worldTickClock.tick(seconds),
  }
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

describe('공격 end-to-end (실 소켓 · 실 월드 틱)', () => {
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let clients: WebSocket[]
  let clocks: WorldClock[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    process.env.WS_RECONNECT_GRACE_MS = '60000'
    resetConfigForTests()
    apps = []
    clients = []
    clocks = []
  })

  afterEach(async () => {
    // 형제 스위트의 정리 순서를 그대로 따르되 월드 틱 정지를 앞에 둔다. 케이스 간 간섭은 없다 —
    // `worldTickClock`은 하네스마다 새로 만들고 `advanceWorld`가 그 인스턴스만 tick한다. 정지는
    // 앱 종료 뒤 남은 슬롯이 돌지 않게 하는 순서 위생이다.
    for (const clock of clocks) clock.stop()
    for (const client of clients) client.close()
    for (const app of apps) {
      app.wsShutdown.markShuttingDown()
      app.wsShutdown.converge()
    }
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  /** 하네스를 만들고 정리 대상(app·월드 시계)에 등록한 뒤 소켓 URL을 돌려준다. */
  async function startTracked(creature: CreatureInstance): Promise<{
    h: AttackHarness
    url: string
  }> {
    const h = buildHarness(creature)
    apps.push(h.app)
    clocks.push(h.worldClock)
    const url = await startTestServer(h.app)
    return { h, url }
  }

  function trackedClient(url: string): WebSocket {
    const client = newAuthedClient(url, { cookie: COOKIE })
    clients.push(client)
    return client
  }

  it('시드 스탯이 명중·피해를 결정적으로 강제한다 (확률 단언 부재의 근거)', () => {
    // 시나리오의 전제를 **프로덕션 공식에 대해** 고정한다. 테이블만 대조하고 공식을 손으로 다시
    // 쓰면 테이블 회귀는 잡지만 공식 회귀는 못 잡는다 — `hitThreshold`의 `/8`이 바뀌거나 피해
    // 분기가 재배치되면 이 단언은 통과한 채 아래 시나리오만 "가끔 빗나가서" 흔들린다. 그래서
    // 실제 함수를 부른다.
    const attacker = toCombatant(seedCombatState())

    // ① 명중 — 빗나감 조건은 `rng(1, HIT_ROLL_MAX_PLAYER) < threshold`다(resolveAttack).
    //    임계가 굴림 최솟값 1 이하면 어떤 굴림에서도 빗나가지 않는다.
    const threshold = hitThreshold(attacker, toCombatant(survivorCreature()))
    expect(threshold).toBeLessThanOrEqual(1)

    // ② P-flag 항이 0이어야 위 임계가 유지된다 — PBLIND는 +5, PFEARS는 +2를 더한다. 공유 픽스처에
    //    statusEffects·buffs가 없어 all-zero hex지만, 그 픽스처가 바뀌면 여기가 먼저 터진다.
    expect(F_ISSET(attacker.flags, PBLIND)).toBe(false)
    expect(F_ISSET(attacker.flags, PFEARS)).toBe(false)

    // ③ 피해 값역 — 굴림 하한·상한 stub으로 **같은 공식**을 양끝에서 평가한다. 맨손이라
    //    크리·불발·다중공격이 모두 미발화하므로 이 값역이 곧 라운드 피해의 값역이다.
    expect(MIN_DAMAGE).toBe(playerBaseDamage(attacker, minRollRng))
    expect(MAX_DAMAGE).toBe(playerBaseDamage(attacker, maxRollRng))

    // ④ 크리처 HP를 값역 양쪽에 둔다 — 생존 크리처는 최대 피해로도 죽지 않고, 처치 크리처는 최소
    //    피해로도 죽는다. 등호가 아니라 진부등호라 경계에서 뒤집히지 않는다.
    expect(MAX_DAMAGE).toBeLessThan(SURVIVOR_HP)
    expect(MIN_DAMAGE).toBeGreaterThan(KILL_HP)
  })

  it('진입→지목→타격이 combat:attacked·character:stats를 순서대로 내고, 쿨다운 미도래 2타를 거부한다', async () => {
    const { h, url } = await startTracked(survivorCreature())

    // ── 1) 진입 — 캐릭터가 방에 배치되고 방 목록에 크리처가 보인다. ────────────────
    const client = trackedClient(url)
    const s = await enterWorld(client, CHAR)
    expect(s.entered).toMatchObject({ type: 'session:entered', characterId: CHAR })
    expect(s.room).toMatchObject({
      type: 'world:room',
      roomId: ROOM_ARENA,
      creatures: [{ instanceId: CREATURE_ID, name: CREATURE_NAME }],
    })
    await waitFor(() => h.room.occupants.has(CHAR))

    // ── 2) 타격 — 방 목록에 보인 그 이름으로 지목한다. `id`를 실어 보낸다: 상태 이벤트가 상관 키를
    //      반향하지 **않는다**는 아래 단언은 명령에 id가 있어야 의미를 갖는다(없으면 자동 통과다).
    client.send(JSON.stringify({ type: 'combat:attack', target: CREATURE_NAME, id: 'atk-1' }))

    // ── 3) 통지 — 순서가 계약이다(combat:attacked → character:stats). ───────────────
    const attacked = await s.reader.next()
    expect(attacked).toMatchObject({
      type: 'combat:attacked',
      targetInstanceId: CREATURE_ID,
      targetName: CREATURE_NAME,
      hit: true,
      died: false,
      critical: false,
      fumble: false,
    })
    // 상태 이벤트라 상관 키를 반향하지 않는다(progress:trained·progress:studied 선례).
    // 명령에 id: 'atk-1'을 실었는데도 없어야 한다.
    expect(attacked).not.toHaveProperty('correlationId')
    // 맨손 1타 — 다중공격이 미발화한다는 결정성 전제의 프레임 수준 확인이다. class 5는
    // `multiAttackCount`의 두 조건(초인 && level>100, class>초인) 어느 쪽도 아니라 항상 1타다.
    const attacks = attacked.type === 'combat:attacked' ? attacked.attacks : []
    expect(attacks).toHaveLength(1)

    // ★ 계산한 값역을 **관측 피해와 연결한다.** 이 단언이 없으면 위 결정성 전제 테스트가 시나리오와
    //   무관한 산술로 남는다 — 실제로 나온 피해가 그 값역 안이어야 논증이 닫힌다.
    const damage = attacked.type === 'combat:attacked' ? attacked.damage : -1
    expect(damage).toBeGreaterThanOrEqual(MIN_DAMAGE)
    expect(damage).toBeLessThanOrEqual(MAX_DAMAGE)

    const stats = await s.reader.next()
    expect(stats).toMatchObject({
      type: 'character:stats',
      level: CHAR_LEVEL,
      experience: CHAR_EXPERIENCE, // 생존 = 보상 없음.
      hpCurrent: CHAR_HP, // 몬스터가 반격하지 않으므로 공격자 HP는 불변이다.
    })

    // 크리처는 살아남았고 실제로 피해를 입었다(라이브 방 노드 관측 — 프레임의 died:false와 정합).
    expect(h.room.creatures).toHaveLength(1)
    expect(h.room.creatures[0]?.hpcur).toBeLessThan(SURVIVOR_HP)
    expect(h.room.creatures[0]?.hpcur).toBeGreaterThan(0)

    // ── 4) 쿨다운 — 같은 틱에 보낸 2타는 거부된다(`nextAttackAt = now + 1`, 월드 틱 미진행). ──
    client.send(JSON.stringify({ type: 'combat:attack', target: CREATURE_NAME, id: 'atk2' }))
    const rejected = await s.reader.next()
    expect(rejected).toMatchObject({
      type: 'error',
      code: 'rule_rejected',
      correlationId: 'atk2',
    })
  })

  it('처치하면 combat:attacked·character:stats에 이어 죽은 크리처가 빠진 world:room이 온다', async () => {
    const { h, url } = await startTracked(killableCreature())

    const client = trackedClient(url)
    const s = await enterWorld(client, CHAR)
    expect(s.entered).toMatchObject({ type: 'session:entered', characterId: CHAR })
    await waitFor(() => h.room.occupants.has(CHAR))

    client.send(JSON.stringify({ type: 'combat:attack', target: CREATURE_NAME }))

    // (1) 타격 통지 — 이번엔 died가 선다.
    const killed = await s.reader.next()
    expect(killed).toMatchObject({
      type: 'combat:attacked',
      targetInstanceId: CREATURE_ID,
      targetName: CREATURE_NAME,
      hit: true,
      died: true,
    })
    const killDamage = killed.type === 'combat:attacked' ? killed.damage : -1
    expect(killDamage).toBeGreaterThanOrEqual(MIN_DAMAGE)
    expect(killDamage).toBeLessThanOrEqual(MAX_DAMAGE)

    // (2) 스탯 — 사망 seam이 적립한 경험치가 **같은 프레임에** 실린다. 공격 시작 시점 스냅샷을 쓰면
    //     여기가 CHAR_EXPERIENCE로 남는다(`handlers/attack.ts`의 되쓰기 전 재조회가 그것을 막는다).
    const stats = await s.reader.next()
    expect(stats).toMatchObject({ type: 'character:stats', experience: KILL_EXP })
    const experience = stats.type === 'character:stats' ? stats.experience : -1
    expect(experience).toBeGreaterThan(CHAR_EXPERIENCE)

    // (3) 방 재투영 — 이벤트 추가가 아니라 발화 지점 추가다(D14). 안 오면 클라 목록에 시체가 남는다.
    const roomView = await s.reader.next()
    expect(roomView).toMatchObject({ type: 'world:room', roomId: ROOM_ARENA })
    const creatures = roomView.type === 'world:room' ? roomView.creatures : []
    expect(creatures).toEqual([])

    // 라이브 방 노드에서도 제거됐다 — 프레임이 비어 있는 이유가 표시 필터가 아니라 실제 제거임을
    // 구분한다(`roomView`는 hpcur<=0도 거르므로 프레임만으로는 둘이 구별되지 않는다).
    expect(h.room.creatures).toHaveLength(0)
  })

  it('월드 틱이 도는 동안에도 몬스터는 반격하지 않는다 (#99 범위 밖 회귀 잠금)', async () => {
    const { h, url } = await startTracked(survivorCreature())

    const client = trackedClient(url)
    const s = await enterWorld(client, CHAR)
    expect(s.entered).toMatchObject({ type: 'session:entered', characterId: CHAR })
    await waitFor(() => h.room.occupants.has(CHAR))

    // ── 1) 1타 — 이 타격이 크리처의 적 리스트에 공격자를 등록한다(registerEnemy). ──
    client.send(JSON.stringify({ type: 'combat:attack', target: CREATURE_NAME }))
    expect(await s.reader.next()).toMatchObject({ type: 'combat:attacked', hit: true, died: false })
    const before = await s.reader.next()
    expect(before).toMatchObject({ type: 'character:stats', hpCurrent: CHAR_HP })

    // ── 2) 월드 틱 진행 — 쿨다운(1초)을 넉넉히 넘긴다. ───────────────────────────
    const ticks = ATTACK_COOLDOWN_INTERVAL + 5
    h.advanceWorld(ticks)
    expect(h.worldClock.currentTick()).toBe(ticks)

    // ── 3) 틱이 **공허하지 않았다**는 증거 두 가지. ─────────────────────────────────
    //  (a) creatureTick이 이 크리처를 실제로 처리했다 — next-action이 스케줄됐다.
    //  (b) 적 리스트가 비어 있지 않아 §3.5 조기종료 게이트를 통과했다 = 전투 디스패치 지점까지
    //      도달했다. 그 지점의 seam(`onCombatTick`)이 프로덕션 기본값 no-op이라는 것이 #99가 아직
    //      배선되지 않았다는 사실 그 자체다.
    const live = h.room.creatures[0]
    expect(live?.nextActionAt).toBeGreaterThan(0)
    expect(live?.enemies).toContain(CHAR)

    // ── 4) 그럼에도 공격자 HP는 불변이다. 관측은 소켓 프레임으로 한다 — 쿨다운이 지났으므로
    //      2타가 통과하고 그 응답의 character:stats가 최신 HP를 싣는다.
    client.send(JSON.stringify({ type: 'combat:attack', target: CREATURE_NAME }))
    expect(await s.reader.next()).toMatchObject({ type: 'combat:attacked', hit: true })
    const after = await s.reader.next()
    expect(after).toMatchObject({ type: 'character:stats', hpCurrent: CHAR_HP })
  })
})
