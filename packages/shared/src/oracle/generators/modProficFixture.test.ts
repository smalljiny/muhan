import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, writeFixtureFile } from './modProficFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('modProficFixture — buildCases', () => {
  it('클래스 0-12 = 13개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(13)
  })

  it('각 클래스 expected가 오라클 나눗수와 일치한다', () => {
    const cases = buildCases()
    const divisors = cases.map((c) => c.expected)
    expect(divisors).toEqual([40, 30, 20, 30, 20, 40, 25, 25, 30, 20, 20, 40, 40])
  })

  it('input이 0-12 클래스 인덱스와 정렬된다', () => {
    const cases = buildCases()
    expect(cases.map((c) => c.input)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })
})

describe('modProficFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('mod_profic')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('modProficFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `mod_profic.test.${process.pid}.json`)
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

describe('체크인된 mod_profic.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 13개 케이스다', () => {
    const url = new URL('../fixtures/mod_profic.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases).toHaveLength(13)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
