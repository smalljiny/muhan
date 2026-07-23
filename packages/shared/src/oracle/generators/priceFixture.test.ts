import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { referencePrice, buildCases, buildFixture, writeFixtureFile } from './priceFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (price)', () => {
  // 최중요(Layer B): 기대값은 referencePrice를 호출하지 않고 손 계산 하드 리터럴로 박는다.
  // 케이스 순서와 손 계산:
  //  0 buy    value=39     → 39
  //  1 mobBuy value=39     → max(10,39)=39
  //  2 sell   value=39     → min(trunc(19.5),100000)=19
  //  3 repair value=39     → trunc(9.75)=9
  //  4 buy    value=100    → 100
  //  5 mobBuy value=100    → 100
  //  6 sell   value=100    → 50
  //  7 repair value=100    → 25
  //  8 mobBuy value=5      → max(10,5)=10  (floor 함정)
  //  9 mobBuy value=0      → max(10,0)=10  (floor 함정, 0)
  // 10 sell   value=200000 → min(100000,100000)=100000 (상한 정확히)
  // 11 sell   value=250000 → min(125000,100000)=100000 (상한 초과 clamp)
  const HAND_COMPUTED_EXPECTED = [39, 39, 19, 9, 100, 100, 50, 25, 10, 10, 100000, 100000]

  it('12개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(12)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('sell truncation 앵커: value=39 → 19 (trunc(19.5), 20 아님)', () => {
    expect(buildCases()[2]?.expected).toBe(19)
  })

  it('repair truncation 앵커: value=39 → 9 (trunc(9.75), 10 아님)', () => {
    expect(buildCases()[3]?.expected).toBe(9)
  })

  it('mobBuy floor 앵커: value=5 → 10, value=0 → 10', () => {
    const cases = buildCases()
    expect(cases[8]?.expected).toBe(10)
    expect(cases[9]?.expected).toBe(10)
  })

  it('sell cap 앵커: value=200000 → 100000 (경계), value=250000 → 100000 (초과)', () => {
    const cases = buildCases()
    expect(cases[10]?.expected).toBe(100000)
    expect(cases[11]?.expected).toBe(100000)
  })
})

describe('referencePrice — SUT와 독립 표현 (인라인 리터럴, PRICE_CONFIG 미참조)', () => {
  it('buy: value=39 → 39', () => {
    expect(referencePrice({ fn: 'buy', value: 39 })).toBe(39)
  })

  it('mobBuy floor: value=5 → 10', () => {
    expect(referencePrice({ fn: 'mobBuy', value: 5 })).toBe(10)
  })

  it('sell truncation: value=39 → 19', () => {
    expect(referencePrice({ fn: 'sell', value: 39 })).toBe(19)
  })

  it('sell cap: value=250000 → 100000', () => {
    expect(referencePrice({ fn: 'sell', value: 250000 })).toBe(100000)
  })

  it('repair: value=100 → 25', () => {
    expect(referencePrice({ fn: 'repair', value: 100 })).toBe(25)
  })
})

describe('buildFixture (price)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 price다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('price')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (price)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `price.test.${process.pid}.json`)
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

describe('체크인된 price.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 price다', () => {
    const url = new URL('../fixtures/price.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('price')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손 계산 상수와 일치.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/price.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([
        39, 39, 19, 9, 100, 100, 50, 25, 10, 10, 100000, 100000,
      ])
    }
  })
})
