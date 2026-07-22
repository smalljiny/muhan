import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import { buildCases, buildFixture, writeFixtureFile } from './spellFailFixture.js'

/**
 * spellFailFixture 생성기 테스트 — buildCases/buildFixture/writeFixtureFile + 체크인 json 검증.
 *
 * SUT(spellFail) approve는 server가 소유한다(shared는 server import 불가). 여기서는 생성기의 독립
 * 전사가 magic8.c 공식을 맞게 옮겼는지 손계산 값으로 lock한다 — approve와 함께 anti-tautology를
 * 양쪽에서 잠근다.
 */

const FIXED_CLOCK = (): Date => new Date('2026-07-16T00:00:00.000Z')

// 특정 입력의 케이스를 찾는다.
function findCase(class_: number, level: number, intBonus: number, n: number) {
  return buildCases().find(
    (c) =>
      c.input.class === class_ &&
      c.input.level === level &&
      c.input.intBonus === intBonus &&
      c.input.n === n,
  )
}

describe('spellFailFixture — buildCases 손계산 lock(anti-tautology)', () => {
  it('BARBARIAN L1 int0 → chance=(trunc(4/4))*5+0=5, n=50 > 5 → 실패(true)', () => {
    expect(findCase(2, 1, 0, 50)?.expected).toBe(true)
  })

  it('BARBARIAN L1 int0 경계: n==5 성공(false), n==6 실패(true)', () => {
    expect(findCase(2, 1, 0, 5)?.expected).toBe(false)
    expect(findCase(2, 1, 0, 6)?.expected).toBe(true)
  })

  it('MAGE L5 int2 → chance=(4)*5+75=95 경계: n==95 성공, n==96 실패', () => {
    expect(findCase(5, 5, 2, 95)?.expected).toBe(false)
    expect(findCase(5, 5, 2, 96)?.expected).toBe(true)
  })

  it('무cap: MAGE L100 int5 → chance=225, n=100이어도 성공(false)', () => {
    expect(findCase(5, 100, 5, 100)?.expected).toBe(false)
  })

  it('default 클래스(9/11/12/0)는 n=100이어도 성공(false)', () => {
    expect(findCase(9, 50, 3, 100)?.expected).toBe(false)
    expect(findCase(11, 50, 3, 100)?.expected).toBe(false)
    expect(findCase(12, 50, 3, 100)?.expected).toBe(false)
    expect(findCase(0, 1, 0, 100)?.expected).toBe(false)
  })

  it('8클래스 chance 경계가 모두 전개된다(cls 1-8 각 2케이스 = 16)', () => {
    for (let cls = 1; cls <= 8; cls += 1) {
      const forClass = buildCases().filter((c) => c.input.class === cls && c.input.level === 5)
      expect(forClass.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('spellFailFixture — buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 fn/method가 맞다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.fn).toBe('spell_fail')
    expect(fixture.oracle.method).toBe('manual')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    expect(buildFixture(FIXED_CLOCK).oracle.generatedAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

describe('spellFailFixture — writeFixtureFile', () => {
  it('pretty JSON을 기록하고 재로드 시 스키마를 통과한다', () => {
    const path = join(tmpdir(), `spell_fail.test.${process.pid}.json`)
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

describe('체크인된 spell_fail.json 골든 fixture', () => {
  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const url = new URL('../fixtures/spell_fail.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.length).toBeGreaterThan(0)
      expect(result.data.oracle.method).toBe('manual')
    }
  })
})
