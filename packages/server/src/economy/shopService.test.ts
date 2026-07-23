import { describe, it, expect } from 'vitest'
import { buyPrice } from 'shared'
import {
  buy,
  ShopRejectError,
  type ShopItem,
  type BuyerState,
} from './shopService.js'

/**
 * 상점 구매 순수 함수 단위 테스트 — buy는 I/O 없는 동기 함수다. MongoDB·Character·
 * ObjectInstance에 의존하지 않고 좁은 구조 입력(ShopItem·BuyerState)만 다루므로, throw는
 * `rejects`가 아니라 `expect(() => ...).toThrow`로 검증한다. 상점은 복제·무소진이므로
 * 입력 shopItem은 절대 변이되지 않는다(재고 원본 무소진).
 */
describe('shopService.buy', () => {
  const makeItem = (overrides: Partial<ShopItem> = {}): ShopItem => ({
    objnum: 42,
    type: 3,
    value: 100,
    shotscur: 0,
    ...overrides,
  })

  it('정상: goldAfter=gold-value, 아이템 클론을 반환한다', () => {
    const char: BuyerState = { gold: 500, invCount: 5 }
    const item = makeItem({ value: 100 })
    const result = buy(char, item)
    expect(result.goldAfter).toBe(400)
    expect(buyPrice(item.value)).toBe(100)
    expect(result.item).toEqual({ objnum: 42, type: 3, value: 100, shotscur: 0 })
  })

  it('클론은 입력과 다른 별개 객체다(원본 참조 아님)', () => {
    const char: BuyerState = { gold: 500, invCount: 0 }
    const item = makeItem()
    const result = buy(char, item)
    expect(result.item).not.toBe(item)
    expect(result.item).toEqual(item)
  })

  it('재고 원본 무소진: 입력 shopItem은 변이되지 않는다(deep-equal 불변)', () => {
    const char: BuyerState = { gold: 999, invCount: 0 }
    const item = makeItem({ objnum: 7, type: 2, value: 250, shotscur: 3 })
    const snapshot = { objnum: 7, type: 2, value: 250, shotscur: 3 }
    buy(char, item)
    expect(item).toEqual(snapshot)
  })

  it('클론 필드 충실도: 모든 좁은 필드가 정확히 복사된다', () => {
    const char: BuyerState = { gold: 1000, invCount: 0 }
    const item = makeItem({ objnum: 88, type: 9, value: 42, shotscur: 12 })
    const { item: clone } = buy(char, item)
    expect(clone.objnum).toBe(88)
    expect(clone.type).toBe(9)
    expect(clone.value).toBe(42)
    expect(clone.shotscur).toBe(12)
  })

  it('클론은 소유자 필드가 없는 순수 디스크립터다(넓은 입력의 여분 필드 제거)', () => {
    const char: BuyerState = { gold: 500, invCount: 0 }
    // 호출자가 완전한 인스턴스를 넘겨도 _id·owner 같은 여분 필드는 클론에서 제거된다.
    const wide = { objnum: 5, type: 1, value: 50, shotscur: 0, _id: 'x', owner: 'c1' }
    const { item: clone } = buy(char, wide)
    expect(clone).toEqual({ objnum: 5, type: 1, value: 50, shotscur: 0 })
    expect('_id' in clone).toBe(false)
    expect('owner' in clone).toBe(false)
  })

  it('gold<value: insufficient-gold로 거부한다', () => {
    const char: BuyerState = { gold: 99, invCount: 0 }
    const item = makeItem({ value: 100 })
    expect(() => buy(char, item)).toThrow(ShopRejectError)
    try {
      buy(char, item)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('insufficient-gold')
    }
  })

  it('gold==value 경계: 전액 지불 시 성공, goldAfter=0', () => {
    const char: BuyerState = { gold: 100, invCount: 0 }
    const item = makeItem({ value: 100 })
    const result = buy(char, item)
    expect(result.goldAfter).toBe(0)
  })

  it('count 경계: invCount=199면 성공한다(pre-purchase 199 ≤ 200)', () => {
    const char: BuyerState = { gold: 500, invCount: 199 }
    const item = makeItem({ value: 100 })
    const result = buy(char, item)
    expect(result.goldAfter).toBe(400)
  })

  it('count 경계: invCount=200이면 성공한다(오라클 strict > — 200 보유자 구매 가능, 201에서 종료)', () => {
    const char: BuyerState = { gold: 500, invCount: 200 }
    const item = makeItem({ value: 100 })
    const result = buy(char, item)
    expect(result.goldAfter).toBe(400)
  })

  it('count 경계: invCount=201이면 count-limit으로 거부한다(pre-purchase 201 > 200)', () => {
    const char: BuyerState = { gold: 500, invCount: 201 }
    const item = makeItem({ value: 100 })
    expect(() => buy(char, item)).toThrow(ShopRejectError)
    try {
      buy(char, item)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('count-limit')
    }
  })
})
