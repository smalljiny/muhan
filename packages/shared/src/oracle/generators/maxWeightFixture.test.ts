import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceMaxWeight,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './maxWeightFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (max_weight)', () => {
  // 최중요(Layer B): 기대값은 referenceMaxWeight를 호출하지 않고 손 계산 하드 리터럴로 박는다.
  // barbarian(2) L81 str10 → 330은 unclamped (level+3)/4 함정을 검출하는 핵심 앵커다.
  // clamp 함정에 빠지면 320이 나온다.
  const HAND_COMPUTED_EXPECTED = [330, 120, 130, 250, 20, 1120]

  it('6개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(6)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('clamp 함정 앵커: barbarian L81 str10 → 330 (320 아님)', () => {
    const cases = buildCases()
    expect(cases[0]?.expected).toBe(330)
  })

  it('non-barbarian은 고레벨에서도 barbarian 항이 없다 (fighter L81 str10 → 120)', () => {
    const cases = buildCases()
    expect(cases[1]?.expected).toBe(120)
  })

  it('unclamped 발산: barbarian L400 str10 → 1120', () => {
    const cases = buildCases()
    expect(cases[5]?.expected).toBe(1120)
  })
})

describe('referenceMaxWeight — SUT와 독립 표현', () => {
  const ctx = (overrides: { effectiveStrength: number; characterClass: number; level: number }) => ({
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  it('barbarian(2) L81 str10 → 330 (unclamped)', () => {
    expect(referenceMaxWeight(ctx({ effectiveStrength: 10, characterClass: 2, level: 81 }))).toBe(330)
  })

  it('non-barbarian은 20 + str*10만 반환한다 (fighter L81 str10 → 120)', () => {
    expect(referenceMaxWeight(ctx({ effectiveStrength: 10, characterClass: 4, level: 81 }))).toBe(120)
  })

  it('str0 하한 (fighter L1 str0 → 20)', () => {
    expect(referenceMaxWeight(ctx({ effectiveStrength: 0, characterClass: 4, level: 1 }))).toBe(20)
  })
})

describe('buildFixture (max_weight)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 max_weight다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('max_weight')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (max_weight)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `max_weight.test.${process.pid}.json`)
    try {
      writeFixtureFile(path, buildFixture(FIXED_CLOCK))
      const raw = readFileSync(path, 'utf8')
      expect(raw).toContain('\n  ')
      const parsed: unknown = JSON.parse(raw)
      expect(goldenFixtureSchema.safeParse(parsed).success).toBe(true)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('체크인된 max_weight.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/max_weight.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('max_weight')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손 계산 상수와 일치.
  // L81=330 clamp 함정 앵커를 포함한다.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/max_weight.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([330, 120, 130, 250, 20, 1120])
    }
  })
})
