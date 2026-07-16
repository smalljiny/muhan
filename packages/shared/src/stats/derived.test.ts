import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../oracle/types.js'
import type { GoldenFixture } from '../oracle/types.js'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import { approve } from '../oracle/runner.js'
import { computeAc } from './derived.js'
import type { EffectiveStatContext } from './context.js'

// 체크인된 compute_ac 골든 fixture를 로드해 goldenFixtureSchema로 파싱한 뒤
// GoldenFixture<ComputeAcInput, number>로 취급한다(하네스 인프라 타입 캐스트).
function loadFixture(): GoldenFixture<ComputeAcInput, number> {
  const url = new URL('../oracle/fixtures/compute_ac.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<ComputeAcInput, number>
}

/**
 * fixture의 `ComputeAcInput`을 런타임 wrapper 입력 `EffectiveStatContext`로 역-어댑트한다.
 * computeAc가 판독하는 3개 필드(effectiveDexterity·equipArmor·protection)만 의미가 있고,
 * 나머지 5개(Story 4·5 소비)는 더미값으로 채운다 — computeAc는 이들을 읽지 않는다.
 */
function adaptToContext(input: ComputeAcInput): EffectiveStatContext {
  return {
    effectiveDexterity: input.dexterity,
    effectiveStrength: 0,
    equipArmor: input.equipArmor,
    protection: input.protection,
    characterClass: 1,
    level: 1,
    weaponAdjustment: 0,
    weaponProficiency: 0,
  }
}

describe('런타임 computeAc wrapper 골든 교차검증', () => {
  // T3.3 — 체크인 fixture 전 케이스가 런타임 wrapper(EffectiveStatContext 경유)를 통과한다.
  // oracle computeAc 직접 경로는 oracle/computeAc.test.ts가 이미 검증하므로, 여기선
  // wrapper 경로만 독립적으로 확립한다.
  it('approve(compute_ac fixture, wrapper)가 전 케이스를 throw 없이 통과한다', () => {
    const fixture = loadFixture()
    expect(() => approve(fixture, (input) => computeAc(adaptToContext(input)))).not.toThrow()
  })

  // T3.3 negative control(최중요) — wrapper 출력에 +1 버그를 주입한 변형은 반드시 감지된다.
  // 러너가 실제 차이를 잡아냄을 보증한다(교차검증 통과가 tautology가 아님).
  it('wrapper에 +1 버그를 주입한 변형에는 approve가 throw한다', () => {
    const fixture = loadFixture()
    const buggyWrapper = (input: ComputeAcInput): number => computeAc(adaptToContext(input)) + 1
    expect(() => approve(fixture, buggyWrapper)).toThrow()
  })
})

describe('런타임 computeAc wrapper 스팟 체크', () => {
  it('baseline: effectiveDexterity 10, armor 0, 보호 없음 → 100', () => {
    expect(computeAc(adaptToContext({ dexterity: 10, equipArmor: 0, protection: false }))).toBe(100)
  })

  it('clamp 하한: effectiveDexterity 63, armor 300, 보호 → -127', () => {
    expect(computeAc(adaptToContext({ dexterity: 63, equipArmor: 300, protection: true }))).toBe(
      -127,
    )
  })

  it('보호마법·장비 armor 반영: effectiveDexterity 20, armor 20, 보호 → 55', () => {
    expect(computeAc(adaptToContext({ dexterity: 20, equipArmor: 20, protection: true }))).toBe(55)
  })
})
