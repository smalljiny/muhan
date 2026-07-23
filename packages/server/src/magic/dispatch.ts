import { spellByNo } from 'shared'

/**
 * 주문번호 → 핸들러 디스패치.
 *
 * ## 범위 (family-agnostic 등록 — #85 G7 enabler)
 * 입력 키는 **주문번호(spellNo)**다 — 한글 주문명 → spellNo 해소는 command router 소관(본 토픽 밖).
 * register/resolve는 offensive·비-offensive를 가리지 않는다(family-agnostic):
 *   - 카탈로그 주문(offensive 20 + 비-offensive 36 = 56) → 등록 가능한 핸들러 슬롯.
 *   - 카탈로그 밖 주문 → register가 throw, resolve는 undefined(미등록과 동일 관례).
 * 비-offensive effect(S7 resistBuff·S8 debuff·S9 timed·S10 instant)는 각자 자체 SpellDispatch<H>
 * 인스턴스를 소유한다(핸들러 타입 이질성 — 단일 핸들러 타입 강제 금지).
 *
 * 핸들러 형태(H)는 제네릭으로 열어 둔다 — 소비자(offensiveSpell·effect 모듈)가 실 형태를 결정한다.
 */

/** resolve 결과 — 등록 핸들러(H) | undefined(미등록·카탈로그 밖). */
export type ResolveResult<H> = H | undefined

/**
 * 주문번호 → 핸들러 디스패처. Map 기반 O(1) 조회(선형 탐색 금지 — cast는 per-round hot path).
 *
 * @typeParam H 핸들러 형태 — 소비자가 결정한다(effect 타입별로 독립 인스턴스).
 */
export class SpellDispatch<H> {
  private readonly handlers = new Map<number, H>()

  /**
   * 카탈로그 주문번호에 핸들러를 등록한다. 카탈로그 밖 주문만 거부한다
   * (offensive·비-offensive 모두 등록 가능 — family-agnostic).
   */
  register(spellNo: number, handler: H): void {
    const entry = spellByNo(spellNo)
    if (!entry) {
      throw new Error(`unknown spellNo: ${spellNo}`)
    }
    this.handlers.set(spellNo, handler)
  }

  /**
   * 주문번호를 핸들러 슬롯으로 해소한다. register가 카탈로그 멤버십을 이미 강제하므로
   * handlers는 항상 유효 주문만 담는다 — 등록 핸들러를 반환하고, 미등록(카탈로그 밖 포함)이면 undefined.
   */
  resolve(spellNo: number): ResolveResult<H> {
    return this.handlers.get(spellNo)
  }
}
