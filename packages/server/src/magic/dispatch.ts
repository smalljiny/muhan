import { spellByNo } from 'shared'

/**
 * 주문번호 → 핸들러 디스패치.
 *
 * ## 범위 (#84 배선만)
 * 입력 키는 **주문번호(spellNo)**다 — 한글 주문명 → spellNo 해소는 command router 소관(본 토픽 밖).
 * 분기 판정은 SPELL_CATALOG(spellByNo.offensive)를 데이터 원천으로 소비한다(하드코딩 20/36 금지):
 *   - offensive 20 주문 → 등록 가능한 핸들러 슬롯(실 offensiveSpell 등록은 S5).
 *   - 비-offensive 36 주문 → NOT_IMPLEMENTED 마커(#85 유예).
 * offensive 20 + 비-offensive 36 = 카탈로그 56 — 모든 주문이 정확히 한 분기에 안착한다.
 *
 * 핸들러 형태(H)는 제네릭으로 열어 둔다 — S5 offensiveSpell·S6 crtSpell이 실 형태를 결정하며,
 * #84는 spellNo → 핸들러 배선 메커니즘만 제공한다(YAGNI: 핸들러 시그니처를 미리 못박지 않음).
 */

/** 비-offensive 주문의 미구현 마커 — #85가 실 핸들러로 대체할 때까지의 유예 표식. */
export const NOT_IMPLEMENTED = Symbol('spell:not-implemented')
export type NotImplemented = typeof NOT_IMPLEMENTED

/** resolve 결과 — 등록 핸들러(H) | NOT_IMPLEMENTED(비-offensive) | undefined(미등록 offensive·카탈로그 밖). */
export type ResolveResult<H> = H | NotImplemented | undefined

/**
 * 주문번호 → 핸들러 디스패처. Map 기반 O(1) 조회(선형 탐색 금지 — cast는 per-round hot path).
 *
 * @typeParam H 핸들러 형태 — 소비자(S5/S6)가 결정한다.
 */
export class SpellDispatch<H> {
  private readonly handlers = new Map<number, H>()

  /**
   * offensive 주문번호에 핸들러를 등록한다. 카탈로그 밖·비-offensive 주문은 거부한다(등록 가능한
   * 슬롯은 offensive 20종뿐 — 비-offensive는 #85 유예로 NOT_IMPLEMENTED에 고정).
   */
  register(spellNo: number, handler: H): void {
    const entry = spellByNo(spellNo)
    if (!entry) {
      throw new Error(`unknown spellNo: ${spellNo}`)
    }
    if (!entry.offensive) {
      throw new Error(`non-offensive spell is not registrable (#85 유예): ${spellNo}`)
    }
    this.handlers.set(spellNo, handler)
  }

  /**
   * 주문번호를 핸들러 슬롯으로 해소한다:
   *   - 카탈로그 밖 → undefined.
   *   - 비-offensive → NOT_IMPLEMENTED(#85 유예).
   *   - offensive → 등록 핸들러(미등록이면 undefined).
   */
  resolve(spellNo: number): ResolveResult<H> {
    const entry = spellByNo(spellNo)
    if (!entry) {
      return undefined
    }
    if (!entry.offensive) {
      return NOT_IMPLEMENTED
    }
    return this.handlers.get(spellNo)
  }
}
