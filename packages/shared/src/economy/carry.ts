/**
 * carry — 소지 한계(A8 §8/§13)의 순수 predicate 정본.
 *
 * 원본은 무게 상한(`object.c` `weight_obj` 재귀 + `player.c:1099` `max_weight`)과 개수 상한
 * (구매 200 `command7.c`, 획득/증여/몹구매 150)을 각 명령 핸들러에 흩어 검사한다. 이 모듈은
 * 그 두 판정을 순수 boolean predicate 하나(`canCarry`)로 모으고, 재귀 무게 합(`weightOf`)을
 * 별도 순수 함수로 노출한다. 예외는 던지지 않는다 — 거부 처리(ShopRejectError)는 server 소관.
 *
 * ## OWTLES(무게 없음, bit 7) 재귀 규칙 (결정적 함정)
 * 원본 `weight_obj`는 자식마다 OWTLES를 검사한다. OWTLES 자식은 **자기 무게도 내용물도**
 * 합산에서 제외된다(서브트리 전체 skip). 반면 무게를 재는 **최상위 노드 자신의 무게는 항상**
 * 계산된다 — 최상위 노드의 OWTLES 플래그는 그 부모만 판독하기 때문이다.
 *
 * ## 형상 경계
 * owner·template 해결(무게 없음 플래그를 어디서 읽는지, 인스턴스↔템플릿 병합)은 이 모듈의
 * 관심사가 아니다(#106). 소비자가 순수 `WeightNode` 트리로 구조를 넘긴다.
 */

import { maxWeight } from '../stats/derived.js'
import type { EffectiveStatContext } from '../stats/context.js'

/**
 * 재귀 무게 노드 — 순수 구조 입력. owner/template 해결은 caller 소관(#106).
 *
 * `weightless`(OWTLES, bit 7)는 **부모가 이 노드를 합산에서 제외할지**를 결정하는 플래그다.
 * 노드 자신의 무게 계산에는 영향을 주지 않는다(최상위에서 `weightOf`가 판독하지 않음).
 */
export interface WeightNode {
  readonly weight: number
  readonly weightless: boolean
  readonly contents: readonly WeightNode[]
}

/**
 * 재귀 무게 합 — `object.c` `weight_obj`의 충실한 이식.
 *
 * `n = node.weight`에서 시작해 각 자식을 순회하며, **자식이** weightless가 아닐 때만
 * 그 서브트리 무게를 더한다. 노드 자신의 `weightless`는 여기서 판독하지 않는다 —
 * 최상위 노드의 무게는 항상 계산되고, OWTLES 플래그는 오직 부모의 순회에서만 소비된다.
 */
export function weightOf(node: WeightNode): number {
  let n = node.weight
  for (const child of node.contents) {
    if (!child.weightless) {
      n += weightOf(child)
    }
  }
  return n
}

/** 소지 검사 맥락 — 구매(buy)는 개수 상한 200, 나머지(획득·증여·몹구매)는 150. */
export type CarryMode = 'buy' | 'get' | 'give' | 'purchase'

/** 소지자 상태 — 현재 적재 무게·인벤토리 개수·최대 소지량 산출용 스탯 컨텍스트. */
export interface CarrierState {
  readonly weightCarried: number
  readonly invCount: number
  readonly context: EffectiveStatContext
}

/** 개수 상한 — buy만 200, 그 외 모드는 150. */
function countLimit(mode: CarryMode): number {
  return mode === 'buy' ? 200 : 150
}

/**
 * 소지 가능 여부 — 무게·개수 두 상한을 모두 통과하면 `true`.
 *
 * - 개수: `invCount > limit`이면 불가(strict `>`, 같으면 통과). limit는 buy 200, 그 외 150.
 * - 무게: `weightCarried + weightOf(node) > maxWeight(context)`이면 불가(strict `>`, 같으면 통과).
 *   `maxWeight`는 `stats/derived`가 정본이다 — `20 + str*10 + barbarian` 공식을 재유도하지 않는다.
 *
 * 순수 predicate다 — 거부 시 예외를 던지지 않고 `false`를 반환한다.
 */
export function canCarry(char: CarrierState, node: WeightNode, mode: CarryMode): boolean {
  if (char.invCount > countLimit(mode)) {
    return false
  }
  if (char.weightCarried + weightOf(node) > maxWeight(char.context)) {
    return false
  }
  return true
}
