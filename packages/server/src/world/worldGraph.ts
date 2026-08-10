import { loadWorldFile } from 'shared'
import type { CreatureInstance, ExitEdge, ItemInstance, PermMonSlot, RoomNode } from 'shared'
import { fromEmbedded, type CreatureSource } from './creatureFactory.js'

// data/world/rooms.json 파싱 입력 형태(raw 디스크 산출물). loadWorldFile이 이 shape를 준다.
type RawExit = { name: string; room: number; flags: number[]; key: number }
type RawItem = {
  name: string
  description: string
  value: number
  flags?: string
  keys?: string[]
  contains: RawItem[]
}
// embedded 몬스터는 T2.0 이후 완전한 creature 필드를 담는다(CreatureSource + rom_num·inventory 등).
type RawMonster = CreatureSource & { rom_num: number }
type RawPermMon = { interval: number; ltime: number; misc: number }
type RawRoom = {
  id: number
  name: string
  flags: number[]
  exits: RawExit[]
  items: RawItem[]
  monsters?: RawMonster[]
  perm_mon?: RawPermMon[]
  random?: number[]
  traffic?: number
  short_desc: string
  long_desc: string
}

/**
 * 출구 문 재잠금/재닫힘 지연의 런타임 기본값(초). oracle a4 §111 `check_exits`는
 * `ltime + interval < now`이면 문을 자동 재잠금/재닫힘하지만 원본은 구체 interval 값을
 * 명시하지 않는다(디스크 라이브 상태에 기록될 뿐). 여기서 런타임 기본값으로 고정하고,
 * 후속 write-back(문 상태 영속화) 토픽에서 방별 값으로 이월한다. 코드·테스트가 이 상수를
 * 함께 참조해 값 불일치를 없앤다.
 */
export const DEFAULT_EXIT_INTERVAL_SEC = 60

// raw 출구를 런타임 엣지로 매핑한다. room(대상 방 번호) → targetRoomId.
// ltime은 문 상태 변경 시각으로 부팅 시 0(변경 없음), interval은 런타임 기본 주입값.
// dangling 대상은 그대로 유지한다(해석은 Map.has 지연 조회).
function toExitEdge(raw: RawExit): ExitEdge {
  // flags는 복사한다 — 노드가 폐기될 raw 번들과 배열을 공유하지 않게(items deep-copy와 정합).
  return {
    name: raw.name,
    targetRoomId: raw.room,
    flags: [...raw.flags],
    key: raw.key,
    ltime: 0,
    interval: DEFAULT_EXIT_INTERVAL_SEC,
  }
}

// raw 아이템을 인메모리 인스턴스로 재귀 변환한다.
// instanceId 스킴: `${roomId}:${path}` — path는 방 아이템 트리의 인덱스 경로를 점으로 이은 값.
// 예: 방50 첫 아이템=`50:0`, 그 컨테이너의 첫 중첩=`50:0.0`. 방 id가 Map 키로 유일하고
// 경로가 방 내에서 유일하므로 전역 유일성이 보장된다. 결정적·순수(Math.random/Date.now 미사용).
function toItemInstance(raw: RawItem, roomId: number, path: string): ItemInstance {
  return {
    instanceId: `${roomId}:${path}`,
    name: raw.name,
    description: raw.description,
    value: raw.value,
    // flags는 scavenge 제외 판정용 hex string(D8). 합성 픽스처 등 raw.flags 부재 시 all-zero로
    // 기본값(플래그 없음=회수 가능)을 준다 — 타입은 항상 string 계약을 유지한다.
    flags: raw.flags ?? '0000000000000000',
    // 이름 매칭용 별칭(Story 4). flags 선례처럼 합성 픽스처 등 raw.keys 부재 시 빈 배열로
    // 정규화한다 — 타입은 항상 string[] 계약을 유지한다(undefined 금지). 배열은 복사한다 —
    // 노드가 폐기될 raw 번들과 공유하지 않게(exit flags·random 복사 관례와 정합).
    keys: [...(raw.keys ?? [])],
    contains: raw.contains.map((child, i) => toItemInstance(child, roomId, `${path}.${i}`)),
  }
}

// perm 스폰 슬롯을 복사한다 — 노드가 폐기될 raw 번들과 객체를 공유하지 않게(flags/items 복사 관례).
// ltime은 라이브 가변(입장 리스폰·사망 시 세팅)이라 반드시 raw와 분리한다.
function toPermMonSlot(raw: RawPermMon): PermMonSlot {
  return { interval: raw.interval, ltime: raw.ltime, misc: raw.misc }
}

function toRoomNode(raw: RawRoom): RoomNode {
  // embedded 몬스터를 라이브 크리처로 물질화한다(팩토리 (a) 경로, templateId=null — 템플릿
  // 재인스턴스화가 아니라 방 파일 인라인 데이터로 물질화). 기본 결정적 rng로 순수성을 유지한다.
  const monsters = raw.monsters ?? []
  const creatures: CreatureInstance[] = monsters.map((m, i) => fromEmbedded(m, raw.id, i))
  return {
    roomId: raw.id,
    name: raw.name,
    shortDesc: raw.short_desc,
    longDesc: raw.long_desc,
    exits: raw.exits.map(toExitEdge),
    items: raw.items.map((item, i) => toItemInstance(item, raw.id, String(i))),
    // flags는 64비트 raw 방 flags를 복사해 보존한다(exits/items deep-copy 관례와 정합, 불변).
    flags: [...raw.flags],
    // occupants는 라이브 점유자 Set으로 부팅 시 빈 상태다(characterId가 이동 시 채워짐).
    occupants: new Set<string>(),
    // creatures는 라이브 가변 배열(스폰 push·사망 제거). 스폰 정의 필드는 복사해 raw와 분리한다.
    creatures,
    permMon: (raw.perm_mon ?? []).map(toPermMonSlot),
    random: [...(raw.random ?? [])],
    traffic: raw.traffic ?? 0,
  }
}

/**
 * 부팅 시 정본 방 번들을 인메모리 그래프로 로드한다.
 *
 * rooms.json 배열을 한 번 읽어 `room.id`를 키로 하는 Map을 구성한다. 출구는 엣지로,
 * 바닥 아이템은 고유 id를 가진 ItemInstance로, 방 embedded 몬스터는 `CreatureInstance`로
 * 물질화하고 스폰 정의 필드(`permMon`·`random`·`traffic`)를 노드에 싣는다(E4-2 G1). objmon
 * 템플릿 번호 재인스턴스화·리스폰 스케줄은 하지 않는다(입장 lazy·tick 소관). 순수 함수 —
 * 전역·부수효과 없이 Map만 반환한다.
 *
 * @param worldRoot data/world 루트 오버라이드(기본: 저장소 data/world) — 테스트 격리용
 */
export function loadWorldGraph(worldRoot?: string): Map<number, RoomNode> {
  const rooms = loadWorldFile<RawRoom[]>('rooms.json', worldRoot)
  const graph = new Map<number, RoomNode>()
  for (const raw of rooms) {
    graph.set(raw.id, toRoomNode(raw))
  }
  return graph
}
