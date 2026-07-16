import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, writeFixtureFile } from './thacoListFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('thacoListFixture — buildCases', () => {
  it('13행 × 20레벨 = 260개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(260)
  })

  it('앵커 셀 expected가 오라클 리터럴과 일치한다', () => {
    const cases = buildCases()
    const find = (classIndex: number, levelIndex: number): number | undefined =>
      cases.find((c) => c.input.classIndex === classIndex && c.input.levelIndex === levelIndex)
        ?.expected
    expect(find(0, 0)).toBe(20) // placeholder
    expect(find(2, 0)).toBe(20) // barbarian L1
    expect(find(2, 19)).toBe(2) // barbarian L20
    expect(find(4, 0)).toBe(20) // fighter L1
    expect(find(4, 19)).toBe(3) // fighter L20
    expect(find(9, 10)).toBe(1) // invincible
    expect(find(12, 19)).toBe(-5) // DM
  })

  it('모든 케이스 levelIndex가 0-19 범위다', () => {
    const cases = buildCases()
    for (const c of cases) {
      expect(c.input.levelIndex).toBeGreaterThanOrEqual(0)
      expect(c.input.levelIndex).toBeLessThanOrEqual(19)
    }
  })
})

describe('thacoListFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('thaco_list')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('thacoListFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `thaco_list.test.${process.pid}.json`)
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

describe('체크인된 thaco_list.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 260개 케이스다', () => {
    const url = new URL('../fixtures/thaco_list.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases).toHaveLength(260)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
