import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, oracleCanTeachSpllv, writeFixtureFile } from './spllvTeachFixture.js'

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

// mtype.h 리터럴(테스트 내 독립 참조).
const CLERIC = 3
const MAGE = 5
const INVINCIBLE = 9
const CARETAKER = 10
const SUB_DM = 11

describe('spllvTeachFixture — oracleCanTeachSpllv 독립 전사', () => {
  it('spllv1은 CLERIC 또는 INVINCIBLE↑만 허용한다', () => {
    expect(oracleCanTeachSpllv(CLERIC, 1)).toBe(true)
    expect(oracleCanTeachSpllv(MAGE, 1)).toBe(false)
    expect(oracleCanTeachSpllv(INVINCIBLE, 1)).toBe(true)
    expect(oracleCanTeachSpllv(CARETAKER, 1)).toBe(true)
  })

  it('spllv2는 MAGE 또는 INVINCIBLE↑만 허용한다', () => {
    expect(oracleCanTeachSpllv(MAGE, 2)).toBe(true)
    expect(oracleCanTeachSpllv(CLERIC, 2)).toBe(false)
    expect(oracleCanTeachSpllv(INVINCIBLE, 2)).toBe(true)
  })

  it('spllv3은 INVINCIBLE↑만 허용한다', () => {
    expect(oracleCanTeachSpllv(INVINCIBLE, 3)).toBe(true)
    expect(oracleCanTeachSpllv(CARETAKER, 3)).toBe(true)
    expect(oracleCanTeachSpllv(MAGE, 3)).toBe(false)
  })

  it('spllv4는 CARETAKER↑만 허용한다(INVINCIBLE 거부)', () => {
    expect(oracleCanTeachSpllv(CARETAKER, 4)).toBe(true)
    expect(oracleCanTeachSpllv(INVINCIBLE, 4)).toBe(false)
  })

  it('spllv5는 SUB_DM↑만 허용한다(CARETAKER 거부 quirk)', () => {
    expect(oracleCanTeachSpllv(SUB_DM, 5)).toBe(true)
    expect(oracleCanTeachSpllv(CARETAKER, 5)).toBe(false)
  })

  it('범위 밖 spllv(0)은 매칭 if가 없어 true다', () => {
    expect(oracleCanTeachSpllv(CLERIC, 0)).toBe(true)
  })
})

describe('spllvTeachFixture — buildCases', () => {
  it('각 case expected가 oracleCanTeachSpllv와 일치한다', () => {
    for (const c of buildCases()) {
      expect(c.expected).toBe(oracleCanTeachSpllv(c.input.class, c.input.spllv))
    }
  })
})

describe('spllvTeachFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('canTeachSpllv')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('spllvTeachFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `spllv_teach.test.${process.pid}.json`)
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

describe('체크인된 spllv_teach.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/spllv_teach.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
