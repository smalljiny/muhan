/**
 * 인메모리 월드 그래프 타입 — 부팅 시 방 데이터를 로드해 구성하는 런타임 객체 그래프.
 *
 * 영속 스키마(objectSchema/ObjectInstance 등)와는 별개다. 이쪽은 zod가 아닌 순수 TS
 * 타입으로, 디스크에 저장되지 않는 라이브 상태(런타임 필드·생성 id)를 표현한다.
 *
 * 가변성(mutability) 경계 — 프로젝트 CRITICAL immutability 규칙의 의도된 예외:
 *   - 라이브 가변: `RoomNode.occupants`(점유자 Set), `ExitEdge.flags`+`ExitEdge.ltime`
 *     (문 개폐/재잠금 상태 머신 — oracle a4 §111 `check_exits`가 ltime+interval로 재잠금).
 *   - immutable: 정적 필드 전부 + `RoomNode.flags`(64비트 raw 방 flags는 콘텐츠로 불변).
 *   방 flags와 exit flags를 혼동하지 않는다 — 전자는 불변, 후자는 문 상태로 가변이다.
 */

/**
 * 방 출구 엣지. 원본 raw exit의 `room`(대상 방 번호)을 `targetRoomId`로 매핑한다.
 *
 * `ltime`은 마지막 상태 변경 실초 시각(기본 0), `interval`은 재잠금/재닫힘 지연 초로
 * 둘 다 런타임 전용 필드다(raw에는 없음). oracle a4 §111 `check_exits`가
 * `ltime + interval < now`이면 `XLOCKS`/`XCLOSS` 출구를 자동 재잠금/재닫힘한다 —
 * `ltime`이 문 상태 머신의 타이밍을 인코딩한다. 대상이 그래프에 없으면(dangling)
 * 엣지는 그대로 유지되고 해석은 지연(Map.has 조회)된다.
 */
export type ExitEdge = {
  name: string
  targetRoomId: number
  flags: number[]
  key: number
  ltime: number
  interval: number
}

/**
 * 인메모리 바닥 아이템 인스턴스. `instanceId`는 부팅 시 생성되는 고유 id로 디스크에
 * 저장되지 않는다(non-durable). 컨테이너는 `contains`로 재귀 중첩된다.
 */
export type ItemInstance = {
  instanceId: string
  name: string
  description: string
  value: number
  contains: ItemInstance[]
}

/**
 * 방 그래프 노드. 그래프 탐색·표시에 필요한 필드만 담는다(모든 raw 필드를 옮기지 않음).
 * raw의 short_desc/long_desc를 shortDesc/longDesc로 매핑한다.
 *
 * `flags`는 64비트 raw 방 flags를 8바이트 number[]로 그대로 보존한다(oracle a4 §117 —
 * 이동/마법/상점/전투 서브시스템이 이 플래그를 읽으므로 방이 전부 운반해야 한다). 불변.
 * `occupants`는 방에 있는 캐릭터의 characterId 집합으로 라이브 가변이다. shared는
 * server의 ActorContext를 import할 수 없으므로 원소 타입은 string(characterId)이다.
 */
export type RoomNode = {
  roomId: number
  name: string
  shortDesc: string
  longDesc: string
  exits: ExitEdge[]
  items: ItemInstance[]
  flags: number[]
  occupants: Set<string>
}

/**
 * `getDirectionHints`의 반환 형태. 방 출구를 두 부류로 분리한다.
 *   - `cardinal`: 기본 6방향 출구(동/서/남/북/위/밑).
 *   - `other`: 그 외 전부 — 명명 출구(거실/문/밖 등)와 대각 출구(남서/북서/북동/남동).
 */
export type DirectionHints = {
  cardinal: ExitEdge[]
  other: ExitEdge[]
}

/** 기본 6방향 출구명 집합(oracle a3 §2-1 방향 매핑표: 동/서/남/북/위/밑). */
const CARDINAL_NAMES: ReadonlySet<string> = new Set(['동', '서', '남', '북', '위', '밑'])

/**
 * 방 출구를 기본 6방향(cardinal)과 명명/대각(other)으로 분류하는 파생 순수 함수.
 *
 * 노드 필드로 물질화하지 않는 on-demand 조회다 — 방향은 간선 라벨일 뿐이고 무한의
 * 월드에는 좌표(x/y/z)가 없으므로(oracle a4 §7) 좌표를 합성하지 않는다. 대각 출구
 * (남서 등)는 라이브에서 전체 단어 입력으로만 도달 가능한 별칭 없는 명명 출구이므로
 * (oracle a3 §2-2, numpad/jamo 대각 정규화는 죽은 코드) 기본 6축이 아니라 other로 둔다.
 * 밖(out)도 6방향 축이 아니므로 other다.
 *
 * 부수효과·전역 상태 없음. 입력 room을 변형하지 않고 새 배열을 반환한다.
 */
export function getDirectionHints(room: RoomNode): DirectionHints {
  const cardinal: ExitEdge[] = []
  const other: ExitEdge[] = []
  for (const exit of room.exits) {
    if (CARDINAL_NAMES.has(exit.name)) cardinal.push(exit)
    else other.push(exit)
  }
  return { cardinal, other }
}
