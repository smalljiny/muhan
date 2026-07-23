import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { buyPrice, mobBuyPrice, repairCost, approve, goldenFixtureSchema } from 'shared'
import { seqRng } from '../combat/dice.testutil.js'
import {
  buy,
  purchase,
  sell,
  repair,
  ShopRejectError,
  type ShopItem,
  type BuyerState,
  type PawnItem,
  type RepairItem,
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

/**
 * 아이템 수리 순수 함수 단위 테스트 — repair(A8 §8 RREPAI, command8.c)는 수리비 선차감 후
 * piety 보정 실패 굴림을 던진다. 실패 시 환불(net 0)+파괴, 성공 시 내구도 복원(shotsmax*mrand(5,9)/10,
 * 곱 위에서 절삭). RNG 순서: broke(1,100) 먼저, 성공 시에만 durability(5,9). 실패는 굴림 1회, 성공은 2회.
 */
describe('shopService.repair', () => {
  const makeItem = (overrides: Partial<RepairItem> = {}): RepairItem => ({
    value: 100,
    shotscur: 0,
    shotsmax: 80,
    ...overrides,
  })

  it('실패: piety=10 broke=15, shotscur<1 → broken, item=null, 환불(goldAfter=gold)', () => {
    const char = { gold: 500, piety: 10 }
    const result = repair(char, makeItem({ shotscur: 0 }), { rng: seqRng([15]) })
    expect(result.broke).toBe(15)
    expect(result.broken).toBe(true)
    expect(result.item).toBe(null)
    expect(result.goldAfter).toBe(500)
  })

  it('성공: piety=10 broke=16, shotscur<1 → 복원 trunc(80*5/10)=40, goldAfter=gold-cost', () => {
    const char = { gold: 500, piety: 10 }
    const result = repair(char, makeItem({ shotscur: 0 }), { rng: seqRng([16, 5]) })
    expect(result.broke).toBe(16)
    expect(result.broken).toBe(false)
    expect(result.item).toEqual({ value: 100, shotscur: 40, shotsmax: 80 })
    expect(result.goldAfter).toBe(475)
  })

  it('실패 임계값: piety=10 broke=5, shotscur>0 → broken', () => {
    const char = { gold: 500, piety: 10 }
    const result = repair(char, makeItem({ shotscur: 1 }), { rng: seqRng([5]) })
    expect(result.broke).toBe(5)
    expect(result.broken).toBe(true)
    expect(result.item).toBe(null)
  })

  it('성공 임계값: piety=10 broke=6, shotscur=1(>0, not<1) → 복원 trunc(80*9/10)=72', () => {
    const char = { gold: 500, piety: 10 }
    const result = repair(char, makeItem({ shotscur: 1 }), { rng: seqRng([6, 9]) })
    expect(result.broke).toBe(6)
    expect(result.broken).toBe(false)
    expect(result.item?.shotscur).toBe(72)
  })

  it('bonusOf 통합: piety=0 → bonusOf(0)=-4, brokeRoll=19 → broke=15 → 실패', () => {
    const char = { gold: 500, piety: 0 }
    const result = repair(char, makeItem({ shotscur: 0 }), { rng: seqRng([19]) })
    expect(result.broke).toBe(15)
    expect(result.broken).toBe(true)
  })

  it('bonusOf 통합: piety=0 → brokeRoll=20 → broke=16 → 성공', () => {
    const char = { gold: 500, piety: 0 }
    const result = repair(char, makeItem({ shotscur: 0 }), { rng: seqRng([20, 5]) })
    expect(result.broke).toBe(16)
    expect(result.broken).toBe(false)
    expect(result.item?.shotscur).toBe(40)
  })

  it('내구도 trunc 트랩: shotsmax=85 durabilityRoll=7 → trunc(85*7/10)=trunc(59.5)=59', () => {
    const char = { gold: 500, piety: 10 }
    const result = repair(char, makeItem({ shotsmax: 85, shotscur: 1 }), { rng: seqRng([50, 7]) })
    expect(result.item?.shotscur).toBe(59)
  })

  it('내구도 trunc 트랩: shotsmax=80 roll=5 → 40, roll=9 → 72', () => {
    const char = { gold: 500, piety: 10 }
    const r5 = repair(char, makeItem({ shotsmax: 80, shotscur: 1 }), { rng: seqRng([50, 5]) })
    const r9 = repair(char, makeItem({ shotsmax: 80, shotscur: 1 }), { rng: seqRng([50, 9]) })
    expect(r5.item?.shotscur).toBe(40)
    expect(r9.item?.shotscur).toBe(72)
  })

  it('cost: value=100 → cost 25(goldAfter=gold-25); value=39 → cost 9', () => {
    const char = { gold: 500, piety: 10 }
    const r100 = repair(char, makeItem({ value: 100, shotscur: 1 }), { rng: seqRng([50, 5]) })
    const r39 = repair(char, makeItem({ value: 39, shotscur: 1 }), { rng: seqRng([50, 5]) })
    expect(repairCost(100)).toBe(25)
    expect(repairCost(39)).toBe(9)
    expect(r100.goldAfter).toBe(475)
    expect(r39.goldAfter).toBe(491)
  })

  it('gold 게이트: gold==cost 경계는 성공한다(전액 지불, goldAfter=0)', () => {
    const char = { gold: 25, piety: 10 }
    const result = repair(char, makeItem({ value: 100, shotscur: 1 }), { rng: seqRng([50, 5]) })
    expect(result.broken).toBe(false)
    expect(result.goldAfter).toBe(0)
  })

  it('gold 게이트: gold==cost-1이면 insufficient-gold로 거부한다', () => {
    const char = { gold: 24, piety: 10 }
    expect(() => repair(char, makeItem({ value: 100 }), { rng: seqRng([50, 5]) })).toThrow(
      ShopRejectError,
    )
    try {
      repair(char, makeItem({ value: 100 }), { rng: seqRng([50, 5]) })
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('insufficient-gold')
    }
  })

  it('gold 게이트는 굴림보다 먼저다: 빈 seqRng로도 insufficient-gold만 throw(굴림 미소비)', () => {
    const char = { gold: 0, piety: 10 }
    expect(() => repair(char, makeItem({ value: 100 }), { rng: seqRng([]) })).toThrow(
      ShopRejectError,
    )
  })

  it('RNG 소비: 성공은 굴림 2회 소비 — seqRng([broke])만 주면 소진 throw', () => {
    const char = { gold: 500, piety: 10 }
    // brokeRoll만 담고 durabilityRoll을 누락 → 성공 경로가 2번째 굴림을 시도하면 소진 throw.
    expect(() => repair(char, makeItem({ shotscur: 1 }), { rng: seqRng([50]) })).toThrow(
      /시퀀스 소진/,
    )
  })

  it('RNG 소비: 실패는 굴림 1회만 — seqRng([broke])로 소진 없이 완료', () => {
    const char = { gold: 500, piety: 10 }
    // broke=15, shotscur<1 → 실패 → durability 미굴림. 1개짜리 seqRng로 소진 throw가 없어야 한다.
    const result = repair(char, makeItem({ shotscur: 0 }), { rng: seqRng([15]) })
    expect(result.broken).toBe(true)
  })

  it('순수성: 실패 경로에서 char·item을 변이하지 않는다(deep-equal 불변)', () => {
    const char = { gold: 500, piety: 10 }
    const charSnapshot = { gold: 500, piety: 10 }
    const item = makeItem({ value: 100, shotscur: 0, shotsmax: 80 })
    const itemSnapshot = { value: 100, shotscur: 0, shotsmax: 80 }
    repair(char, item, { rng: seqRng([15]) })
    expect(char).toEqual(charSnapshot)
    expect(item).toEqual(itemSnapshot)
  })

  it('순수성: 성공 경로에서 char·item을 변이하지 않는다(deep-equal 불변)', () => {
    const char = { gold: 500, piety: 10 }
    const charSnapshot = { gold: 500, piety: 10 }
    const item = makeItem({ value: 100, shotscur: 1, shotsmax: 80 })
    const itemSnapshot = { value: 100, shotscur: 1, shotsmax: 80 }
    const result = repair(char, item, { rng: seqRng([50, 5]) })
    expect(char).toEqual(charSnapshot)
    expect(item).toEqual(itemSnapshot)
    // 반환 item은 입력과 다른 별개 객체다.
    expect(result.item).not.toBe(item)
  })
})

// T-style 골든 교차검증 — 체크인된 repair.json을 런타임 repair SUT로 디스패치한다. 각 case의 input을
// seqRng([brokeRoll, durabilityRoll])와 함께 repair에 넘긴다. cost는 실패 시 refund로 관측 불가하므로
// repairCost(value)로, 성공 시 char.gold-goldAfter(SUT의 실제 청구)로 매핑한다. newShotscur는 파괴 시
// null. gold는 항상 충분하게 준다(golden은 역학 검증 전용, gold 게이트는 단위 테스트가 커버).
type RepairCaseInput = {
  value: number
  shotscur: number
  shotsmax: number
  piety: number
  brokeRoll: number
  durabilityRoll: number
}

function dispatchRepair(input: RepairCaseInput): {
  broken: boolean
  cost: number
  newShotscur: number | null
} {
  const char = { gold: 1_000_000, piety: input.piety }
  const item: RepairItem = {
    value: input.value,
    shotscur: input.shotscur,
    shotsmax: input.shotsmax,
  }
  try {
    const result = repair(char, item, { rng: seqRng([input.brokeRoll, input.durabilityRoll]) })
    // 성공: SUT의 실제 청구액(gold-goldAfter)으로 cost를 관측한다. 실패: refund로 0이 되므로 nominal.
    const cost = result.broken ? repairCost(input.value) : char.gold - result.goldAfter
    return {
      broken: result.broken,
      cost,
      newShotscur: result.item ? result.item.shotscur : null,
    }
  } catch (err) {
    if (err instanceof ShopRejectError) return { broken: true, cost: repairCost(input.value), newShotscur: null }
    throw err
  }
}

describe('런타임 repair SUT 골든 교차검증', () => {
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/repair.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('repair.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 repair SUT로 전 케이스를 throw 없이 통과한다(파괴·복원·bonusOf·trunc·cost)', () => {
    const fixture = loadFixture()
    const sut = (input: unknown) => dispatchRepair(input as RepairCaseInput)
    expect(() => approve(fixture, sut)).not.toThrow()
  })

  it('버그 주입 변형(newShotscur+1)에는 approve가 throw한다 (negative control)', () => {
    const fixture = loadFixture()
    const buggy = (input: unknown) => {
      const out = dispatchRepair(input as RepairCaseInput)
      return {
        broken: out.broken,
        cost: out.cost,
        newShotscur: out.newShotscur === null ? null : out.newShotscur + 1,
      }
    }
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

/**
 * 입력 가드 단위 테스트 — object.value·gold·piety·shots 등 경제 입력이 음의 정수·소수·NaN이면
 * 가격/잔액 산술이 gold 생성·손실 벡터가 되므로(예: 음의 value → 음의 price → gold 증가),
 * 각 함수 진입점에서 assertNonNegativeInt로 거부한다(moneyService/bankTransactionService와 동형의 self-defense).
 */
describe('shopService 입력 가드(음의 정수·소수·NaN 거부)', () => {
  const expectInvalidInput = (fn: () => unknown): void => {
    expect(fn).toThrow(ShopRejectError)
    try {
      fn()
    } catch (err) {
      expect((err as ShopRejectError).reason).toBe('invalid-input')
    }
  }

  it('buy: 음의 value를 invalid-input으로 거부한다', () => {
    expectInvalidInput(() => buy({ gold: 500, invCount: 0 }, { objnum: 1, type: 3, value: -100, shotscur: 0 }))
  })

  it('buy: 음의 gold를 invalid-input으로 거부한다', () => {
    expectInvalidInput(() => buy({ gold: -1, invCount: 0 }, { objnum: 1, type: 3, value: 100, shotscur: 0 }))
  })

  it('buy: 소수 invCount를 invalid-input으로 거부한다(비정수 arm)', () => {
    expectInvalidInput(() => buy({ gold: 500, invCount: 1.5 }, { objnum: 1, type: 3, value: 100, shotscur: 0 }))
  })

  it('purchase: 음의 value를 invalid-input으로 거부한다', () => {
    expectInvalidInput(() => purchase({ gold: 500, invCount: 0 }, { objnum: 1, type: 3, value: -100, shotscur: 0 }))
  })

  it('purchase: NaN gold를 invalid-input으로 거부한다(비정수 arm)', () => {
    expectInvalidInput(() => purchase({ gold: Number.NaN, invCount: 0 }, { objnum: 1, type: 3, value: 100, shotscur: 0 }))
  })

  it('sell: 음의 value를 invalid-input으로 거부한다(rng 미소비)', () => {
    const item: PawnItem = { value: -100, type: 13, shotscur: 0, shotsmax: 0, onewev: false, hasContents: false }
    expectInvalidInput(() => sell({ gold: 0 }, item, { rng: seqRng([]) }))
  })

  it('sell: 음의 shotscur를 invalid-input으로 거부한다', () => {
    const item: PawnItem = { value: 100, type: 13, shotscur: -1, shotsmax: 0, onewev: false, hasContents: false }
    expectInvalidInput(() => sell({ gold: 0 }, item, { rng: seqRng([]) }))
  })

  it('repair: 음의 value로 gold가 증가하지 않고 invalid-input으로 거부한다(gold 생성 벡터 차단)', () => {
    // repairCost(-40)=trunc(-40/4)=-10이면 gold<cost가 false라 진행하고, 성공 시 gold-cost=110으로
    // gold가 오히려 증가한다(gold 생성). 가드가 이를 진입점에서 차단해야 한다.
    const item: RepairItem = { value: -40, shotscur: 1, shotsmax: 80 }
    expectInvalidInput(() => repair({ gold: 100, piety: 10 }, item, { rng: seqRng([]) }))
  })

  it('repair: 음의 piety를 invalid-input으로 거부한다', () => {
    const item: RepairItem = { value: 100, shotscur: 1, shotsmax: 80 }
    expectInvalidInput(() => repair({ gold: 500, piety: -1 }, item, { rng: seqRng([]) }))
  })
})

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
