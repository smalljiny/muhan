/**
 * 인메모리 월드 그래프 타입 — 부팅 시 방 데이터를 로드해 구성하는 런타임 객체 그래프.
 *
 * 영속 스키마(objectSchema/ObjectInstance 등)와는 별개다. 이쪽은 zod가 아닌 순수 TS
 * 타입으로, 디스크에 저장되지 않는 라이브 상태(런타임 필드·생성 id)를 표현한다.
 */

/**
 * 방 출구 엣지. 원본 raw exit의 `room`(대상 방 번호)을 `targetRoomId`로 매핑한다.
 * `timer`는 런타임 전용 필드로 raw에는 없으며 기본 0이다. 대상이 그래프에 없으면
 * (dangling) 엣지는 그대로 유지되고 해석은 지연(Map.has 조회)된다.
 */
export type ExitEdge = {
  name: string
  targetRoomId: number
  flags: number[]
  key: number
  timer: number
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
 */
export type RoomNode = {
  roomId: number
  name: string
  shortDesc: string
  longDesc: string
  exits: ExitEdge[]
  items: ItemInstance[]
}
