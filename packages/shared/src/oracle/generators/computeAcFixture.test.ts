import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../types.js'
import {
  bonus,
  referenceComputeAc,
  buildCases,
  buildFixture,
  writeFixtureFile,
} from './computeAcFixture.js'

// 고정 clock — 결정적 generatedAt 스탬프에 사용한다.
const FIXED_CLOCK = () => new Date('2026-07-13T00:00:00.000Z')

describe('bonus 상수 테이블', () => {
  it('정확히 64개 원소를 가진다', () => {
    expect(bonus).toHaveLength(64)
  })

  it('앵커 인덱스 값이 원본 테이블과 일치한다', () => {
    expect(bonus[0]).toBe(-4)
    expect(bonus[10]).toBe(0)
    expect(bonus[20]).toBe(3)
    expect(bonus[63]).toBe(7)
  })

  it('인덱스 48~63이 전부 7이다', () => {
    for (let i = 48; i <= 63; i += 1) {
      expect(bonus[i]).toBe(7)
    }
  })
})

describe('buildCases — anti-tautology 앵커', () => {
  // 최중요: 기대값은 referenceComputeAc를 호출하지 않고 손 계산 하드 리터럴로 박는다.
  // referenceComputeAc로 기대값을 만들면 tautology가 되어 하네스 의미가 무너진다.
  const HAND_COMPUTED_EXPECTED = [100, 55, 65, 120, -127, 127, 65]
  const EXPECTED_INPUTS = [
    { dexterity: 10, equipArmor: 0, protection: false },
    { dexterity: 20, equipArmor: 20, protection: true },
    { dexterity: 63, equipArmor: 0, protection: false },
    { dexterity: 0, equipArmor: 0, protection: false },
    { dexterity: 63, equipArmor: 300, protection: true },
    { dexterity: 0, equipArmor: -20, protection: false },
    { dexterity: 70, equipArmor: 0, protection: false },
  ]

  it('7개 케이스를 생성한다', () => {
    expect(buildCases()).toHaveLength(7)
  })

  it('각 케이스의 expected가 손 계산 상수와 정확히 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.expected).toBe(HAND_COMPUTED_EXPECTED[index])
    })
  })

  it('각 케이스의 input이 명세 표와 일치한다', () => {
    const cases = buildCases()
    cases.forEach((testCase, index) => {
      expect(testCase.input).toEqual(EXPECTED_INPUTS[index])
    })
  })

  it('clamp 상한 케이스(#6)의 note에 "clamp 상한" 문자열이 포함된다', () => {
    const cases = buildCases()
    expect(cases[5]?.note).toContain('clamp 상한')
    expect(cases[5]?.note).toBe('clamp 상한 경계·게임 현실성 미검증')
  })
})

describe('referenceComputeAc', () => {
  it('baseline 케이스를 손 계산 상수와 일치시킨다', () => {
    expect(referenceComputeAc({ dexterity: 10, equipArmor: 0, protection: false })).toBe(100)
  })

  it('MIN(dex,63) cap을 적용한다', () => {
    // dex 70과 63이 동일 결과여야 cap이 동작한다.
    expect(referenceComputeAc({ dexterity: 70, equipArmor: 0, protection: false })).toBe(
      referenceComputeAc({ dexterity: 63, equipArmor: 0, protection: false }),
    )
  })

  it('clamp 하한·상한을 각각 -127·127로 고정한다', () => {
    expect(referenceComputeAc({ dexterity: 63, equipArmor: 300, protection: true })).toBe(-127)
    expect(referenceComputeAc({ dexterity: 0, equipArmor: -20, protection: false })).toBe(127)
  })
})

describe('buildFixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const fixture = buildFixture(FIXED_CLOCK)
    expect(goldenFixtureSchema.safeParse(fixture).success).toBe(true)
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.fn).toBe('compute_ac')
  })

  it('generatedAt이 주입 clock으로 결정적이다', () => {
    const a = buildFixture(FIXED_CLOCK)
    const b = buildFixture(FIXED_CLOCK)
    expect(a.oracle.generatedAt).toBe(b.oracle.generatedAt)
    expect(a.oracle.generatedAt).toBe('2026-07-13T00:00:00.000Z')
  })
})

describe('writeFixtureFile', () => {
  it('pretty JSON을 기록하고, 재로드 시 goldenFixtureSchema를 통과한다', () => {
    const path = join(tmpdir(), `compute_ac.test.${process.pid}.json`)
    try {
      writeFixtureFile(path, buildFixture(FIXED_CLOCK))
      const raw = readFileSync(path, 'utf8')
      // 2-space pretty 포맷 확인 — 들여쓰기 라인이 존재해야 한다.
      expect(raw).toContain('\n  ')
      const parsed: unknown = JSON.parse(raw)
      expect(goldenFixtureSchema.safeParse(parsed).success).toBe(true)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('체크인된 compute_ac.json fixture', () => {
  it('goldenFixtureSchema를 통과하고 method가 manual이다', () => {
    const url = new URL('../fixtures/compute_ac.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    // 타입 안전한 접근을 위해 파싱된 데이터를 사용한다.
    if (result.success) {
      expect(result.data.oracle.method).toBe('manual')
    }
  })

  // frozen 아티팩트 drift 가드 — 체크인 JSON의 expected가 손으로 오염되면(오타 등)
  // buildCases 앵커와 별개로 여기서 잡는다. 손 계산 하드 리터럴로 직접 대조한다.
  it('체크인 JSON의 expected가 손 계산 상수와 일치한다', () => {
    const url = new URL('../fixtures/compute_ac.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cases.map((c) => c.expected)).toEqual([100, 55, 65, 120, -127, 127, 65])
    }
  })
})
