import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceComputeHpMax,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './computeHpMaxFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (compute_hpmax)', () => {
  // 최중요(Layer B): 기대값은 referenceComputeHpMax를 호출하지 않고 A7 §2 손 계산 하드
  // 리터럴로 박는다. 참조와 SUT가 같은 잘못된 그룹핑을 공유하면 self-agree로 통과하므로,
  // 여기 리터럴만이 정수 나눗셈 그룹핑 오류(83 vs 80, 228 vs 225)를 독립적으로 검출한다.
  const HAND_COMPUTED_EXPECTED = [83, 203, 353, 152, 228, 56]

  it('6개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(6)
  })

  it('각 케이스의 expected가 A7 §2 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('그룹핑 함정 앵커: 검사 L10 → 83 (잘못된 그룹핑 80 아님)', () => {
    expect(buildCases()[0]?.expected).toBe(83)
  })

  it('그룹핑 함정 앵커: 권법가 L50 → 228 (잘못된 그룹핑 225 아님)', () => {
    expect(buildCases()[4]?.expected).toBe(228)
  })

  it('A7 §2 앵커: 검사 L50=203, L100=353, 도술사 L50=152, 검사 L1=56', () => {
    const cases = buildCases()
    expect(cases[1]?.expected).toBe(203)
    expect(cases[2]?.expected).toBe(353)
    expect(cases[3]?.expected).toBe(152)
    expect(cases[5]?.expected).toBe(56)
  })
})

describe('referenceComputeHpMax — SUT와 독립 표현', () => {
  const ctx = (overrides: { characterClass: number; level: number }) => ({
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    weaponAdjustment: 0,
    weaponProficiency: 0,
    ...overrides,
  })

  it('truncation이 곱 결과에 적용된다 (검사 L10 → 83)', () => {
    expect(referenceComputeHpMax(ctx({ characterClass: 4, level: 10 }))).toBe(83)
  })

  it('권법가 L50 → 228 (잘못된 그룹핑 225 아님)', () => {
    expect(referenceComputeHpMax(ctx({ characterClass: 2, level: 50 }))).toBe(228)
  })

  it('L1은 성장항 0이라 hpstart 그대로다 (검사 L1 → 56)', () => {
    expect(referenceComputeHpMax(ctx({ characterClass: 4, level: 1 }))).toBe(56)
  })
})

describe('buildFixture (compute_hpmax)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 compute_hpmax다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('compute_hpmax')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (compute_hpmax)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `compute_hpmax.test.${process.pid}.json`)
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

describe('체크인된 compute_hpmax.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/compute_hpmax.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('compute_hpmax')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 A7 §2 손 계산 상수와 일치.
  // 정수 나눗셈 그룹핑 앵커(L10=83, 권법가 L50=228)를 포함한다.
  it('체크인 JSON의 expected가 A7 §2 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/compute_hpmax.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([83, 203, 353, 152, 228, 56])
    }
  })
})
