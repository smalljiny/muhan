import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from './types.js'
import type { GoldenFixture } from './types.js'
import type { NeededExpCaseInput } from './generators/neededExpFixture.js'
import { approve } from './runner.js'
import { neededExp, expToLevel } from '../progression/expCurve.js'

// 체크인된 needed_exp 골든 fixture를 로드해 goldenFixtureSchema로 파싱한 뒤
// GoldenFixture<NeededExpCaseInput, number>로 취급한다. cases의 input/expected는 스키마상
// unknown이므로 하네스 인프라 타입 캐스트가 정당하다(도메인 타입 아님).
function loadFixture(): GoldenFixture<NeededExpCaseInput, number> {
  const url = new URL('./fixtures/needed_exp.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<NeededExpCaseInput, number>
}

// discriminated input을 SUT 두 함수로 디스패치한다 — neededExp / expToLevel.
function sut(input: NeededExpCaseInput): number {
  return input.fn === 'neededExp' ? neededExp(input.arg) : expToLevel(input.arg)
}

describe('골든 fixture 회귀 (needed_exp SUT)', () => {
  it('approve(needed_exp fixture, sut)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    expect(() => approve(fixture, sut)).not.toThrow()
  })

  // negative control(최중요) — +1 버그를 주입한 변형은 반드시 감지된다.
  it('+1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadFixture()
    const buggy = (input: NeededExpCaseInput): number => sut(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })

  // 비단조 함정과 역함수 경계가 fixture에 실제로 포함되고 통과 집합에 든다.
  it('비단조 forward(190000000)·선형 역산(130) 케이스를 포함하고 통과 집합에 든다', () => {
    const fixture = loadFixture()
    expect(fixture.cases.some((c) => c.expected === 190000000)).toBe(true)
    expect(fixture.cases.some((c) => c.expected === 130)).toBe(true)
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
