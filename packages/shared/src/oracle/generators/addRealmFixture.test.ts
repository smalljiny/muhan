import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, oracleRealmGrowth, writeFixtureFile } from './addRealmFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('addRealmFixture — oracleRealmGrowth 독립 전사', () => {
  it('growth=MIN(trunc(m*exp/hpmax), exp)', () => {
    // m=15, exp=100, hpmax=30 → trunc(1500/30)=50, MIN(50,100)=50.
    expect(oracleRealmGrowth({ m: 15, exp: 100, hpmax: 30 })).toBe(50)
  })

  it('exp 캡·trunc·hpmax 0가드', () => {
    expect(oracleRealmGrowth({ m: 60, exp: 10, hpmax: 30 })).toBe(10)
    expect(oracleRealmGrowth({ m: 7, exp: 10, hpmax: 30 })).toBe(2)
    expect(oracleRealmGrowth({ m: 5, exp: 10, hpmax: 0 })).toBe(10)
  })

  it('exp=0 → 성장 0', () => {
    expect(oracleRealmGrowth({ m: 15, exp: 0, hpmax: 30 })).toBe(0)
  })
})

describe('addRealmFixture — buildCases', () => {
  it('각 case expected가 oracleRealmGrowth와 일치한다', () => {
    for (const c of buildCases()) {
      expect(c.expected).toBe(oracleRealmGrowth(c.input))
    }
  })

  it('성장>0·성장=0 케이스를 모두 포함한다(분기 커버)', () => {
    const cases = buildCases()
    expect(cases.some((c) => c.expected > 0)).toBe(true)
    expect(cases.some((c) => c.expected === 0)).toBe(true)
  })
})

describe('addRealmFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('realmGrowthAmount')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('addRealmFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `addrealm.test.${process.pid}.json`)
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

describe('체크인된 addrealm.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/addrealm.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
