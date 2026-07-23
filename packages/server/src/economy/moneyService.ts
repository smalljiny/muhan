/**
 * 금화 경제 순수 함수 — A8 §7(금화 경제)의 MONEY-object drop/pickup/give를 gold↔디스크립터
 * 순수 변환으로 이식한다. MongoDB·Character·ObjectInstance에 의존하지 않고 좁은 숫자 입력만
 * 다룬다. 영속화·바닥 배치·소유자 배선은 호출자(#106, 후속 토픽)의 책임이다.
 *
 * D1(스키마 동결): 이 모듈은 shared의 object.ts·character.ts·MAX_* 상수를 import하지 않는다.
 * MoneyDescriptor를 로컬로 정의해 cross-package import를 0으로 유지, 동시 worktree(#85)의
 * schemaVersion bump와 병합 충돌을 원천 차단한다.
 *
 * gold 상한(서비스 계층 강제, min0-only): 금액 가드는 양의 정수(≥1)이며, 어떤 연산도 gold를
 * 음수로 만들지 않는다(amt>gold·amt>fromGold 거부로 보장). 스키마 `.max()`를 도입하지 않는다.
 * 상한 VALUE는 Open Q#3로 유예한다 — bankTransactionService.withdraw가 min0-only인 것과 대칭.
 */

/**
 * MONEY 디스크립터 — 좁은 객체이며 완전한 ObjectInstance가 아니다. objnum 0="동전" 템플릿,
 * type 10=MONEY(A8 §1 taxonomy). A8 §7 die()는 몹 gold를 obj->value=gold인 MONEY 객체로
 * 변환한다. 소유자·영속 필드가 없는 bare 디스크립터다(바닥 배치·소유자 배선은 #106의 몫).
 */
export interface MoneyDescriptor {
  readonly objnum: 0
  readonly type: 10
  readonly value: number
}

/** 금액이 양의 정수(≥1)가 아니거나 보유 gold를 초과할 때 던진다. */
export class InvalidMoneyAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMoneyAmountError'
  }
}

/**
 * amt가 양의 정수(≥1)인지 검증한다. 정수는 `amt < 1` ⟺ `amt <= 0`이므로 0·음수·소수·NaN을
 * 한 번에 거부한다. bankTransactionService.assertPositiveIntAmount 패턴을 따른다.
 */
function assertPositiveIntAmount(amt: number): void {
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new InvalidMoneyAmountError(`금액은 양의 정수여야 합니다: ${amt}`)
  }
}

/**
 * 잔액(gold·fromGold·toGold·money.value)이 0 이상 정수인지 검증한다. 전송 금액(amt)은 ≥1이지만
 * 잔액은 0일 수 있어 assertPositiveIntAmount와 분리한다. NaN 잔액은 amt>gold 비교가 항상 false여서
 * 게이트를 통과하고 NaN 결과를 반환하므로(gold 손실/생성 벡터), 진입점에서 거부한다(self-defense).
 */
function assertNonNegativeIntBalance(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidMoneyAmountError(`${label}는 0 이상의 정수여야 합니다: ${value}`)
  }
}

/**
 * 금화를 바닥에 떨어뜨린다(drop). gold에서 amt를 차감하고 amt를 value로 갖는 MONEY 디스크립터를
 * 만든다. amt<1(=비양수·소수·NaN) 또는 amt>gold면 InvalidMoneyAmountError를 던진다(부분 결과
 * 반환 없음). 반환 money는 소유자 없는 bare 디스크립터다.
 */
export function dropMoney(
  gold: number,
  amt: number,
): { goldAfter: number; money: MoneyDescriptor } {
  assertNonNegativeIntBalance(gold, 'gold')
  assertPositiveIntAmount(amt)
  if (amt > gold) {
    throw new InvalidMoneyAmountError(`보유 gold를 초과합니다: amt=${amt}, gold=${gold}`)
  }
  return { goldAfter: gold - amt, money: { objnum: 0, type: 10, value: amt } }
}

/**
 * 바닥의 금화를 줍는다(pickup). MONEY 디스크립터를 gold에 흡수한다. 객체 자체는 호출자가
 * 소비(free)한다. gold·money.value를 0 이상 정수로 강제한다(self-defense) — NaN/음수 잔액이
 * NaN 결과로 새 나가는 것을 진입점에서 차단한다.
 */
export function pickupMoney(gold: number, money: MoneyDescriptor): { goldAfter: number } {
  assertNonNegativeIntBalance(gold, 'gold')
  assertNonNegativeIntBalance(money.value, 'money.value')
  return { goldAfter: gold + money.value }
}

/**
 * 금화를 건넨다(give). fromGold에서 amt를 차감하고 toGold에 amt를 가산한다. A8 §7 give_money는
 * 세금·수수료가 없다(fee 0). amt<1 또는 amt>fromGold면 InvalidMoneyAmountError를 던진다.
 */
export function giveMoney(
  fromGold: number,
  toGold: number,
  amt: number,
): { fromGoldAfter: number; toGoldAfter: number } {
  assertNonNegativeIntBalance(fromGold, 'fromGold')
  assertNonNegativeIntBalance(toGold, 'toGold')
  assertPositiveIntAmount(amt)
  if (amt > fromGold) {
    throw new InvalidMoneyAmountError(`보유 gold를 초과합니다: amt=${amt}, fromGold=${fromGold}`)
  }
  return { fromGoldAfter: fromGold - amt, toGoldAfter: toGold + amt }
}
