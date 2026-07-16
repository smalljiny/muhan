import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  referenceComputeThaco,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './computeThacoFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('buildCases — anti-tautology 앵커 (compute_thaco)', () => {
  // 최중요(Layer B): 기대값은 referenceComputeThaco를 호출하지 않고 손 계산 하드 리터럴로 박는다.
  // 참조 구현으로 기대값을 만들면 self-agree tautology가 되어 하네스 의미가 무너진다.
  // A7 §6 테이블-독립 앵커: str10(bonus 0)·adj0·prof0이면 thaco = raw thaco_list 값.
  const HAND_COMPUTED_EXPECTED = [20, 3, 20, 18, 0, 3, -5, -10, -5]

  it('9개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(9)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('A7 앵커: fighter L1=20, fighter L77=3, mage L1=20, assassin L1=18', () => {
    const cases = buildCases()
    expect(cases[0]?.expected).toBe(20)
    expect(cases[1]?.expected).toBe(3)
    expect(cases[2]?.expected).toBe(20)
    expect(cases[3]?.expected).toBe(18)
  })

  it('clamp 3분기 앵커: L<101→0, L>=101→-5, class>=10→-10', () => {
    const cases = buildCases()
    expect(cases[4]?.expected).toBe(0) // barbarian L77 (class<10, L<101) 하한 0
    expect(cases[6]?.expected).toBe(-5) // fighter L101 (class<10, L>=101) 하한 -5
    expect(cases[7]?.expected).toBe(-10) // caretaker (class>=10) 하한 -10
  })
})

describe('referenceComputeThaco — SUT와 독립 표현', () => {
  const ctx = (overrides: {
    effectiveStrength: number
    characterClass: number
    level: number
    weaponAdjustment: number
    weaponProficiency: number
  }) => ({
    effectiveDexterity: 0,
    equipArmor: 0,
    protection: false,
    ...overrides,
  })

  it('circle clamp [1,20]을 적용한다 (fighter L1=20, L77=3)', () => {
    expect(
      referenceComputeThaco(
        ctx({ effectiveStrength: 10, characterClass: 4, level: 1, weaponAdjustment: 0, weaponProficiency: 0 }),
      ),
    ).toBe(20)
    expect(
      referenceComputeThaco(
        ctx({ effectiveStrength: 10, characterClass: 4, level: 77, weaponAdjustment: 0, weaponProficiency: 0 }),
      ),
    ).toBe(3)
  })

  it('mod_profic·bonus·weaponAdjustment를 차감한다 (fighter L40 str25 adj2 prof40 → 3)', () => {
    expect(
      referenceComputeThaco(
        ctx({ effectiveStrength: 25, characterClass: 4, level: 40, weaponAdjustment: 2, weaponProficiency: 40 }),
      ),
    ).toBe(3)
  })

  it('class>=10 하한 -10을 적용한다 (caretaker adj20 → -10)', () => {
    expect(
      referenceComputeThaco(
        ctx({ effectiveStrength: 10, characterClass: 10, level: 1, weaponAdjustment: 20, weaponProficiency: 0 }),
      ),
    ).toBe(-10)
  })
})

describe('buildFixture (compute_thaco)', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual, fn이 compute_thaco다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('compute_thaco')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile (compute_thaco)', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `compute_thaco.test.${process.pid}.json`)
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

describe('체크인된 compute_thaco.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/compute_thaco.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
      expect(result.data.fn).toBe('compute_thaco')
    }
  })

  // frozen 아티팩트 drift 가드(Layer B) — 체크인 JSON의 expected가 손으로 오염되면(오타 등)
  // buildCases 앵커와 별개로 여기서 잡는다. 손 계산 하드 리터럴로 직접 대조한다.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/compute_thaco.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([20, 3, 20, 18, 0, 3, -5, -10, -5])
    }
  })
})
