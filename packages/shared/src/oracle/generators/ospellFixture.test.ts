import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { approve } from '../runner.js'
import { ospellOf, SPELL_NO } from '../../magic/catalog.js'
import { buildCases, buildFixture, writeFixtureFile } from './ospellFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('ospellFixture — buildCases', () => {
  it('ospell 20종 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(20)
  })

  it('input은 spellNo, expected는 동일 spellNo를 담은 전체 행이다', () => {
    for (const testCase of buildCases()) {
      expect(testCase.expected.spellNo).toBe(testCase.input)
    }
  })

  it('예외 셀(화선도 sdice=7·pdice=1)이 오라클 리터럴에 전사돼 있다', () => {
    const burns = buildCases().find((c) => c.input === SPELL_NO.SBURNS)
    expect(burns?.expected).toEqual({
      spellNo: 27,
      realm: 3,
      mp: 3,
      ndice: 1,
      sdice: 7,
      pdice: 1,
      bonusType: 1,
    })
  })
})

describe('ospellFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('ospell')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('ospellFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `ospell.test.${process.pid}.json`)
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

describe('체크인된 ospell.json 골든 fixture', () => {
  it('goldenFixtureSchema를 통과하고 20개 케이스다', () => {
    const url = new URL('../fixtures/ospell.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases).toHaveLength(20)
      expect(result.data.oracle.method).toBe('manual')
    }
  })

  it('approve가 catalog ospellOf SUT로 20 케이스를 throw 없이 통과한다', () => {
    // anti-tautology: fixture expected는 ospellFixture.ts의 독립 전사(global.c),
    // SUT ospellOf는 catalog.ts 격자 전사. 두 전사가 diff되면 approve가 throw한다.
    const url = new URL('../fixtures/ospell.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) return
    const fixture = result.data as Parameters<typeof approve>[0]
    const sut = (spellNo: unknown): unknown => {
      const entry = ospellOf(spellNo as number)
      if (!entry) throw new Error(`ospell 격자에 spellNo ${String(spellNo)} 없음`)
      return entry
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
