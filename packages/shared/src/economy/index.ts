/**
 * economy 배럴 — 경제 가격 배수 공식(A8 §8)의 단일 출처.
 *
 * 현재는 가격 배수 테이블·순수 함수 4종만 노출한다. 은행·거래 거부 등 후속 경제 규칙은
 * 이 배럴에 추가된다.
 */

// priceConfig — 구매·몹구매·판매·수리 가격 공식 + 선언적 상수 테이블.
export { PRICE_CONFIG, buyPrice, mobBuyPrice, sellPrice, repairCost } from './priceConfig.js'

// carry — 소지 한계(재귀 무게 합 weightOf + 개수/무게 상한 canCarry) 순수 predicate.
export * from './carry.js'
