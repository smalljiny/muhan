import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, oracleKnownAfterSet, writeFixtureFile } from './spellStoreFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('spellStoreFixture — oracleKnownAfterSet 독립 전사', () => {
  it('빈 setBits면 어느 비트든 false다', () => {
    expect(oracleKnownAfterSet([], 0)).toBe(false)
    expect(oracleKnownAfterSet([], 127)).toBe(false)
  })

  it('세팅한 비트는 true, 인접 비트는 false다', () => {
    expect(oracleKnownAfterSet([6], 6)).toBe(true)
    expect(oracleKnownAfterSet([6], 5)).toBe(false)
    expect(oracleKnownAfterSet([6], 7)).toBe(false)
  })

  it('바이트 경계를 정확히 가른다(비트8 세팅 시 비트0 false)', () => {
    expect(oracleKnownAfterSet([8], 8)).toBe(true)
    expect(oracleKnownAfterSet([8], 0)).toBe(false)
  })

  it('128비트 최대(127)를 세팅·조회한다', () => {
    expect(oracleKnownAfterSet([127], 127)).toBe(true)
  })
})

describe('spellStoreFixture — buildCases', () => {
  it('각 case expected가 oracleKnownAfterSet와 일치한다', () => {
    for (const c of buildCases()) {
      expect(c.expected).toBe(oracleKnownAfterSet(c.input.setBits, c.input.queryBit))
    }
  })
})

describe('spellStoreFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('spellStore')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('spellStoreFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `spellStore.test.${process.pid}.json`)
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

describe('체크인된 spellStore.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/spellStore.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
