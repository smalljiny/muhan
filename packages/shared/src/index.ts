/**
 * shared — server·client가 공유하는 단일 출처 타입.
 *
 * E1에서는 툴체인 검증용 최소 타입만 노출한다. 게임 도메인 타입(방·아이템·몬스터·
 * 플레이어)은 후속 에픽에서 이 패키지에 추가된다.
 */

/** `/health` 엔드포인트 응답 형태. server·client가 함께 참조한다. */
export type HealthStatus = { status: 'ok' | 'degraded'; db: 'up' | 'down' }

export { loadWorldFile } from './worldLoader.js'

// 인메모리 월드 그래프 런타임 타입(방 노드·출구 엣지·아이템·크리처 인스턴스·스폰 슬롯). 영속 스키마와 별개.
export type {
  ExitEdge,
  ItemInstance,
  CreatureInstance,
  PermMonSlot,
  RoomNode,
  DirectionHints,
} from './worldGraph.js'
// 방 출구를 기본 6방향 vs 명명/대각으로 분리하는 파생 순수 함수.
export { getDirectionHints } from './worldGraph.js'

// 영속 스키마 + z.infer 파생 도메인 타입(캐릭터·오브젝트·은행·방 상태).
export * from './schema/index.js'

// 와이어 프로토콜 계약 + z.infer 파생 타입(명령·이벤트 봉투·payload building block).
export * from './protocol/index.js'

// 골든 fixture 하네스 — 함수별 골든 fixture JSON 포맷 스키마 + 제네릭 타입.
export { goldenFixtureSchema, type GoldenFixture } from './oracle/types.js'

// 골든 fixture approval 러너 — cases를 SUT 출력과 대조해 전 불일치를 집계 리포트.
export { approve } from './oracle/runner.js'

// property 테스트용 의존 0 seedable PRNG(mulberry32) + 정수 범위 헬퍼.
export { makeSeededRng, nextIntInRange } from './property/seededRng.js'

// property 공통 불변식 assert(순수, fast-check 무의존) — 범위·단조성 검사.
export { assertInRange, assertMonotonic } from './property/invariants.js'

// 전투·경제·레벨링 정적 룩업 테이블 + 유효 능력치 합성 + 파생 스탯 resolver(단일 배럴 출처).
export * from './stats/index.js'

// 레벨링 exp 곡선 룩업(neededExp)·역함수(expToLevel) 순수 함수. 원시 needed_exp 테이블·MAXALVL은
// 배럴로 노출하지 않는다 — 소비자(Story 2 backfill·Story 6 train)는 함수만 쓰고, off-by-one/
// 선형 피벗 함정은 이 두 함수가 캡슐화한다. 실소비자가 생기면 그때 배럴에 추가한다(stats 선례).
export { neededExp, expToLevel } from './progression/expCurve.js'

// HP/MP 최대치 compute-on-read 래퍼(stats-core 폐형 + 초인 오버라이드 단일 소비 지점, D2)와
// 현재치 불변식 클램프 헬퍼. 최대치는 저장하지 않고 class·level로 매 판독 시 파생한다.
// Story 4·5·7·8(레벨업·강등·재생·승급)이 이 세 함수를 공유 소비한다.
export { resolveHpMax, resolveMpMax, clampVital } from './progression/maxResolvers.js'
