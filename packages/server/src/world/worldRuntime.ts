import type { RoomNode } from 'shared'
import { createActiveSet, type ActiveSet } from './activeSet.js'
import {
  createInstanceIdAllocator,
  loadSpawnTemplates,
  respawnPermCreatures,
  type SpawnTemplateIndex,
} from './spawn.js'
import { createCreatureTick, type OnCombatTick } from './creatureTick.js'
import { createRandomSpawn } from './randomSpawn.js'
import { createInvasion, loadInvasionEvents, type InvasionEvent, type SpawnBroadcast } from './invasion.js'
import type { CreatureRng } from './creatureFactory.js'
import type { WorldTickSlot } from './worldClock.js'
import type { MoveActor } from './tryMove.js'

/**
 * 월드 런타임 컴포지션 팩토리 — G1~G4 조각(활성 집합·크리처 tick·스폰 3트리거·entry/leave 훅)을
 * 하나의 배선 단위로 조립한다(플랜 Story 6).
 *
 * index.ts boot는 커버리지 제외 배선 코드라, 배선 로직을 테스트 가능한 이 팩토리로 추출하고 index.ts는
 * `createWorldRuntime(...)` 호출과 슬롯 register만 남기는 얇은 glue로 둔다. 팩토리는 슬롯 배열과
 * onRoomEntered/onRoomLeft 훅, 활성 집합을 반환한다.
 *
 * now 도메인 단일 출처: onRoomEntered의 activate/respawn `now`는 creatureTick의 tickSec와 동일 tick
 * 도메인이어야 재생 소급 baseline 클램프(Story 3)가 성립한다. 그래서 `deps.now`(index.ts가
 * `() => worldClock.currentTick()`을 주입)를 훅 `now`의 단일 소스로 쓰고, 자체 tick 미러를 두지 않는다.
 *
 * D7 준수: 단일 `alloc`(방별 monotonic idx 발급기)을 훅 리스폰·randomSpawn·invasion이 공유한다 —
 * 별도 발급기를 두면 같은 방에서 idx가 충돌한다. worldGraph의 pristine creatures.length로 seed한다.
 *
 * dormant 경계(E4-2): onRoomEntered/onRoomLeft는 구성만 되고 프로덕션에서 tryMove를 부르는 실 caller가
 * 아직 없다(movement/command 에픽 소관) — 배선은 완비하되 실제 발화는 후속 에픽이 tryMove를 프로덕션에
 * 결선할 때 활성화된다. 그 전까지 활성 집합은 비어 creatureTick·randomSpawn은 boot 후 no-op이다.
 *
 * 확률 seam은 각 슬롯 모듈 기본값(neverFireRng·defaultSpawnRng·defaultInvasionRng)을 그대로 쓴다 —
 * 실 확률 굴림 배선은 E6/E8 소관이고, 그 발화 경로는 슬롯 단위 테스트가 이미 검증한다. 팩토리 deps는
 * E6/E7 seam(onCombatTick·broadcast·creatureRng)과 테스트 격리용 주입(templates·events·worldRoot)만
 * 노출한다.
 */
export interface WorldRuntimeDeps {
  /** 훅 `now` 단일 소스 — index.ts가 `() => worldClock.currentTick()`을 주입한다. */
  readonly now: () => number
  /** 스폰 템플릿 인덱스(기본: creatures.json 로드). 테스트가 합성 인덱스를 주입한다. */
  readonly templates?: SpawnTemplateIndex
  /** 침공 이벤트 목록(기본: events.json 로드). 테스트가 합성 이벤트를 주입한다. */
  readonly events?: readonly InvasionEvent[]
  /** data/world 루트 오버라이드(테스트 격리) — templates·events 미주입 시 로드 경로에 전달. */
  readonly worldRoot?: string
  /** carry/gold 랜덤화 seam(기본 결정적 identity) — 리스폰·random·invasion 스폰이 공유한다. */
  readonly creatureRng?: CreatureRng
  /** §3.5 게이트 통과 크리처 전투 디스패치(기본 no-op, E6이 대체). */
  readonly onCombatTick?: OnCombatTick
  /** invasion 방송 seam(기본 no-op, E7이 전역 방송으로 대체). */
  readonly broadcast?: SpawnBroadcast
}

/** 컴포지션 산출물 — boot가 register할 슬롯 + tryMove가 결선할 훅 + 활성 집합. */
export interface WorldRuntime {
  /** WorldClock에 register할 슬롯(creatureTick·randomSpawn·이벤트당 invasion). */
  readonly slots: WorldTickSlot[]
  /** tryMove join 경로 결선용 entry-hook(활성화 + perm 리스폰). */
  readonly onRoomEntered: (room: RoomNode, actor: MoveActor) => void
  /** tryMove leave 경로 결선용 leave-hook(빈 방 비활성화). */
  readonly onRoomLeft: (room: RoomNode, actor: MoveActor) => void
  /** 활성 집합(테스트·후속 조회용). */
  readonly activeSet: ActiveSet
}

export function createWorldRuntime(
  worldGraph: Map<number, RoomNode>,
  deps: WorldRuntimeDeps,
): WorldRuntime {
  const activeSet = createActiveSet()
  // pristine creatures.length로 방별 seed(D7) — 로드 직후·어떤 tick도 일어나기 전 전 방을 seed한다.
  const alloc = createInstanceIdAllocator(worldGraph.values())
  const templates = deps.templates ?? loadSpawnTemplates(deps.worldRoot)
  const events = deps.events ?? loadInvasionEvents(deps.worldRoot)

  const creatureTick = createCreatureTick({
    activeSet,
    onCombatTick: deps.onCombatTick,
  })
  const randomSpawn = createRandomSpawn({
    rooms: () => activeSet.activeRooms(),
    templates,
    alloc,
    creatureRng: deps.creatureRng,
  })
  const invasionSlots = createInvasion({
    events,
    resolveRoom: (roomId) => worldGraph.get(roomId),
    templates,
    alloc,
    creatureRng: deps.creatureRng,
    broadcast: deps.broadcast,
  })

  const slots: WorldTickSlot[] = [creatureTick, randomSpawn, ...invasionSlots]

  // perm 리스폰 deps는 boot-once 안정값이라 훅 밖에서 1회만 구성한다(입장마다 재할당 회피).
  const permRespawnDeps = { templates, alloc, rng: deps.creatureRng }
  // entry-hook: 활성화 + perm due 리스폰. now는 deps.now()(creatureTick tickSec와 동일 도메인).
  const onRoomEntered = (room: RoomNode, _actor: MoveActor): void => {
    const now = deps.now()
    activeSet.activate(room, now)
    respawnPermCreatures(room, now, permRespawnDeps)
  }
  // leave-hook: 빈 방 비활성화(deactivate는 occupants 비어있을 때만 성립 — tryMove가 delete 後 호출).
  const onRoomLeft = (room: RoomNode, _actor: MoveActor): void => {
    activeSet.deactivate(room)
  }

  return { slots, onRoomEntered, onRoomLeft, activeSet }
}
