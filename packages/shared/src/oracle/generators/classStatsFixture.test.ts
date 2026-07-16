import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, writeFixtureFile } from './classStatsFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('classStatsFixture — buildCases', () => {
  it('13행 × 7필드 = 91개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(91)
  })

  it('앵커 셀 expected가 오라클 리터럴과 일치한다', () => {
    const cases = buildCases()
    const find = (classIndex: number, field: string): number | undefined =>
      cases.find((c) => c.input.classIndex === classIndex && c.input.field === field)?.expected
    // fighter(idx4)
    expect(find(4, 'hpstart')).toBe(56)
    expect(find(4, 'hp')).toBe(6)
    expect(find(4, 'mp')).toBe(1)
    // mage(idx5)
    expect(find(5, 'mp')).toBe(3)
    // invincible(idx9)
    expect(find(9, 'hpstart')).toBe(400)
    expect(find(9, 'mpstart')).toBe(250)
    // placeholder(idx0)
    expect(find(0, 'hpstart')).toBe(1)
  })

  it('7개 필드가 C 구조체 순서로 모든 행에 존재한다', () => {
    const cases = buildCases()
    const fields = new Set(cases.filter((c) => c.input.classIndex === 4).map((c) => c.input.field))
    expect(fields).toEqual(
      new Set(['hpstart', 'mpstart', 'hp', 'mp', 'ndice', 'sdice', 'pdice']),
    )
  })
})

describe('classStatsFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('class_stats')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('classStatsFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `class_stats.test.${process.pid}.json`)
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

describe('체크인된 class_stats.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 91개 케이스다', () => {
    const url = new URL('../fixtures/class_stats.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases).toHaveLength(91)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
