import type { Caster } from './caster.js'
import { INVINCIBLE } from '../combat/constants.js'

/**
 * 시전 게이트 — how==CAST일 때만 활성화되는 마나·클래스·knowledge 3게이트(magic8.c cast 게이트).
 *
 * gated 플래그로 CAST(gated=true) vs 아이템(gated=false) 경로를 단일화한다:
 *   - gated=false: 세 게이트를 **전부 우회**한다(A6 §1). scroll/potion/wand는 마나·클래스·주문 보유를
 *     묻지 않고 담긴 주문을 그대로 발동한다 — 콘텐츠(아이템 효과)를 규칙(시전 자격)으로 막지 않는다.
 *   - gated=true: 마나 → 클래스 → knowledge 순으로 판정하고 첫 실패에서 멈춘다.
 *
 * 마나 소비(applyCastGate)는 gated=true 통과 경로에서만 발생한다(A6 §2) — 실패·아이템 경로는 미소비.
 * 유일한 부수효과는 caster.mpCurrent write-through이며, 나머지는 순수 평가다.
 */

/** 게이트 실패 사유 — 통과면 null. mana/class/knowledge는 gated=true에서만 나온다. */
export type GateFailure = 'mana' | 'class' | 'knowledge' | null

/** 게이트 평가 결과 — 통과 여부 + 실패 사유(통과면 null). */
export interface GateResult {
  readonly passed: boolean
  readonly failure: GateFailure
}

/**
 * 시전 요구 — 마나 비용·(선택)허용 클래스·주문번호. requiredClasses 미지정이면 클래스 무제한이다.
 */
export interface CastRequirement {
  readonly manaCost: number
  /** 허용 클래스 목록. 미지정이면 클래스 게이트를 걸지 않는다(무제한). */
  readonly requiredClasses?: readonly number[]
  readonly spellNo: number
}

/** 통과 결과 상수 — 우회·통과 경로가 공유한다. */
const PASS: GateResult = { passed: true, failure: null }

/**
 * 게이트를 평가한다(순수 — 마나 미소비). gated=false면 즉시 통과, gated=true면 마나→클래스→knowledge
 * 순서로 첫 실패를 반환한다.
 */
export function evaluateGate(caster: Caster, req: CastRequirement, gated: boolean): GateResult {
  // 아이템 경로(gated=false) — 전 게이트 우회(A6 §1 콘텐츠 보존).
  if (!gated) return PASS

  // ① 마나 — mpCurrent < manaCost면 실패(== 은 통과, < 만 실패).
  if (caster.mpCurrent < req.manaCost) return { passed: false, failure: 'mana' }

  // ② 클래스 — requiredClasses가 있고 그 안에 없으며 class < INVINCIBLE이면 실패.
  //    INVINCIBLE↑(운영진·초인)는 클래스 게이트를 우회한다(A6 §3). requiredClasses 미지정이면 무제한.
  if (
    req.requiredClasses !== undefined &&
    !req.requiredClasses.includes(caster.class) &&
    caster.class < INVINCIBLE
  ) {
    return { passed: false, failure: 'class' }
  }

  // ③ knowledge — 주문 미보유면 실패.
  if (!caster.knows(req.spellNo)) return { passed: false, failure: 'knowledge' }

  return PASS
}

/**
 * 게이트를 평가하고, gated=true 통과 경로에서만 마나를 소비한다(caster.mpCurrent -= manaCost).
 *
 * ⚠️ 유일한 부수효과: 통과 시 마나 write-through(라이브 소스 감소). 게이트 실패·gated=false는
 * 미소비다(A6 §2). 평가 자체는 evaluateGate에 위임해 순수/부수효과 경계를 분리한다.
 */
export function applyCastGate(caster: Caster, req: CastRequirement, gated: boolean): GateResult {
  const result = evaluateGate(caster, req, gated)
  if (result.passed && gated) {
    caster.mpCurrent -= req.manaCost
  }
  return result
}
