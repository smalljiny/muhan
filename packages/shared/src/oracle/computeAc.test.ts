import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from './types.js'
import type { GoldenFixture } from './types.js'
import type { ComputeAcInput } from './generators/computeAcFixture.js'
import { approve } from './runner.js'
import { computeAc } from './computeAc.js'

// 체크인된 compute_ac 골든 fixture를 로드해 goldenFixtureSchema로 파싱한 뒤
// GoldenFixture<ComputeAcInput, number>로 취급한다. cases의 input/expected는 스키마상
// unknown이므로 하네스 인프라 타입 캐스트가 정당하다(도메인 타입 아님).
function loadFixture(): GoldenFixture<ComputeAcInput, number> {
  const url = new URL('./fixtures/compute_ac.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<ComputeAcInput, number>
}

describe('골든 fixture 하네스 end-to-end 데모 (computeAc SUT)', () => {
  // T4.2 — 체크인 fixture 전 케이스가 computeAc SUT를 통과한다(정공식 self-test).
  it('approve(compute_ac fixture, computeAc)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    expect(() => approve(fixture, computeAc)).not.toThrow()
  })

  // T4.3 — negative control(최중요). post-clamp +1 버그를 주입한 변형은 반드시 감지된다.
  // 러너가 실제 차이를 잡아냄을 보증한다(데모 통과가 tautology가 아님).
  it('post-clamp +1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadFixture()
    const buggyComputeAc = (input: ComputeAcInput): number => computeAc(input) + 1
    expect(() => approve(fixture, buggyComputeAc)).toThrow()
  })

  // T4.4 — clamp 하한(-127)·상한(127) 케이스가 fixture에 포함되고, 통과 집합에 든다.
  // 공식의 유일한 비선형부(clamp)가 데모 approve 통과 범위에 실제로 들어감을 검증.
  it('clamp 하한·상한 케이스를 포함하고 그 케이스들이 approve 통과 집합에 든다', () => {
    const fixture = loadFixture()
    expect(fixture.cases.some((c) => c.expected === -127)).toBe(true)
    expect(fixture.cases.some((c) => c.expected === 127)).toBe(true)
    // 이 두 경계 케이스를 포함한 전 케이스가 통과함을 함께 확인.
    expect(() => approve(fixture, computeAc)).not.toThrow()
  })
})

describe('computeAc SUT 자체 정확성 스팟 체크', () => {
  it('baseline: dex 10, armor 0, 보호 없음 → 100', () => {
    expect(computeAc({ dexterity: 10, equipArmor: 0, protection: false })).toBe(100)
  })

  it('clamp 하한: dex 63, armor 300, 보호 → -127', () => {
    expect(computeAc({ dexterity: 63, equipArmor: 300, protection: true })).toBe(-127)
  })

  it('clamp 상한: dex 0, armor -20, 보호 없음 → 127', () => {
    expect(computeAc({ dexterity: 0, equipArmor: -20, protection: false })).toBe(127)
  })

  it('MIN(dex,63) cap: dex 70과 dex 63이 동일 결과', () => {
    expect(computeAc({ dexterity: 70, equipArmor: 0, protection: false })).toBe(
      computeAc({ dexterity: 63, equipArmor: 0, protection: false }),
    )
  })

  // bonus[63]=7을 비포화(non-clamp) 하드 리터럴로 독립 고정한다 — 위 MIN cap 테스트는
  // dex70===dex63 자기순환이라 bonus[63] 실값을 못 박지 못한다. 100-5·7=65.
  it('MIN cap 인덱스 값 앵커: dex 63, armor 0, 보호 없음 → 65 (비포화)', () => {
    expect(computeAc({ dexterity: 63, equipArmor: 0, protection: false })).toBe(65)
  })

  it('보호마법·장비 armor 반영: dex 20, armor 20, 보호 → 55', () => {
    expect(computeAc({ dexterity: 20, equipArmor: 20, protection: true })).toBe(55)
  })

  it('음 bonus(dex 0)·하한 방어: dex 0, armor 0, 보호 없음 → 120', () => {
    expect(computeAc({ dexterity: 0, equipArmor: 0, protection: false })).toBe(120)
  })
})
