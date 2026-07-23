import { describe, it, expect } from 'vitest'
import {
  dropMoney,
  pickupMoney,
  giveMoney,
  InvalidMoneyAmountError,
  type MoneyDescriptor,
} from './moneyService.js'

/**
 * 금화 경제 순수 함수 단위 테스트 — dropMoney·pickupMoney·giveMoney는 I/O 없는 동기 함수다.
 * MongoDB·Character·ObjectInstance에 의존하지 않고 좁은 숫자 입력만 다루므로, throw는
 * `rejects`가 아니라 `expect(() => ...).toThrow`로 검증한다.
 */
describe('moneyService', () => {
  // 정수·양수 위반 금액(단일 InvalidMoneyAmountError로 거부): 0·음수·소수·NaN.
  const badAmounts: Array<[string, number]> = [
    ['0', 0],
    ['음수', -5],
    ['소수', 1.5],
    ['NaN', Number.NaN],
  ]

  describe('dropMoney', () => {
    it('정상: goldAfter=gold-amt, MONEY 디스크립터를 반환한다', () => {
      const result = dropMoney(100, 30)
      expect(result.goldAfter).toBe(70)
      expect(result.money).toEqual({ objnum: 0, type: 10, value: 30 })
    })

    it('amt==gold 경계: 전액 드롭 시 goldAfter=0, 디스크립터 value=amt', () => {
      const { goldAfter, money } = dropMoney(500, 500)
      expect(goldAfter).toBe(0)
      expect(money.objnum).toBe(0)
      expect(money.type).toBe(10)
      expect(money.value).toBe(500)
    })

    it.each(badAmounts)('amt가 %s면 InvalidMoneyAmountError를 던진다', (_label, amt) => {
      expect(() => dropMoney(100, amt)).toThrow(InvalidMoneyAmountError)
    })

    it('amt > gold면 InvalidMoneyAmountError를 던진다', () => {
      expect(() => dropMoney(100, 101)).toThrow(InvalidMoneyAmountError)
    })

    it('반환 디스크립터는 매번 새 객체다(불변)', () => {
      const a = dropMoney(100, 40)
      const b = dropMoney(100, 40)
      expect(a.money).not.toBe(b.money)
      expect(a.money).toEqual(b.money)
    })
  })

  describe('pickupMoney', () => {
    it('MONEY value를 gold에 흡수한다: goldAfter=gold+money.value', () => {
      const money: MoneyDescriptor = { objnum: 0, type: 10, value: 250 }
      const result = pickupMoney(100, money)
      expect(result.goldAfter).toBe(350)
    })

    it('입력 money를 변이하지 않는다(불변)', () => {
      const money: MoneyDescriptor = { objnum: 0, type: 10, value: 250 }
      pickupMoney(100, money)
      expect(money).toEqual({ objnum: 0, type: 10, value: 250 })
    })
  })

  describe('giveMoney', () => {
    it('정상: from-=amt, to+=amt (수수료 0)', () => {
      const result = giveMoney(100, 50, 30)
      expect(result.fromGoldAfter).toBe(70)
      expect(result.toGoldAfter).toBe(80)
    })

    it.each(badAmounts)('amt가 %s면 InvalidMoneyAmountError를 던진다', (_label, amt) => {
      expect(() => giveMoney(100, 50, amt)).toThrow(InvalidMoneyAmountError)
    })

    it('amt > fromGold면 InvalidMoneyAmountError를 던진다', () => {
      expect(() => giveMoney(100, 50, 101)).toThrow(InvalidMoneyAmountError)
    })

    it('amt==fromGold 경계: 전액 양도 시 fromGoldAfter=0', () => {
      const result = giveMoney(100, 50, 100)
      expect(result.fromGoldAfter).toBe(0)
      expect(result.toGoldAfter).toBe(150)
    })
  })
})
