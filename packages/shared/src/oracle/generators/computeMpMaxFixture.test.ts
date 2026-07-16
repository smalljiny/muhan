import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceComputeMpMax,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './computeMpMaxFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (compute_mpmax)', () => {
  // 최중요(Layer B): 기대값은 referenceComputeMpMax를 호출하지 않고 A7 §2 손 계산 하드
  // 리터럴로 박는다. 도술사 L50 → 123(= 50 + trunc(3*49/2) = 50+73)이 정수 나눗셈 그룹핑을
  // 독립 검증하는 앵커다.
  const HAND_COMPUTED_EXPECTED = [54, 74, 99, 123, 64, 50]

  it('6개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(6)
  })

  it('각 케이스의 expected가 A7 §2 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('그룹핑 앵커: 도술사 L50 → 123 (50 + trunc(3*49/2))', () => {
    expect(buildCases()[3]?.expected).toBe(123)
  })

  it('A7 §2 앵커: 검사 L10=54, L50=74, L100=99, 권법가 L50=64, 도술사 L1=50', () => {
    const cases = buildCases()
    expect(cases[0]?.expected).toBe(54)
    expect(cases[1]?.expected).toBe(74)
    expect(cases[2]?.expected).toBe(99)
    expect(cases[4]?.expected).toBe(64)
    expect(cases[5]?.expected).toBe(50)
  })
})

describe('referenceComputeMpMax — SUT와 독립 표현', () => {
  const ctx = (overrides: { characterClass: number; level: number }) => ({
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  it('도술사 L50 → 123 (truncation이 곱 결과에 적용)', () => {
    expect(referenceComputeMpMax(ctx({ characterClass: 5, level: 50 }))).toBe(123)
  })

  it('검사 L100 → 99', () => {
    expect(referenceComputeMpMax(ctx({ characterClass: 4, level: 100 }))).toBe(99)
  })

  it('L1은 성장항 0이라 mpstart 그대로다 (도술사 L1 → 50)', () => {
    expect(referenceComputeMpMax(ctx({ characterClass: 5, level: 1 }))).toBe(50)
  })
})

describe('buildFixture (compute_mpmax)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 compute_mpmax다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('compute_mpmax')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (compute_mpmax)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `compute_mpmax.test.${process.pid}.json`)
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

describe('체크인된 compute_mpmax.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/compute_mpmax.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('compute_mpmax')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 A7 §2 손 계산 상수와 일치.
  it('체크인 JSON의 expected가 A7 §2 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/compute_mpmax.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([54, 74, 99, 123, 64, 50])
    }
  })
})
