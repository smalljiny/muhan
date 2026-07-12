import { z } from 'zod'

/**
 * 골든 fixture 하네스 — 함수별 좁은 골든 fixture의 JSON 포맷·타입 단일 출처.
 *
 * 각 fixture는 한 대상 함수(`fn`)에 대해 oracle 출처 메타(`oracle`)와 입출력 케이스
 * 배열(`cases`)을 담는다. 드라이버는 fixture를 로드해 대상 함수를 각 case의 input으로
 * 실행하고 expected와 대조한다(approve).
 *
 * ## frozen 규약
 * - `generatedAt`·case별 `expected`는 체크인 후 **고정(frozen)**이다. 승인된 fixture는
 *   테스트 실행마다 재계산하지 않고 디스크의 값을 진실로 삼는다.
 * - 재생성은 **수동 트리거**로만 이뤄진다 — 생성기 스크립트를 사람이 직접 실행할 때만
 *   `expected`·`generatedAt`이 갱신된다. 회귀 테스트 도중 자동 재생성은 없다.
 *
 * ## oracle.method 확장 여지
 * - E8-1의 method 값은 항상 `'manual'`이다(사람이 oracle을 손으로 산출).
 * - `'c-compile'`은 원본 C 함수를 컴파일해 oracle을 뽑는 후확장 경로를 위해 enum에
 *   보존하되, E8-1에서는 c-compile 드라이버를 **생성하지 않는다**.
 */

// case 단위 스키마 — input·expected는 z.unknown()(키 필수, 값 임의), note는 선택.
// strictObject: 체크인 fixture의 오타 키(예: notee)를 조용히 수용하지 않고 거부한다.
const caseSchema = z.strictObject({
  input: z.unknown(),
  expected: z.unknown(),
  // 케이스 의도·검증 주의(예: clamp 경계·게임 현실성 미검증)를 검증 가능한 데이터로 표기.
  note: z.string().min(1).optional(),
})

/**
 * 골든 fixture 스키마.
 *
 * `cases`는 `.min(1)`을 강제한다 — 빈 cases는 approve()가 "불일치 0건"으로 무조건
 * 통과하는 vacuous-pass 구멍이므로 스키마 층에서 거부한다.
 */
export const goldenFixtureSchema = z.strictObject({
  // 대상 함수명. 빈 문자열은 무의미하므로 .min(1)로 거부.
  fn: z.string().min(1),
  oracle: z.strictObject({
    // E8-1은 항상 'manual'. 'c-compile'은 후확장 여지(드라이버 미생성).
    method: z.enum(['manual', 'c-compile']),
    // oracle 출처(예: C 파일:라인 또는 참조 구현 설명).
    source: z.string().min(1),
    // ISO 타임스탬프 문자열. 체크인 후 frozen. ISO datetime 형식을 강제한다.
    generatedAt: z.iso.datetime(),
    // nullable이되 non-optional — 키는 반드시 존재, 값은 number 또는 null.
    seed: z.number().nullable(),
  }),
  cases: z.array(caseSchema).min(1),
})

// z.infer로 파생한 base 타입 — cases는 unknown input/expected로 넓게 추론된다.
type GoldenFixtureBase = z.infer<typeof goldenFixtureSchema>

/**
 * 골든 fixture 제네릭 wrapper — input·expected 타입을 파라미터화한다.
 *
 * 이 프로젝트 규약은 "도메인 타입은 z.infer로만 파생(수기 type 병행 금지)"이지만,
 * 그 규칙은 *도메인* 타입 대상이다. `GoldenFixture`는 하네스 **인프라** 타입이고,
 * z.infer는 제네릭 파라미터화가 불가능하므로 손수 제네릭 wrapper가 정당한 예외다.
 * base(fn·oracle)는 여전히 infer하고, `cases`만 제네릭으로 오버라이드한다 —
 * 리뷰어는 이 선언을 z.infer-only 규칙 위반으로 오인하지 않는다.
 */
export type GoldenFixture<I = unknown, O = unknown> = Omit<GoldenFixtureBase, 'cases'> & {
  cases: { input: I; expected: O; note?: string }[]
}
