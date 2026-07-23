import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  buildBuffCases,
  buildBuffFixture,
  buildDebuffCases,
  buildDebuffFixture,
  oracleBuffDur,
  oracleDebuffDur,
  writeFixtureFile,
} from './buffDurationFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

describe('buffDurationFixture — oracleBuffDur 독립 전사(A6 §6)', () => {
  it('base MAX(300, 1200+B*600)', () => {
    expect(oracleBuffDur({ spellNo: 5, intBonus: 0, level: 10, casterClass: 4, gated: true, rpmext: false })).toBe(1200)
    expect(oracleBuffDur({ spellNo: 22, intBonus: 2, level: 10, casterClass: 5, gated: true, rpmext: false })).toBe(2400)
  })

  it('음수 B 하한·클래스·RPMEXT·비-CAST', () => {
    // 음수 B → 300.
    expect(oracleBuffDur({ spellNo: 22, intBonus: -2, level: 10, casterClass: 5, gated: true, rpmext: false })).toBe(300)
    // CLERIC protection +60*L4(3)=180.
    expect(oracleBuffDur({ spellNo: 5, intBonus: 0, level: 10, casterClass: 3, gated: true, rpmext: false })).toBe(1380)
    // fly RPMEXT 600.
    expect(oracleBuffDur({ spellNo: 23, intBonus: 0, level: 10, casterClass: 5, gated: true, rpmext: true })).toBe(1800)
    // 비-CAST 고정.
    expect(oracleBuffDur({ spellNo: 5, intBonus: 5, level: 60, casterClass: 3, gated: false, rpmext: true })).toBe(1200)
  })
})

describe('buffDurationFixture — oracleDebuffDur 독립 전사(A6 §7)', () => {
  it('fear/silence/charm base', () => {
    expect(oracleDebuffDur({ spellNo: 50, intBonus: 2, prmagi: false, roll: 5 })).toBe(950)
    expect(oracleDebuffDur({ spellNo: 54, intBonus: 5, prmagi: false, roll: 30 })).toBe(3600)
    expect(oracleDebuffDur({ spellNo: 55, intBonus: 1, prmagi: false, roll: 10 })).toBe(430)
  })

  it('PRMAGI trunc(dur/2)', () => {
    expect(oracleDebuffDur({ spellNo: 54, intBonus: 0, prmagi: true, roll: 1 })).toBe(1800)
    expect(oracleDebuffDur({ spellNo: 50, intBonus: 0, prmagi: true, roll: 1 })).toBe(305)
  })
})

describe('buffDurationFixture — buildCases 정합', () => {
  it('buff 각 case expected가 oracleBuffDur와 일치한다', () => {
    for (const c of buildBuffCases()) expect(c.expected).toBe(oracleBuffDur(c.input))
  })

  it('debuff 각 case expected가 oracleDebuffDur와 일치한다', () => {
    for (const c of buildDebuffCases()) expect(c.expected).toBe(oracleDebuffDur(c.input))
  })

  it('buff 케이스가 하한·클래스·RPMEXT·비-CAST 분기를 모두 포함한다', () => {
    const cases = buildBuffCases()
    expect(cases.some((c) => !c.input.gated)).toBe(true) // 비-CAST
    expect(cases.some((c) => c.input.intBonus < 0)).toBe(true) // 하한
    expect(cases.some((c) => c.input.rpmext)).toBe(true) // RPMEXT
  })

  it('debuff 케이스가 PRMAGI 분기를 포함한다', () => {
    expect(buildDebuffCases().some((c) => c.input.prmagi)).toBe(true)
  })
})

describe('buffDurationFixture — buildFixture', () => {
  it('buff/debuff fixture가 스키마를 통과하고 fn/method가 맞다', () => {
    const buff = buildBuffFixture(FIXED_CLOCK)
    const debuff = buildDebuffFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(buff).success).toBe(true)
    expect(goldenFixtureSchema.safeParse(debuff).success).toBe(true)
    expect(buff.fn).toBe('computeBuffDur')
    expect(debuff.fn).toBe('computeDebuffDur')
    expect(buff.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildBuffFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('buffDurationFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `buff_duration.test.${process.pid}.json`)
    try {
      writeFixtureFile(path, buildBuffFixture(FIXED_CLOCK))
      const raw = readFileSync(path, 'utf8')
      expect(raw).toContain('\n  ')
      const parsed: unknown = JSON.parse(raw)
      expect(goldenFixtureSchema.safeParse(parsed).success).toBe(true)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('체크인된 buff/debuff_duration.json fixture', () => {
  it('두 fixture가 goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    for (const name of ['buff_duration.json', 'debuff_duration.json']) {
      const url = new URL(`../fixtures/${name}`, import.meta.url)
      const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
      const result = goldenFixtureSchema.safeParse(parsed)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.cases.length).toBeGreaterThan(0)
        expect(result.data.oracle.method).toBe('manual')
      }
    }
  })
})
