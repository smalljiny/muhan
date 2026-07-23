/**
 * rand_enchant 확률 순수 함수 — 오라클 object.c `rand_enchant`의 인챈트 확률표를
 * rng 주입으로 재현한다. 적용·저장(per-instance)은 유예하고 delta만 반환한다.
 *
 * 오라클 계약: `m = mrand(1,100)` 포함 구간 [1,100].
 *   m>98 → {99,100}  → adjustment 3, pdice += 3   (2%)
 *   m>90 → {91..98}  → adjustment 2, pdice += 2   (8%)
 *   m>50 → {51..90}  → adjustment 1, pdice += 1   (40%)
 *   m≤50 → {1..50}   → 무변화                       (50%)
 *   합 = 2 + 8 + 40 + 50 = 100%.
 *
 * ⚠️ 스펙 §2/a8 문서의 "+3 3%"는 off-by-one 전사 오차(합 101%)다. 포팅 원칙(동작 충실)에
 *    따라 오라클 실값 `m>98` = 2%를 구현한다. 3%로 "정정"하지 않는다.
 */

/** 오라클 rand_enchant 분기 임계 (mrand(1,100) 초과 비교 기준). */
const THRESHOLD_PLUS3 = 98 // m>98 → {99,100} → +3
const THRESHOLD_PLUS2 = 90 // m>90 → {91..98} → +2
const THRESHOLD_PLUS1 = 50 // m>50 → {51..90} → +1

/**
 * randEnchant 결과 — 순수 delta.
 *
 * - `enchanted`: 인챈트 발생 여부 (draw>50).
 * - `adjustment`: 오라클 adjustment (0/1/2/3). enchant 분기에서만 세팅.
 * - `pdiceDelta`: pdice 증가분 = adjustment. 무변화면 0.
 *
 * 오라클 후처리 `pdice = MAX(pdice, adjustment)`는 per-instance 배선에서 적용한다
 * (본 순수 함수는 delta만 반환). pdice += adjustment 이후이므로 보통 pdice ≥ adjustment가
 * 성립하나, MAX 자체의 적용은 인스턴스 상태를 가지므로 여기서 수행하지 않는다.
 */
export interface EnchantResult {
  readonly enchanted: boolean
  readonly adjustment: number
  readonly pdiceDelta: number
}

/**
 * 인챈트 확률 굴림. `rng(min,max)`는 포함 구간 [min,max] 정수를 낸다
 * (shared `nextIntInRange` + `makeSeededRng` 조합). 전역 난수를 직접 호출하지 않아
 * 시드 주입으로 재현 가능하다.
 *
 * @param rng 포함 구간 정수 생성기 `(min,max)=>number`.
 * @returns EnchantResult 순수 delta (적용·저장 유예).
 */
export function randEnchant(rng: (min: number, max: number) => number): EnchantResult {
  const draw = rng(1, 100)
  if (draw > THRESHOLD_PLUS3) return { enchanted: true, adjustment: 3, pdiceDelta: 3 }
  if (draw > THRESHOLD_PLUS2) return { enchanted: true, adjustment: 2, pdiceDelta: 2 }
  if (draw > THRESHOLD_PLUS1) return { enchanted: true, adjustment: 1, pdiceDelta: 1 }
  return { enchanted: false, adjustment: 0, pdiceDelta: 0 }
}
