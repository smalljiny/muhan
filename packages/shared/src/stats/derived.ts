/**
 * stats/derived — `EffectiveStatContext`를 입력으로 받는 파생 스탯 resolver 런타임 계층.
 *
 * 산술 정본은 `oracle/*`에 단일 출처로 두고, 이 계층은 공통 컨텍스트를 각 oracle 함수의
 * 좁은 입력으로 어댑트해 호출하는 얇은 wrapper만 제공한다(Open Q #5: wrap). 방어도·명중률
 * 등 산술식을 여기서 재정의하지 않는다 — 드리프트 0을 위해 산술은 oracle 한 곳에만 존재한다.
 */

import { computeAc as computeAcOracle } from '../oracle/computeAc.js'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import type { EffectiveStatContext } from './context.js'

/**
 * 방어도 resolver — `EffectiveStatContext`를 `ComputeAcInput`으로 어댑트해 oracle
 * `computeAc`를 호출하는 얇은 wrapper. 산술식은 `oracle/computeAc.ts`가 정본이다.
 */
export function computeAc(context: EffectiveStatContext): number {
  const input: ComputeAcInput = {
    dexterity: context.effectiveDexterity,
    equipArmor: context.equipArmor,
    protection: context.protection,
  }
  return computeAcOracle(input)
}
