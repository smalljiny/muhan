import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { weightOf, canCarry, type WeightNode, type CarrierState } from './carry.js'
import { approve } from '../oracle/runner.js'
import { goldenFixtureSchema, type GoldenFixture } from '../oracle/types.js'
import type { EffectiveStatContext } from '../stats/context.js'

// WeightNode 생성 헬퍼 — 테스트 가독성용. weightless·contents 기본값을 채운다.
function n(weight: number, weightless = false, contents: WeightNode[] = []): WeightNode {
  return { weight, weightless, contents }
}

// canCarry용 컨텍스트 — maxWeight가 판독하는 필드만 지정하고 나머지는 더미로 채운다.
// fighter(class 4) L1 str10 → maxWeight = 20 + 10*10 = 120 (barbarian 항 없음).
function ctx(overrides: {
  effectiveStrength: number
  characterClass: number
  level: number
}): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  }
}

function carrier(overrides: {
  weightCarried: number
  invCount: number
  context: EffectiveStatContext
}): CarrierState {
  return overrides
}

describe('weightOf — 재귀 무게 합 (OWTLES 자식 제외)', () => {
  it('flat 노드는 자기 무게만 반환한다 (10)', () => {
    expect(weightOf(n(10))).toBe(10)
  })

  it('중첩 non-weightless는 전 서브트리를 합산한다 (10+5+3 = 18)', () => {
    expect(weightOf(n(10, false, [n(5, false, [n(3)])]))).toBe(18)
  })

  it('OWTLES 자식은 자기 무게+내용물 전체가 제외된다 (10, 15/115 아님)', () => {
    // discriminator: OWTLES 자식(5)과 그 내용물(100)이 모두 빠진다.
    expect(weightOf(n(10, false, [n(5, true, [n(100)])]))).toBe(10)
  })

  it('형제 혼합: weightless 형제만 건너뛴다 (10+5+3 = 18, 7 제외)', () => {
    expect(weightOf(n(10, false, [n(5, false), n(7, true), n(3, false)]))).toBe(18)
  })

  it('최상위 노드는 weightless여도 자기 무게가 항상 계산된다 (8)', () => {
    // OWTLES 플래그는 부모만 판독한다 — 최상위 노드 자신의 무게는 항상 합산.
    expect(weightOf(n(8, true, []))).toBe(8)
  })
})

describe('canCarry — 무게 경계 (strict >, 같으면 적재 가능)', () => {
  // fighter L1 str10 → maxWeight = 120. 검증: derived.ts maxWeight (20 + str*10).
  const fighterCtx = ctx({ effectiveStrength: 10, characterClass: 4, level: 1 })

  it('정확히 상한이면 적재 가능 (100 + 20 = 120, 120 > 120 거짓 → true)', () => {
    const char = carrier({ weightCarried: 100, invCount: 0, context: fighterCtx })
    expect(canCarry(char, n(20), 'get')).toBe(true)
  })

  it('상한 1 초과면 적재 불가 (100 + 21 = 121 > 120 → false)', () => {
    const char = carrier({ weightCarried: 100, invCount: 0, context: fighterCtx })
    expect(canCarry(char, n(21), 'get')).toBe(false)
  })

  it('OWTLES 내용물이 무게를 낮춰 적재 가능해진다 (raw 60이면 초과, weightOf 10 → 적합)', () => {
    // 남은 용량 20. 노드 raw 합은 10+50=60(초과)이나 OWTLES로 weightOf=10 → 110 ≤ 120.
    const char = carrier({ weightCarried: 100, invCount: 0, context: fighterCtx })
    expect(canCarry(char, n(10, false, [n(50, true)]), 'get')).toBe(true)
  })
})

describe('canCarry — 개수 경계 (mode별 상한, strict >)', () => {
  const anyCtx = ctx({ effectiveStrength: 10, characterClass: 4, level: 1 })
  const light = n(0)

  it('buy 상한 정확히 200이면 적재 가능', () => {
    const char = carrier({ weightCarried: 0, invCount: 200, context: anyCtx })
    expect(canCarry(char, light, 'buy')).toBe(true)
  })

  it('buy 201이면 적재 불가', () => {
    const char = carrier({ weightCarried: 0, invCount: 201, context: anyCtx })
    expect(canCarry(char, light, 'buy')).toBe(false)
  })

  it('get 상한 정확히 150이면 적재 가능', () => {
    const char = carrier({ weightCarried: 0, invCount: 150, context: anyCtx })
    expect(canCarry(char, light, 'get')).toBe(true)
  })

  it('get 151이면 적재 불가', () => {
    const char = carrier({ weightCarried: 0, invCount: 151, context: anyCtx })
    expect(canCarry(char, light, 'get')).toBe(false)
  })

  it('give·purchase도 150 상한을 쓴다 (150 통과, 151 불가)', () => {
    const okGive = carrier({ weightCarried: 0, invCount: 150, context: anyCtx })
    const okPurchase = carrier({ weightCarried: 0, invCount: 150, context: anyCtx })
    const overGive = carrier({ weightCarried: 0, invCount: 151, context: anyCtx })
    const overPurchase = carrier({ weightCarried: 0, invCount: 151, context: anyCtx })
    expect(canCarry(okGive, light, 'give')).toBe(true)
    expect(canCarry(okPurchase, light, 'purchase')).toBe(true)
    expect(canCarry(overGive, light, 'give')).toBe(false)
    expect(canCarry(overPurchase, light, 'purchase')).toBe(false)
  })
})

// 체크인된 골든 fixture를 런타임 weightOf SUT로 교차검증한다. negative control(버그 주입)이
// 없으면 approval이 vacuous하므로 함께 둔다(priceConfig/maxWeight 선례).
function loadCarryFixture(): GoldenFixture<WeightNode, number> {
  const url = new URL('../oracle/fixtures/carry.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<WeightNode, number>
}

describe('런타임 weightOf SUT 골든 교차검증', () => {
  it('approve(carry fixture, weightOf)가 전 케이스를 throw 없이 통과한다', () => {
    expect(() => approve(loadCarryFixture(), weightOf)).not.toThrow()
  })

  it('버그 주입 변형(OWTLES 무시)에는 approve가 throw한다 (negative control)', () => {
    // 버그: weightless 자식도 합산 → OWTLES discriminator 케이스에서 발산.
    const buggy = (node: WeightNode): number =>
      node.weight + node.contents.reduce((s, c) => s + buggy(c), 0)
    expect(() => approve(loadCarryFixture(), buggy)).toThrow()
  })
})
