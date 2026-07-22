import type { ResolveContext } from '../combat/resolveAttack.js'

/**
 * CastContext — 시전 파이프의 실행 컨텍스트. ResolveContext(전투 해석 컨텍스트)를 그대로 확장해
 * `gated` 한 필드만 더한다.
 *
 * ## gated가 how==CAST 게이트를 단일화하는 이유
 * 원작은 시전 진입점이 `how`(CAST vs scroll/potion/wand)에 따라 마나·클래스·knowledge 게이트를
 * 조건 분기했다. 이 포트는 그 분기 전체를 boolean `gated` 하나로 접는다 — 게이트 평가부(gate.ts)는
 * `if (!gated) return pass`로 아이템 경로를 단번에 우회하고(A6 §1 콘텐츠 보존), CAST 경로만
 * 세 게이트를 태운다. 개별 how 코드 대신 단일 플래그를 쓰면 소비자(S5 offensive·S6 crt)가 경로
 * 구분을 한 곳에서만 신경 쓴다.
 *
 * ResolveContext를 intersection으로 재사용해 rng·room·now·death seam·ledger를 중복 정의하지 않는다 —
 * 필드가 갈라지면 전투·마법이 서로 다른 컨텍스트로 표류한다.
 */
export type CastContext = ResolveContext & {
  /** true=CAST(마나·클래스·knowledge 게이트 활성), false=아이템(전 게이트 우회·마나 미소비). */
  readonly gated: boolean
}
