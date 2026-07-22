import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, oracleMprofic, writeFixtureFile } from './mproficFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('mproficFixture — oracleMprofic 독립 전사', () => {
  it('realm=0이면 0이다', () => {
    expect(oracleMprofic(5, [0, 0, 0, 0], 1)).toBe(0)
  })

  it('엄격 < 경계: MAGE realm=1024 → 10', () => {
    expect(oracleMprofic(5, [1024, 0, 0, 0], 1)).toBe(10)
  })

  it('MAGE 보간 realm=3072 → 25, trunc 5000 → 32', () => {
    expect(oracleMprofic(5, [3072, 0, 0, 0], 1)).toBe(25)
    expect(oracleMprofic(5, [5000, 0, 0, 0], 1)).toBe(32)
  })

  it('OOB clamp: realm>=5억 → 110', () => {
    expect(oracleMprofic(5, [500000000, 0, 0, 0], 1)).toBe(110)
  })
})

describe('mproficFixture — buildCases', () => {
  it('각 case expected가 oracleMprofic와 일치한다', () => {
    for (const c of buildCases()) {
      expect(c.expected).toBe(oracleMprofic(c.input.class, c.input.realm, c.input.index))
    }
  })
})

describe('mproficFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('mprofic')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('mproficFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `mprofic.test.${process.pid}.json`)
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

describe('체크인된 mprofic.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/mprofic.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
