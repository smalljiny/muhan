import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../oracle/types.js'
import type { GoldenFixture } from '../oracle/types.js'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import { approve } from '../oracle/runner.js'
import { computeAc, computeThaco, maxWeight, computeHpMax, computeMpMax } from './derived.js'
import type { EffectiveStatContext } from './context.js'

// 체크인된 compute_ac 골든 fixture를 로드해 goldenFixtureSchema로 파싱한 뒤
// GoldenFixture<ComputeAcInput, number>로 취급한다(하네스 인프라 타입 캐스트).
function loadFixture(): GoldenFixture<ComputeAcInput, number> {
  const url = new URL('../oracle/fixtures/compute_ac.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<ComputeAcInput, number>
}

/**
 * fixture의 `ComputeAcInput`을 런타임 wrapper 입력 `EffectiveStatContext`로 역-어댑트한다.
 * computeAc가 판독하는 3개 필드(effectiveDexterity·equipArmor·protection)만 의미가 있고,
 * 나머지 5개(Story 4·5 소비)는 더미값으로 채운다 — computeAc는 이들을 읽지 않는다.
 */
function adaptToContext(input: ComputeAcInput): EffectiveStatContext {
  return {
    effectiveDexterity: input.dexterity,
    effectiveStrength: 0,
    equipArmor: input.equipArmor,
    protection: input.protection,
    characterClass: 1,
    level: 1,
    weaponAdjustment: 0,
    weaponProficiency: 0,
  }
}

describe('런타임 computeAc wrapper 골든 교차검증', () => {
  // T3.3 — 체크인 fixture 전 케이스가 런타임 wrapper(EffectiveStatContext 경유)를 통과한다.
  // oracle computeAc 직접 경로는 oracle/computeAc.test.ts가 이미 검증하므로, 여기선
  // wrapper 경로만 독립적으로 확립한다.
  it('approve(compute_ac fixture, wrapper)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    expect(() => approve(fixture, (input) => computeAc(adaptToContext(input)))).not.toThrow()
  })

  // T3.3 negative control(최중요) — wrapper 출력에 +1 버그를 주입한 변형은 반드시 감지된다.
  // 러너가 실제 차이를 잡아냄을 보증한다(교차검증 통과가 tautology가 아님).
  it('wrapper에 +1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadFixture()
    const buggyWrapper = (input: ComputeAcInput): number => computeAc(adaptToContext(input)) + 1
    expect(() => approve(fixture, buggyWrapper)).toThrow()
  })
})

describe('런타임 computeAc wrapper 스팟 체크', () => {
  it('baseline: effectiveDexterity 10, armor 0, 보호 없음 → 100', () => {
    expect(computeAc(adaptToContext({ dexterity: 10, equipArmor: 0, protection: false }))).toBe(100)
  })

  it('clamp 하한: effectiveDexterity 63, armor 300, 보호 → -127', () => {
    expect(computeAc(adaptToContext({ dexterity: 63, equipArmor: 300, protection: true }))).toBe(
      -127,
    )
  })

  it('보호마법·장비 armor 반영: effectiveDexterity 20, armor 20, 보호 → 55', () => {
    expect(computeAc(adaptToContext({ dexterity: 20, equipArmor: 20, protection: true }))).toBe(55)
  })
})

// compute_thaco·max_weight fixture는 input이 전체 EffectiveStatContext이므로 어댑터 없이
// 런타임 SUT(computeThaco·maxWeight)를 approve에 직접 넘긴다.
function loadContextFixture(name: string): GoldenFixture<EffectiveStatContext, number> {
  const url = new URL(`../oracle/fixtures/${name}`, import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<EffectiveStatContext, number>
}

describe('런타임 computeThaco SUT 골든 교차검증', () => {
  // T4.3(a) — 체크인 fixture 전 케이스가 런타임 SUT를 통과한다. SUT는 derived.ts의 직접 산술.
  it('approve(compute_thaco fixture, computeThaco)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadContextFixture('compute_thaco.json')
    expect(() => approve(fixture, computeThaco)).not.toThrow()
  })

  // T4.3(b) negative control(최중요) — +1 버그를 주입한 변형은 반드시 감지된다.
  it('+1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadContextFixture('compute_thaco.json')
    const buggy = (input: EffectiveStatContext): number => computeThaco(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('런타임 computeThaco SUT 스팟 체크 (A7 앵커·clamp 3분기)', () => {
  const ctx = (overrides: {
    effectiveStrength: number
    characterClass: number
    level: number
    weaponAdjustment: number
    weaponProficiency: number
  }): EffectiveStatContext => ({
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    ...overrides,
  })

  it('A7 앵커: fighter L1=20, fighter L77=3, mage L1=20, assassin L1=18', () => {
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 4, level: 1, weaponAdjustment: 0, weaponProficiency: 0 })),
    ).toBe(20)
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 4, level: 77, weaponAdjustment: 0, weaponProficiency: 0 })),
    ).toBe(3)
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 5, level: 1, weaponAdjustment: 0, weaponProficiency: 0 })),
    ).toBe(20)
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 1, level: 1, weaponAdjustment: 0, weaponProficiency: 0 })),
    ).toBe(18)
  })

  it('clamp 3분기: class<10 L<101→0, class<10 L>=101→-5, class>=10→-10', () => {
    // barbarian L77 prof100: 2 - 5 = -3 → Math.max(0, -3) = 0
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 2, level: 77, weaponAdjustment: 0, weaponProficiency: 100 })),
    ).toBe(0)
    // fighter L101 adj10 prof100: 3 - 10 - 5 = -12 → Math.max(-5, -12) = -5
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 4, level: 101, weaponAdjustment: 10, weaponProficiency: 100 })),
    ).toBe(-5)
    // caretaker L1 adj20: -5 - 20 = -25 → Math.max(-10, -25) = -10
    expect(
      computeThaco(ctx({ effectiveStrength: 10, characterClass: 10, level: 1, weaponAdjustment: 20, weaponProficiency: 0 })),
    ).toBe(-10)
  })
})

describe('런타임 maxWeight SUT 골든 교차검증', () => {
  // T4.3(a) — 체크인 fixture 전 케이스가 런타임 SUT를 통과한다.
  it('approve(max_weight fixture, maxWeight)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadContextFixture('max_weight.json')
    expect(() => approve(fixture, maxWeight)).not.toThrow()
  })

  // T4.3(b) negative control(최중요) — +1 버그를 주입한 변형은 반드시 감지된다.
  it('+1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadContextFixture('max_weight.json')
    const buggy = (input: EffectiveStatContext): number => maxWeight(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('런타임 maxWeight SUT 스팟 체크 (clamp 함정)', () => {
  const ctx = (overrides: {
    effectiveStrength: number
    characterClass: number
    level: number
  }): EffectiveStatContext => ({
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  it('barbarian(2) L81 str10 → 330 (unclamped, 320 아님)', () => {
    expect(maxWeight(ctx({ effectiveStrength: 10, characterClass: 2, level: 81 }))).toBe(330)
  })

  it('non-barbarian은 20 + str*10만 반환한다 (fighter L81 str10 → 120)', () => {
    expect(maxWeight(ctx({ effectiveStrength: 10, characterClass: 4, level: 81 }))).toBe(120)
  })

  it('barbarian(2) L400 str10 → 1120 (unclamped 발산)', () => {
    expect(maxWeight(ctx({ effectiveStrength: 10, characterClass: 2, level: 400 }))).toBe(1120)
  })

  it('str0 하한 (fighter L1 str0 → 20)', () => {
    expect(maxWeight(ctx({ effectiveStrength: 0, characterClass: 4, level: 1 }))).toBe(20)
  })
})

describe('런타임 computeHpMax SUT 골든 교차검증', () => {
  // T5.2(a) — 체크인 fixture 전 케이스가 런타임 SUT를 통과한다. SUT는 derived.ts의 직접 산술.
  it('approve(compute_hpmax fixture, computeHpMax)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadContextFixture('compute_hpmax.json')
    expect(() => approve(fixture, computeHpMax)).not.toThrow()
  })

  // T5.2(b) negative control(최중요) — +1 버그를 주입한 변형은 반드시 감지된다.
  it('+1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadContextFixture('compute_hpmax.json')
    const buggy = (input: EffectiveStatContext): number => computeHpMax(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('런타임 computeHpMax SUT 스팟 체크 (A7 §2 앵커·정수 나눗셈 그룹핑)', () => {
  const ctx = (overrides: {
    characterClass: number
    level: number
  }): EffectiveStatContext => ({
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  // truncation은 곱 결과에 적용된다: 56 + trunc(6*9/2) = 83 (잘못된 6*trunc(9/2)=24 → 80 아님).
  it('검사(fighter) L10=83, L50=203, L100=353', () => {
    expect(computeHpMax(ctx({ characterClass: 4, level: 10 }))).toBe(83)
    expect(computeHpMax(ctx({ characterClass: 4, level: 50 }))).toBe(203)
    expect(computeHpMax(ctx({ characterClass: 4, level: 100 }))).toBe(353)
  })

  it('도술사(mage) L50=152, 권법가(barbarian) L50=228', () => {
    expect(computeHpMax(ctx({ characterClass: 5, level: 50 }))).toBe(152)
    // 잘못된 그룹핑이면 57 + 7*trunc(49/2) = 225 (올바르면 228).
    expect(computeHpMax(ctx({ characterClass: 2, level: 50 }))).toBe(228)
  })

  it('L1은 성장항 0이라 hpstart 그대로다 (fighter L1 → 56)', () => {
    expect(computeHpMax(ctx({ characterClass: 4, level: 1 }))).toBe(56)
  })
})

describe('런타임 computeMpMax SUT 골든 교차검증', () => {
  // T5.2(a) — 체크인 fixture 전 케이스가 런타임 SUT를 통과한다.
  it('approve(compute_mpmax fixture, computeMpMax)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadContextFixture('compute_mpmax.json')
    expect(() => approve(fixture, computeMpMax)).not.toThrow()
  })

  // T5.2(b) negative control(최중요) — +1 버그를 주입한 변형은 반드시 감지된다.
  it('+1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadContextFixture('compute_mpmax.json')
    const buggy = (input: EffectiveStatContext): number => computeMpMax(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('런타임 computeMpMax SUT 스팟 체크 (A7 §2 앵커·정수 나눗셈 그룹핑)', () => {
  const ctx = (overrides: {
    characterClass: number
    level: number
  }): EffectiveStatContext => ({
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  it('검사(fighter) L10=54, L50=74, L100=99', () => {
    expect(computeMpMax(ctx({ characterClass: 4, level: 10 }))).toBe(54)
    expect(computeMpMax(ctx({ characterClass: 4, level: 50 }))).toBe(74)
    expect(computeMpMax(ctx({ characterClass: 4, level: 100 }))).toBe(99)
  })

  it('도술사(mage) L50=123, 권법가(barbarian) L50=64', () => {
    // 50 + trunc(3*49/2) = 50 + 73 = 123.
    expect(computeMpMax(ctx({ characterClass: 5, level: 50 }))).toBe(123)
    expect(computeMpMax(ctx({ characterClass: 2, level: 50 }))).toBe(64)
  })

  it('L1은 성장항 0이라 mpstart 그대로다 (mage L1 → 50)', () => {
    expect(computeMpMax(ctx({ characterClass: 5, level: 1 }))).toBe(50)
  })
})
