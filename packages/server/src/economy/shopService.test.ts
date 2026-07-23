import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { buyPrice, mobBuyPrice, approve, goldenFixtureSchema } from 'shared'
import { seqRng } from '../combat/dice.testutil.js'
import {
  buy,
  purchase,
  sell,
  ShopRejectError,
  type ShopItem,
  type BuyerState,
  type PawnItem,
  type ShopRejectReason,
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

/**
 * 몹 상점 취득 순수 함수 단위 테스트 — purchase(A8 §8 MPURIT)는 mobBuyPrice(max(10,value))로
 * 게이트하고, get/give/purchase 개수 상한 150을 pre-purchase strict `>`로 검사한다. buy와 달리
 * 가격 하한(floor 10)이 있어, 저가 아이템은 value보다 비싼 최소 10냥을 요구한다.
 */
describe('shopService.purchase', () => {
  const makeItem = (overrides: Partial<ShopItem> = {}): ShopItem => ({
    objnum: 42,
    type: 3,
    value: 100,
    shotscur: 0,
    ...overrides,
  })

  it('정상: goldAfter=gold-price, 아이템 클론을 반환한다', () => {
    const char: BuyerState = { gold: 500, invCount: 5 }
    const item = makeItem({ value: 100 })
    const result = purchase(char, item)
    expect(mobBuyPrice(item.value)).toBe(100)
    expect(result.goldAfter).toBe(400)
    expect(result.item).toEqual({ objnum: 42, type: 3, value: 100, shotscur: 0 })
  })

  it('클론은 입력과 다른 별개 객체다(원본 참조 아님)', () => {
    const char: BuyerState = { gold: 500, invCount: 0 }
    const item = makeItem()
    const result = purchase(char, item)
    expect(result.item).not.toBe(item)
    expect(result.item).toEqual(item)
  })

  it('무한 재고: 입력 템플릿 아이템은 변이되지 않는다(deep-equal 불변)', () => {
    const char: BuyerState = { gold: 999, invCount: 0 }
    const item = makeItem({ objnum: 7, type: 2, value: 250, shotscur: 3 })
    const snapshot = { objnum: 7, type: 2, value: 250, shotscur: 3 }
    purchase(char, item)
    expect(item).toEqual(snapshot)
  })

  it('클론은 소유자 필드가 없는 순수 디스크립터다(넓은 입력의 여분 필드 제거)', () => {
    const char: BuyerState = { gold: 500, invCount: 0 }
    const wide = { objnum: 5, type: 1, value: 50, shotscur: 0, _id: 'x', owner: 'c1' }
    const { item: clone } = purchase(char, wide)
    expect(clone).toEqual({ objnum: 5, type: 1, value: 50, shotscur: 0 })
    expect('_id' in clone).toBe(false)
    expect('owner' in clone).toBe(false)
  })

  it('가격 하한: value=5여도 price=mobBuyPrice=10이다(max(10,value))', () => {
    expect(mobBuyPrice(5)).toBe(10)
  })

  it('하한 경계: value=5, gold=9면 price 10에 못 미쳐 insufficient-gold로 거부한다', () => {
    const char: BuyerState = { gold: 9, invCount: 0 }
    const item = makeItem({ value: 5 })
    expect(() => purchase(char, item)).toThrow(ShopRejectError)
    try {
      purchase(char, item)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('insufficient-gold')
    }
  })

  it('하한 경계: value=5, gold=10이면 price 10 전액 지불로 성공, goldAfter=0', () => {
    const char: BuyerState = { gold: 10, invCount: 0 }
    const item = makeItem({ value: 5 })
    const result = purchase(char, item)
    expect(result.goldAfter).toBe(0)
    expect(result.item).toEqual({ objnum: 42, type: 3, value: 5, shotscur: 0 })
  })

  it('gold<price: insufficient-gold로 거부한다', () => {
    const char: BuyerState = { gold: 99, invCount: 0 }
    const item = makeItem({ value: 100 })
    expect(() => purchase(char, item)).toThrow(ShopRejectError)
    try {
      purchase(char, item)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('insufficient-gold')
    }
  })

  it('count 경계: invCount=149면 성공한다(pre-purchase 149 ≤ 150)', () => {
    const char: BuyerState = { gold: 500, invCount: 149 }
    const item = makeItem({ value: 100 })
    const result = purchase(char, item)
    expect(result.goldAfter).toBe(400)
  })

  it('count 경계: invCount=150이면 성공한다(오라클 strict > — 150 보유자 취득 가능, 151에서 종료)', () => {
    const char: BuyerState = { gold: 500, invCount: 150 }
    const item = makeItem({ value: 100 })
    const result = purchase(char, item)
    expect(result.goldAfter).toBe(400)
  })

  it('count 경계: invCount=151이면 count-limit으로 거부한다(pre-purchase 151 > 150)', () => {
    const char: BuyerState = { gold: 500, invCount: 151 }
    const item = makeItem({ value: 100 })
    expect(() => purchase(char, item)).toThrow(ShopRejectError)
    try {
      purchase(char, item)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('count-limit')
    }
  })
})

/**
 * 전당포 판매 순수 함수 단위 테스트 — sell(A8 §8, command7.c sell)은 거부 매트릭스 5단계 이후
 * 1/250 이중 지급을 주입 rng로 결정적으로 굴린다. 거부 케이스는 rng를 소비하지 않는다(cascade가
 * 먼저 종료). 이중 지급은 오라클 pay-twice(`+= sellPrice`)라 lucky payout = 2*sellPrice다.
 */
describe('shopService.sell', () => {
  const makeItem = (overrides: Partial<PawnItem> = {}): PawnItem => ({
    value: 100,
    type: 13,
    shotscur: 0,
    shotsmax: 0,
    onewev: false,
    hasContents: false,
    ...overrides,
  })

  // 럭키 아닌 굴림(≠9)을 반환하는 rng. success 케이스는 rng를 정확히 1회 소비한다.
  const normalRng = { rng: seqRng([1]) }
  // 빈 시퀀스 — 소비 시 throw한다. 거부 케이스가 rng를 소비하지 않음을 검증하는 데 쓴다.
  const emptyRng = () => ({ rng: seqRng([]) })

  it('정상 지급: payout=sellPrice(50), lucky=false, goldAfter=gold+50', () => {
    const char = { gold: 200 }
    const result = sell(char, makeItem({ value: 100 }), { rng: seqRng([1]) })
    expect(result.payout).toBe(50)
    expect(result.lucky).toBe(false)
    expect(result.goldAfter).toBe(250)
  })

  it('이중 지급: luckyRoll===9 → payout 100(pay-twice=2*50), lucky=true, goldAfter=gold+100', () => {
    const char = { gold: 200 }
    const result = sell(char, makeItem({ value: 100 }), { rng: seqRng([9]) })
    expect(result.payout).toBe(100)
    expect(result.lucky).toBe(true)
    expect(result.goldAfter).toBe(300)
  })

  it('상한 clamp: value=250000 → payout 100000(비럭키)', () => {
    const result = sell({ gold: 0 }, makeItem({ value: 250000 }), { rng: seqRng([1]) })
    expect(result.payout).toBe(100000)
    expect(result.goldAfter).toBe(100000)
  })

  it('low-value 경계: value=40 → payout 20 성공', () => {
    const result = sell({ gold: 0 }, makeItem({ value: 40 }), { rng: seqRng([1]) })
    expect(result.payout).toBe(20)
  })

  it('low-value 거부: value=39(payout 19<20) → low-value', () => {
    expect(() => sell({ gold: 0 }, makeItem({ value: 39 }), normalRng)).toThrow(ShopRejectError)
    try {
      sell({ gold: 0 }, makeItem({ value: 39 }), normalRng)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('low-value')
    }
  })

  // reject 사유 단언 헬퍼 — non-throw 시 catch를 건너뛰어 vacuous가 되지 않도록 toThrow 가드를
  // 먼저 세운 뒤 reason을 검증한다(low-value 테스트 패턴과 동일).
  const expectReject = (item: PawnItem, reason: ShopRejectReason): void => {
    expect(() => sell({ gold: 0 }, item, normalRng)).toThrow(ShopRejectError)
    try {
      sell({ gold: 0 }, item, normalRng)
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe(reason)
    }
  }

  it('low-quality 무기 거부: type=0 shotsmax=80 shotscur=10(<=trunc(80/8)=10) → low-quality', () => {
    expectReject(makeItem({ type: 0, shotsmax: 80, shotscur: 10 }), 'low-quality')
  })

  it('low-quality 무기 경계: shotscur=11(>10) → 판매 성공 payout 50', () => {
    const item = makeItem({ type: 0, shotsmax: 80, shotscur: 11 })
    const result = sell({ gold: 0 }, item, { rng: seqRng([1]) })
    expect(result.payout).toBe(50)
  })

  it('low-quality 완드 거부: type=8 shotscur=0(<1) → low-quality', () => {
    expectReject(makeItem({ type: 8, shotscur: 0 }), 'low-quality')
  })

  it('low-quality 완드 경계: type=8 shotscur=1 → 판매 성공 payout 50', () => {
    const item = makeItem({ type: 8, shotscur: 1 })
    const result = sell({ gold: 0 }, item, { rng: seqRng([1]) })
    expect(result.payout).toBe(50)
  })

  it('bound 거부: onewev=true → bound-item', () => {
    expectReject(makeItem({ onewev: true }), 'bound-item')
  })

  it('container 거부: hasContents=true → non-empty-container', () => {
    expectReject(makeItem({ hasContents: true }), 'non-empty-container')
  })

  it('unsellable 거부: SCROLL(7) → unsellable-type', () => {
    expectReject(makeItem({ type: 7 }), 'unsellable-type')
  })

  it('unsellable 거부: POTION(6) → unsellable-type', () => {
    expectReject(makeItem({ type: 6 }), 'unsellable-type')
  })

  // cascade 순서 고정 — 여러 게이트를 동시에 어기는 아이템은 오라클 cascade 첫 매칭(bound-item이
  // container·unsellable보다 먼저)을 낸다. 단일 게이트 케이스만으로는 순서가 고정되지 않는다.
  it('다중 게이트: onewev=true + type=SCROLL(7) → 먼저 걸리는 bound-item', () => {
    expectReject(makeItem({ onewev: true, type: 7 }), 'bound-item')
  })

  // roll-after-reject 불변식: 거부 케이스는 rng를 소비하지 않는다. 빈 seqRng를 넘겨도
  // ShopRejectError만 나야 한다 — 굴림이 cascade 앞에 잘못 놓이면 "시퀀스 소진"이 대신 난다.
  it('거부 케이스는 rng를 소비하지 않는다: 빈 seqRng로도 ShopRejectError만 throw', () => {
    expect(() => sell({ gold: 0 }, makeItem({ value: 39 }), emptyRng())).toThrow(ShopRejectError)
    expect(() => sell({ gold: 0 }, makeItem({ onewev: true }), emptyRng())).toThrow(ShopRejectError)
    expect(() => sell({ gold: 0 }, makeItem({ type: 7 }), emptyRng())).toThrow(ShopRejectError)
  })

  it('입력 아이템은 변이되지 않는다(deep-equal 불변)', () => {
    const item = makeItem({ value: 100, type: 0, shotsmax: 80, shotscur: 11 })
    const snapshot = { value: 100, type: 0, shotscur: 11, shotsmax: 80, onewev: false, hasContents: false }
    sell({ gold: 0 }, item, { rng: seqRng([1]) })
    expect(item).toEqual(snapshot)
  })
})

// T5.4 — 체크인된 pawn.json 골든 fixture를 런타임 sell SUT로 교차검증한다. 각 case의 input을
// seqRng([luckyRoll])와 함께 sell에 디스패치한다. 거부는 ShopRejectError를 잡아
// {rejectReason, payout:0}로, 성공은 {rejectReason:null, payout}로 정규화한다(거부는 rng 미소비,
// 성공은 1회 소비). negative control(버그 주입) 없으면 approval이 vacuous하므로 함께 둔다.
type PawnCaseInput = {
  value: number
  type: number
  shotscur: number
  shotsmax: number
  onewev: boolean
  hasContents: boolean
  luckyRoll: number
}

function dispatchPawn(input: PawnCaseInput): { rejectReason: string | null; payout: number } {
  const item: PawnItem = {
    value: input.value,
    type: input.type,
    shotscur: input.shotscur,
    shotsmax: input.shotsmax,
    onewev: input.onewev,
    hasContents: input.hasContents,
  }
  try {
    const result = sell({ gold: 0 }, item, { rng: seqRng([input.luckyRoll]) })
    return { rejectReason: null, payout: result.payout }
  } catch (err) {
    if (err instanceof ShopRejectError) return { rejectReason: err.reason, payout: 0 }
    throw err
  }
}

describe('런타임 pawn SUT 골든 교차검증 (T5.4)', () => {
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/pawn.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('pawn.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 sell SUT로 전 케이스를 throw 없이 통과한다(거부 매트릭스·정상·이중·상한)', () => {
    const fixture = loadFixture()
    const sut = (input: unknown) => dispatchPawn(input as PawnCaseInput)
    expect(() => approve(fixture, sut)).not.toThrow()
  })

  it('버그 주입 변형(payout+1)에는 approve가 throw한다 (negative control)', () => {
    const fixture = loadFixture()
    const buggy = (input: unknown) => {
      const out = dispatchPawn(input as PawnCaseInput)
      return { rejectReason: out.rejectReason, payout: out.payout + 1 }
    }
    expect(() => approve(fixture, buggy)).toThrow()
  })
})
