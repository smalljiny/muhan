import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceLevelCycleGains,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './levelCycleFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-21T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (level_cycle)', () => {
  // 최중요(Layer B): 기대값은 참조 구현을 호출하지 않고 확정 정본 하드 리터럴로 박는다.
  // 손 계산: L1→40 성장은 슬롯 {0,2,4,6,8}이 각 2회 발화. 각 클래스 행의 짝수 슬롯 값
  // 히스토그램(v-1)×2가 분포다. 각 튜플 합은 10(성장 이벤트 10회).
  const HAND_COMPUTED_EXPECTED: readonly number[][] = [
    [4, 4, 2, 0, 0], // class1 assassin
    [2, 2, 0, 2, 4], // class2 barbarian
    [2, 0, 4, 4, 0], // class3 cleric
    [2, 4, 0, 2, 2], // class4 fighter
    [2, 0, 0, 4, 4], // class5 mage
    [0, 2, 4, 2, 2], // class6 paladin
    [0, 4, 0, 4, 2], // class7 ranger
    [0, 2, 2, 2, 4], // class8 thief
    [2, 2, 2, 2, 2], // class9 invincible (균등)
  ]

  it('9개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(9)
  })

  it('각 케이스의 expected가 확정 정본 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toEqual(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('각 분포 튜플의 합이 10이다(L1→40 성장 이벤트 10회)', () => {
    for (const testCase of buildCases()) {
      const sum = testCase.expected.reduce((a, b) => a + b, 0)
      expect(sum).toBe(10)
    }
  })

  it('class9(invincible)는 균등 분포 [2,2,2,2,2]다', () => {
    expect(buildCases()[8]?.expected).toEqual([2, 2, 2, 2, 2])
  })
})

describe('참조 구현 — SUT와 독립 표현', () => {
  it('referenceLevelCycleGains: fighter L1→40=[2,4,0,2,2], mage=[2,0,0,4,4]', () => {
    expect(referenceLevelCycleGains(4, 40)).toEqual([2, 4, 0, 2, 2])
    expect(referenceLevelCycleGains(5, 40)).toEqual([2, 0, 0, 4, 4])
  })

  it('targetLevel<4면 성장 이벤트가 없어 전부 0이다', () => {
    expect(referenceLevelCycleGains(4, 3)).toEqual([0, 0, 0, 0, 0])
    expect(referenceLevelCycleGains(4, 1)).toEqual([0, 0, 0, 0, 0])
  })

  it('L1→4는 슬롯 index2(1회)만 발화한다 (fighter row[2]=2=DEX)', () => {
    expect(referenceLevelCycleGains(4, 4)).toEqual([0, 1, 0, 0, 0])
  })
})

describe('buildFixture (level_cycle)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 level_cycle다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('level_cycle')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-21T00:00:00.000Z')
  })
})

describe('writeFixtureFile (level_cycle)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `level_cycle.test.${process.pid}.json`)
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

describe('체크인된 level_cycle.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/level_cycle.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('level_cycle')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 확정 정본 분포와 일치.
  it('체크인 JSON의 expected가 확정 정본 분포와 일치한다', () => {
    const url = new URL('../fixtures/level_cycle.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([
        [4, 4, 2, 0, 0],
        [2, 2, 0, 2, 4],
        [2, 0, 4, 4, 0],
        [2, 4, 0, 2, 2],
        [2, 0, 0, 4, 4],
        [0, 2, 4, 2, 2],
        [0, 4, 0, 4, 2],
        [0, 2, 2, 2, 4],
        [2, 2, 2, 2, 2],
      ])
    }
  })
})
