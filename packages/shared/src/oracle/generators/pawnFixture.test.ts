import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referencePawn,
  buildCases,
  buildFixture,
  writeFixtureFile,
  type PawnExpected,
} from './pawnFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

// 최중요(Layer B): 기대값은 referencePawn을 호출하지 않고 손 계산 하드 리터럴로 박는다.
// 케이스 순서와 손 계산(gold=trunc(value/2)):
//  0 value=39                              → gold 19 < 20            → low-value, 0
//  1 value=40 lucky=1                      → gold 20, 통과, 비럭키     → null, 20
//  2 type=0 shotsmax=80 shotscur=10        → gold 50, 10<=trunc(80/8)=10 → low-quality, 0
//  3 type=0 shotsmax=80 shotscur=11 lucky=1→ gold 50, 11>10, 통과      → null, 50
//  4 type=8(WAND) shotscur=0               → gold 50, 0<1             → low-quality, 0
//  5 type=8 shotscur=1 lucky=1             → gold 50, 통과            → null, 50
//  6 onewev=true                          → gold 50, bound          → bound-item, 0
//  7 hasContents=true                     → gold 50, container      → non-empty-container, 0
//  8 type=7(SCROLL)                       → gold 50, unsellable     → unsellable-type, 0
//  9 type=6(POTION)                       → gold 50, unsellable     → unsellable-type, 0
// 10 value=100 lucky=1                     → gold 50, 통과, 비럭키     → null, 50
// 11 value=100 lucky=9                     → gold 50, 럭키 pay-twice  → null, 100
// 12 value=250000 lucky=1                  → min(trunc(125000),100000)→ null, 100000
const HAND_COMPUTED_EXPECTED: PawnExpected[] = [
  { rejectReason: 'low-value', payout: 0 },
  { rejectReason: null, payout: 20 },
  { rejectReason: 'low-quality', payout: 0 },
  { rejectReason: null, payout: 50 },
  { rejectReason: 'low-quality', payout: 0 },
  { rejectReason: null, payout: 50 },
  { rejectReason: 'bound-item', payout: 0 },
  { rejectReason: 'non-empty-container', payout: 0 },
  { rejectReason: 'unsellable-type', payout: 0 },
  { rejectReason: 'unsellable-type', payout: 0 },
  { rejectReason: null, payout: 50 },
  { rejectReason: null, payout: 100 },
  { rejectReason: null, payout: 100000 },
]

describe('buildCases — anti-tautology 앵커 (pawn)', () => {
  it('13개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(13)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toEqual(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('low-value 경계 앵커: value=39 → 거부(19<20), value=40 → payout 20', () => {
    const cases = buildCases()
    expect(cases[0]?.expected).toEqual({ rejectReason: 'low-value', payout: 0 })
    expect(cases[1]?.expected).toEqual({ rejectReason: null, payout: 20 })
  })

  it('low-quality 무기 경계 앵커: shotscur 10 → 거부, 11 → payout 50', () => {
    const cases = buildCases()
    expect(cases[2]?.expected).toEqual({ rejectReason: 'low-quality', payout: 0 })
    expect(cases[3]?.expected).toEqual({ rejectReason: null, payout: 50 })
  })

  it('low-quality 완드 경계 앵커: shotscur 0 → 거부, 1 → payout 50', () => {
    const cases = buildCases()
    expect(cases[4]?.expected).toEqual({ rejectReason: 'low-quality', payout: 0 })
    expect(cases[5]?.expected).toEqual({ rejectReason: null, payout: 50 })
  })

  it('이중 지급 앵커: luckyRoll===9 → pay-twice 100 (=2*50)', () => {
    expect(buildCases()[11]?.expected).toEqual({ rejectReason: null, payout: 100 })
  })

  it('상한 clamp 앵커: value=250000 → 100000', () => {
    expect(buildCases()[12]?.expected).toEqual({ rejectReason: null, payout: 100000 })
  })
})

describe('referencePawn — SUT와 독립 표현 (인라인 리터럴, sellPrice/sell 미참조)', () => {
  const base = {
    value: 100,
    type: 13,
    shotscur: 0,
    shotsmax: 0,
    onewev: false,
    hasContents: false,
    luckyRoll: 1,
  }

  it('low-value: value=39 → low-value', () => {
    expect(referencePawn({ ...base, value: 39 })).toEqual({ rejectReason: 'low-value', payout: 0 })
  })

  it('low-quality 무기: type=0 shotsmax=80 shotscur=10 → low-quality', () => {
    expect(referencePawn({ ...base, type: 0, shotsmax: 80, shotscur: 10 })).toEqual({
      rejectReason: 'low-quality',
      payout: 0,
    })
  })

  it('bound: onewev=true → bound-item', () => {
    expect(referencePawn({ ...base, onewev: true })).toEqual({
      rejectReason: 'bound-item',
      payout: 0,
    })
  })

  it('정상: value=100 luckyRoll=1 → payout 50', () => {
    expect(referencePawn({ ...base, luckyRoll: 1 })).toEqual({ rejectReason: null, payout: 50 })
  })

  it('이중: value=100 luckyRoll=9 → payout 100 (pay-twice)', () => {
    expect(referencePawn({ ...base, luckyRoll: 9 })).toEqual({ rejectReason: null, payout: 100 })
  })
})

describe('buildFixture (pawn)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 pawn이다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('pawn')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (pawn)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `pawn.test.${process.pid}.json`)
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

describe('체크인된 pawn.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 pawn이다', () => {
    const url = new URL('../fixtures/pawn.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('pawn')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손 계산 상수와 일치.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/pawn.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual(HAND_COMPUTED_EXPECTED)
    }
  })
})
