/**
 * shared — server·client가 공유하는 단일 출처 타입.
 *
 * E1에서는 툴체인 검증용 최소 타입만 노출한다. 게임 도메인 타입(방·아이템·몬스터·
 * 플레이어)은 후속 에픽에서 이 패키지에 추가된다.
 */

/** `/health` 엔드포인트 응답 형태. server·client가 함께 참조한다. */
export type HealthStatus = { status: 'ok' | 'degraded'; db: 'up' | 'down' }

export { loadWorldFile } from './worldLoader.js'

// 인메모리 월드 그래프 런타임 타입(방 노드·출구 엣지·아이템 인스턴스). 영속 스키마와 별개.
export type { ExitEdge, ItemInstance, RoomNode } from './worldGraph.js'

// 영속 스키마 + z.infer 파생 도메인 타입(캐릭터·오브젝트·은행·방 상태).
export * from './schema/index.js'

// 와이어 프로토콜 계약 + z.infer 파생 타입(명령·이벤트 봉투·payload building block).
export * from './protocol/index.js'

// 골든 fixture 하네스 — 함수별 골든 fixture JSON 포맷 스키마 + 제네릭 타입.
export { goldenFixtureSchema, type GoldenFixture } from './oracle/types.js'

// 골든 fixture approval 러너 — cases를 SUT 출력과 대조해 전 불일치를 집계 리포트.
export { approve } from './oracle/runner.js'
