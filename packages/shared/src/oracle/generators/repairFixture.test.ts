import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceRepair,
  buildCases,
  buildFixture,
  writeFixtureFile,
  type RepairExpected,
} from './repairFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

// 최중요(Layer B): 기대값은 referenceRepair를 호출하지 않고 손 계산 하드 리터럴로 박는다.
// bonusOf(10)=bonus[10]=0, bonusOf(0)=bonus[0]=-4 (stats/tables.ts에서 확인).
// 케이스 순서와 손 계산:
//  0 piety=10 shotscur=0 brokeRoll=15  → broke=15, (15≤15 && 0<1) fail       → {true, 25, null}
//  1 piety=10 shotscur=0 brokeRoll=16  → broke=16(>15), 성공, floor(80*5/10)=40 → {false, 25, 40}
//  2 piety=10 shotscur=1 brokeRoll=5   → broke=5, (5≤5 && 1>0) fail          → {true, 25, null}
//  3 piety=10 shotscur=1 brokeRoll=6   → broke=6(>5), 성공, floor(80*9/10)=72   → {false, 25, 72}
//  4 piety=0  shotscur=0 brokeRoll=19  → broke=19-4=15, fail                 → {true, 25, null}
//  5 piety=0  shotscur=0 brokeRoll=20  → broke=20-4=16, 성공, floor(80*5/10)=40 → {false, 25, 40}
//  6 shotsmax=85 durabilityRoll=7      → 성공, floor(85*7/10)=floor(59.5)=59    → {false, 25, 59}
//  7 value=39 durabilityRoll=5         → cost floor(39/4)=9, floor(80*5/10)=40  → {false, 9, 40}
const HAND_COMPUTED_EXPECTED: RepairExpected[] = [
  { broken: true, cost: 25, newShotscur: null },
  { broken: false, cost: 25, newShotscur: 40 },
  { broken: true, cost: 25, newShotscur: null },
  { broken: false, cost: 25, newShotscur: 72 },
  { broken: true, cost: 25, newShotscur: null },
  { broken: false, cost: 25, newShotscur: 40 },
  { broken: false, cost: 25, newShotscur: 59 },
  { broken: false, cost: 9, newShotscur: 40 },
]

describe('buildCases — anti-tautology 앵커 (repair)', () => {
  it('8개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(8)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toEqual(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('실패 임계값 경계 앵커: brokeRoll=15 → 파괴, 16 → 성공(shotscur<1)', () => {
    const cases = buildCases()
    expect(cases[0]?.expected).toEqual({ broken: true, cost: 25, newShotscur: null })
    expect(cases[1]?.expected).toEqual({ broken: false, cost: 25, newShotscur: 40 })
  })

  it('실패 임계값 경계 앵커: brokeRoll=5 → 파괴, 6 → 성공(shotscur>0)', () => {
    const cases = buildCases()
    expect(cases[2]?.expected).toEqual({ broken: true, cost: 25, newShotscur: null })
    expect(cases[3]?.expected).toEqual({ broken: false, cost: 25, newShotscur: 72 })
  })

  it('bonusOf 통합 앵커: piety=0 → bonusOf(0)=-4 → brokeRoll=19 파괴, 20 성공', () => {
    const cases = buildCases()
    expect(cases[4]?.expected).toEqual({ broken: true, cost: 25, newShotscur: null })
    expect(cases[5]?.expected).toEqual({ broken: false, cost: 25, newShotscur: 40 })
  })

  it('내구도 trunc 트랩 앵커: floor(85*7/10)=59 (곱 위에서 절삭, 85*floor(7/10)=0 아님)', () => {
    expect(buildCases()[6]?.expected).toEqual({ broken: false, cost: 25, newShotscur: 59 })
  })

  it('cost 편차 앵커: value=39 → cost floor(39/4)=9', () => {
    expect(buildCases()[7]?.expected).toEqual({ broken: false, cost: 9, newShotscur: 40 })
  })
})

describe('referenceRepair — SUT와 독립 표현 (인라인 리터럴, repairCost/repair 미참조)', () => {
  const base = {
    value: 100,
    shotscur: 0,
    shotsmax: 80,
    piety: 10,
    brokeRoll: 50,
    durabilityRoll: 5,
  }

  it('fail: broke=15 && shotscur<1 → 파괴', () => {
    expect(referenceRepair({ ...base, brokeRoll: 15, shotscur: 0 })).toEqual({
      broken: true,
      cost: 25,
      newShotscur: null,
    })
  })

  it('success 경계: broke=16 → 복원 floor(80*5/10)=40', () => {
    expect(referenceRepair({ ...base, brokeRoll: 16, shotscur: 0 })).toEqual({
      broken: false,
      cost: 25,
      newShotscur: 40,
    })
  })

  it('bonusOf: piety=0 → broke=19-4=15 → 파괴', () => {
    expect(referenceRepair({ ...base, piety: 0, brokeRoll: 19, shotscur: 0 })).toEqual({
      broken: true,
      cost: 25,
      newShotscur: null,
    })
  })

  it('trunc 트랩: shotsmax=85 durabilityRoll=7 → 59', () => {
    expect(referenceRepair({ ...base, shotsmax: 85, durabilityRoll: 7, shotscur: 1 })).toEqual({
      broken: false,
      cost: 25,
      newShotscur: 59,
    })
  })
})

describe('buildFixture (repair)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 repair이다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('repair')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (repair)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `repair.test.${process.pid}.json`)
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

describe('체크인된 repair.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 repair이다', () => {
    const url = new URL('../fixtures/repair.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('repair')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손 계산 상수와 일치.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/repair.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual(HAND_COMPUTED_EXPECTED)
    }
  })
})
