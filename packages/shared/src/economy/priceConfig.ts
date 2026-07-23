/**
 * 경제 가격 배수 — 구매·몹구매·판매·수리 4대 거래 가격 공식(A8 §8)의 순수 정본.
 *
 * 원본은 배수·상한·하한을 각 명령 핸들러에 흩어 하드코딩한다(구매 `command7.c:169`,
 * 판매 `command7.c:258`, 수리 `command8.c:249`, 몹구매 `command10.c:573`). 이 모듈은
 * 그 상수들을 **선언적 테이블 `PRICE_CONFIG`** 하나로 모으고, 네 함수는 이 테이블만
 * 소비한다 — 배수를 바꾸려면 상수 한 곳만 고치면 된다.
 *
 * ## 정수 나눗셈: Math.trunc
 * 원본 C의 `value/2`·`value/4`는 정수 나눗셈(0 방향 절삭)이다. `value`는 항상 비음수라
 * `Math.floor`와 결과가 같지만, oracle의 C 정수 나눗셈 의미를 명시하려고 `Math.trunc`를
 * 쓴다. 입력 검증은 두지 않는다 — 소비자는 항상 검증된 `object.value`(비음수)를 넘긴다.
 *
 * ## 형상 경계
 * `gold` 자체의 상한·음수 가드(원본 무가드, A8 §10-d)는 이 모듈의 관심사가 아니다.
 * 여기선 단일 거래의 가격 산술만 순수하게 소유한다.
 */

/**
 * 가격 공식 상수 테이블(선언적 배수). 네 함수가 인라인 리터럴 대신 이 객체를 판독한다.
 * - `mobFloor`: 몹 상점 구매가 하한(`MAX(10, value)`).
 * - `sellCap`: 전당포 판매가 상한(`MIN(value/2, 100000)`).
 * - `sellDivisor`: 판매가 제수(50% = /2).
 * - `repairDivisor`: 수리비 제수(25% = /4).
 */
export const PRICE_CONFIG = {
  mobFloor: 10,
  sellCap: 100000,
  sellDivisor: 2,
  repairDivisor: 4,
} as const

/** 구매가 = 정가(value 그대로). 상점은 복제·무소진이므로 배수 1이다(`command7.c:169`). */
export function buyPrice(value: number): number {
  return value
}

/** 몹 상점 구매가 = `max(mobFloor, value)`. 저가 아이템도 최소 10골드를 받는다(`command10.c:573`). */
export function mobBuyPrice(value: number): number {
  return Math.max(PRICE_CONFIG.mobFloor, value)
}

/** 전당포 판매가 = `min(trunc(value/2), sellCap)`. 50% 환급, 10만 상한(`command7.c:258`). */
export function sellPrice(value: number): number {
  return Math.min(Math.trunc(value / PRICE_CONFIG.sellDivisor), PRICE_CONFIG.sellCap)
}

/** 수리비 = `trunc(value/4)`. 정가의 25%(`command8.c:249`). */
export function repairCost(value: number): number {
  return Math.trunc(value / PRICE_CONFIG.repairDivisor)
}
