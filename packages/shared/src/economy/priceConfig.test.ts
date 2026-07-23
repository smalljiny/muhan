import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { PRICE_CONFIG, buyPrice, mobBuyPrice, sellPrice, repairCost } from './priceConfig.js'
import { approve } from '../oracle/runner.js'
import { goldenFixtureSchema, type GoldenFixture } from '../oracle/types.js'
import type { PriceInput } from '../oracle/generators/priceFixture.js'

describe('PRICE_CONFIG — 선언적 배수 상수 테이블', () => {
  it('몹 하한·판매 상한·판매/수리 제수를 A8 §8 정본값으로 노출한다', () => {
    expect(PRICE_CONFIG.mobFloor).toBe(10)
    expect(PRICE_CONFIG.sellCap).toBe(100000)
    expect(PRICE_CONFIG.sellDivisor).toBe(2)
    expect(PRICE_CONFIG.repairDivisor).toBe(4)
  })
})

describe('buyPrice — 정가 (value 그대로)', () => {
  it('중간값: value=100 → 100', () => {
    expect(buyPrice(100)).toBe(100)
  })

  it('value<40: value=39 → 39', () => {
    expect(buyPrice(39)).toBe(39)
  })

  it('0 → 0', () => {
    expect(buyPrice(0)).toBe(0)
  })
})

describe('mobBuyPrice — max(10, value)', () => {
  it('중간값: value=100 → 100 (하한 위)', () => {
    expect(mobBuyPrice(100)).toBe(100)
  })

  it('하한 경계 위: value=39 → 39', () => {
    expect(mobBuyPrice(39)).toBe(39)
  })

  it('하한 아래: value=5 → 10 (floor 적용)', () => {
    expect(mobBuyPrice(5)).toBe(10)
  })

  it('0 → 10 (floor 적용)', () => {
    expect(mobBuyPrice(0)).toBe(10)
  })

  it('정확히 하한: value=10 → 10', () => {
    expect(mobBuyPrice(10)).toBe(10)
  })
})

describe('sellPrice — min(trunc(value/2), 100000)', () => {
  it('중간값: value=100 → 50', () => {
    expect(sellPrice(100)).toBe(50)
  })

  it('홀수 truncation: value=39 → 19 (trunc(19.5))', () => {
    expect(sellPrice(39)).toBe(19)
  })

  it('상한 경계 정확히: value=200000 → 100000', () => {
    expect(sellPrice(200000)).toBe(100000)
  })

  it('상한 초과 clamp: value=250000 → 100000', () => {
    expect(sellPrice(250000)).toBe(100000)
  })

  it('0 → 0', () => {
    expect(sellPrice(0)).toBe(0)
  })
})

describe('repairCost — trunc(value/4)', () => {
  it('중간값: value=100 → 25', () => {
    expect(repairCost(100)).toBe(25)
  })

  it('truncation: value=39 → 9 (trunc(9.75))', () => {
    expect(repairCost(39)).toBe(9)
  })

  it('0 → 0', () => {
    expect(repairCost(0)).toBe(0)
  })
})

// T2.4 — 체크인된 골든 fixture를 런타임 SUT로 교차검증한다. `input.fn`으로 4개 함수 중
// 하나에 디스패치해 approve에 넘긴다. negative control(버그 주입)이 없으면 approval이
// vacuous하므로 함께 둔다(maxWeight/computeAc 선례, derived.test.ts).
function dispatchPrice(input: PriceInput): number {
  switch (input.fn) {
    case 'buy':
      return buyPrice(input.value)
    case 'mobBuy':
      return mobBuyPrice(input.value)
    case 'sell':
      return sellPrice(input.value)
    case 'repair':
      return repairCost(input.value)
  }
}

function loadPriceFixture(): GoldenFixture<PriceInput, number> {
  const url = new URL('../oracle/fixtures/price.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<PriceInput, number>
}

describe('런타임 price SUT 골든 교차검증 (T2.4)', () => {
  it('approve(price fixture, dispatchPrice)가 전 케이스를 throw 없이 통과한다', () => {
    expect(() => approve(loadPriceFixture(), dispatchPrice)).not.toThrow()
  })

  it('버그 주입 변형(+1)에는 approve가 throw한다 (negative control)', () => {
    const buggy = (input: PriceInput): number => dispatchPrice(input) + 1
    expect(() => approve(loadPriceFixture(), buggy)).toThrow()
  })
})
