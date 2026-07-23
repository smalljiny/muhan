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

// 경제 가격 배수(A8 §8) — 구매·몹구매·판매·수리 순수 함수 + 선언적 상수 테이블(단일 배럴 출처).
export * from './economy/index.js'

// 레벨링 exp 곡선 룩업(neededExp)·역함수(expToLevel) 순수 함수. 원시 needed_exp 테이블·MAXALVL은
// 배럴로 노출하지 않는다 — 소비자(Story 2 backfill·Story 6 train)는 함수만 쓰고, off-by-one/
// 선형 피벗 함정은 이 두 함수가 캡슐화한다. 실소비자가 생기면 그때 배럴에 추가한다(stats 선례).
export { neededExp, expToLevel } from './progression/expCurve.js'

// HP/MP 최대치 compute-on-read 래퍼(stats-core 폐형 + 초인 오버라이드 단일 소비 지점, D2)와
// 현재치 불변식 클램프 헬퍼. 최대치는 저장하지 않고 class·level로 매 판독 시 파생한다.
// Story 4·5·7·8(레벨업·강등·재생·승급)이 이 세 함수를 공유 소비한다.
export { resolveHpMax, resolveMpMax, clampVital } from './progression/maxResolvers.js'

// 레벨업·강등 순수 변이(level_cycle 능력치 성장 + 최대치 재동기화 + 현재치 클램프). level_cycle
// 원시 테이블은 배럴로 노출하지 않는다 — 소비자(Story 6 train·강등 경로)는 함수만 쓰고, 성장
// 게이트·슬롯 인덱스·enum→stats 매핑 함정은 이 두 함수가 캡슐화한다(needed_exp 선례).
export { upLevel, downLevel } from './progression/levelUp.js'

// 승급(prestige) 순수 전이 — 무적(class<9→9·level1·exp0) / 초인(class9→10·level127) 전환과
// 분기 판정(classifyPrestige). Story 6 train이 classifyPrestige로 게이트 후 디스패치 소비한다(D6).
// gold 차감(train)·dice(combat)는 미소유하고 순수 class/level/experience/vitals 전이만 소유한다.
export { invinciblePrestige, caretakerPrestige, classifyPrestige } from './progression/prestige.js'

// 주문 카탈로그 read-only 선언 테이블 — spllist 56 메타데이터 + ospell 20 realm×tier 격자(byte 정본).
// effect 본체는 유예(#85)이고 이 배럴은 선언 테이블·타입·순수 조회 함수만 노출한다.
export {
  REALM,
  SPELL_NO,
  SPELL_CATALOG,
  OSPELL_GRID,
  spellByNo,
  ospellOf,
  type Realm,
  type SpellFamily,
  type SpellEntry,
  type OspellEntry,
} from './magic/catalog.js'

export { emptySpellStore, isKnown, setKnown, SPELL_STORE_BYTES } from './magic/spellStore.js'
