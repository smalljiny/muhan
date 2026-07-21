import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceNeededExp,
  referenceExpToLevel,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './neededExpFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-21T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (needed_exp)', () => {
  // 최중요(Layer B): 기대값은 참조 구현을 호출하지 않고 확정 정본 하드 리터럴로 박는다.
  // 참조와 SUT가 같은 오류를 공유해도 여기 리터럴만이 그것을 독립 검출한다.
  const HAND_COMPUTED_EXPECTED = [
    128, 256, 100000, 10000000, 190000000, 110000000, // neededExp 6개
    1, 1, 2, 3, 128, 130, // expToLevel 6개
  ]

  it('12개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(12)
  })

  it('각 케이스의 expected가 확정 정본 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('비단조 함정 앵커: neededExp(128)=190000000, neededExp(129)=110000000', () => {
    const cases = buildCases()
    expect(cases[4]?.expected).toBe(190000000)
    expect(cases[5]?.expected).toBe(110000000)
  })

  it('역함수 앵커: expToLevel(128)=2, expToLevel(256)=3, expToLevel(0)=1', () => {
    const cases = buildCases()
    expect(cases[8]?.expected).toBe(2)
    expect(cases[9]?.expected).toBe(3)
    expect(cases[6]?.expected).toBe(1)
  })
})

describe('참조 구현 — SUT와 독립 표현', () => {
  it('referenceNeededExp: L1=128, L128=190000000, L129 선형=110000000', () => {
    expect(referenceNeededExp(1)).toBe(128)
    expect(referenceNeededExp(128)).toBe(190000000)
    expect(referenceNeededExp(129)).toBe(110000000)
  })

  it('referenceExpToLevel: filter 카운트가 while 루프와 등가 (127→1, 128→2, 100M→128)', () => {
    expect(referenceExpToLevel(127)).toBe(1)
    expect(referenceExpToLevel(128)).toBe(2)
    expect(referenceExpToLevel(100000000)).toBe(128)
  })
})

describe('buildFixture (needed_exp)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 needed_exp다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('needed_exp')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-21T00:00:00.000Z')
  })
})

describe('writeFixtureFile (needed_exp)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `needed_exp.test.${process.pid}.json`)
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

describe('체크인된 needed_exp.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/needed_exp.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('needed_exp')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 확정 정본 상수와 일치.
  it('체크인 JSON의 expected가 확정 정본 상수와 일치한다', () => {
    const url = new URL('../fixtures/needed_exp.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([
        128, 256, 100000, 10000000, 190000000, 110000000, 1, 1, 2, 3, 128, 130,
      ])
    }
  })
})
