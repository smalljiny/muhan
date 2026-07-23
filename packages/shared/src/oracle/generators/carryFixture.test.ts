import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceWeightOf,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './carryFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (carry / weightOf)', () => {
  // 최중요(Layer B): 기대값은 referenceWeightOf를 호출하지 않고 손 계산 하드 리터럴로 박는다.
  // 3번째(index 2) 케이스 10은 OWTLES 자식(자기 무게+내용물 전체)이 빠지는 discriminator다.
  const HAND_COMPUTED_EXPECTED = [10, 18, 10, 18, 8]

  it('5개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(5)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('OWTLES discriminator: 자식(5)+내용물(100) 전체 제외 → 10 (15·115 아님)', () => {
    const cases = buildCases()
    expect(cases[2]?.expected).toBe(10)
  })

  it('최상위 weightless도 자기 무게는 계산 → 8', () => {
    const cases = buildCases()
    expect(cases[4]?.expected).toBe(8)
  })
})

describe('referenceWeightOf — SUT와 독립 표현 (reduce 재귀)', () => {
  const n = (
    weight: number,
    weightless = false,
    contents: Parameters<typeof referenceWeightOf>[0]['contents'] = [],
  ) => ({ weight, weightless, contents })

  it('flat 노드는 자기 무게만 반환한다 (10)', () => {
    expect(referenceWeightOf(n(10))).toBe(10)
  })

  it('OWTLES 자식은 서브트리 전체가 제외된다 (10)', () => {
    expect(referenceWeightOf(n(10, false, [n(5, true, [n(100)])]))).toBe(10)
  })

  it('최상위 weightless여도 자기 무게가 계산된다 (8)', () => {
    expect(referenceWeightOf(n(8, true, []))).toBe(8)
  })
})

describe('buildFixture (carry)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 carry다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('carry')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (carry)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `carry.test.${process.pid}.json`)
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

describe('체크인된 carry.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/carry.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('carry')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손 계산 상수와 일치.
  // OWTLES discriminator(index 2 = 10)를 포함한다.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/carry.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([10, 18, 10, 18, 8])
    }
  })
})
