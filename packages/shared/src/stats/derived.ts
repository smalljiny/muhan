/**
 * stats/derived — `EffectiveStatContext`를 입력으로 받는 파생 스탯 resolver 런타임 계층.
 *
 * 산술 정본은 `oracle/*`에 단일 출처로 두고, 이 계층은 공통 컨텍스트를 각 oracle 함수의
 * 좁은 입력으로 어댑트해 호출하는 얇은 wrapper만 제공한다(Open Q #5: wrap). 방어도·명중률
 * 등 산술식을 여기서 재정의하지 않는다 — 드리프트 0을 위해 산술은 oracle 한 곳에만 존재한다.
 */

import { computeAc as computeAcOracle } from '../oracle/computeAc.js'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import { thacoOf, bonusOf, proficDivisorOf } from './tables.js'
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

/**
 * 명중(THAC0) resolver — `player.c:1001`의 compute_thaco를 직접 산술로 구현한 SUT.
 *
 * computeAc와 달리 oracle 산술 모듈이 없다 — 산술 정본이 이 함수 자체다. 독립 참조는
 * `oracle/generators/computeThacoFixture.ts`의 `referenceComputeThaco`가 골든 fixture용으로
 * 별도 표현으로 보유한다.
 *
 * 단계:
 *   circle = clamp(trunc((level+3)/4), [1,20]), levelIndex = circle-1
 *   thaco  = thaco_list[class][levelIndex] - weaponAdjustment
 *            - trunc(weaponProficiency / proficDivisor) - bonus[effectiveStrength]
 *   최종 clamp 3분기 (CARETAKER=10):
 *     class<10 && level<101  → Math.max(0, thaco)
 *     class<10 && level>=101 → Math.max(-5, thaco)
 *     class>=10              → Math.max(-10, thaco)
 */
export function computeThaco(context: EffectiveStatContext): number {
  const { effectiveStrength, characterClass, level, weaponAdjustment, weaponProficiency } = context

  const circle = Math.max(1, Math.min(Math.trunc((level + 3) / 4), 20))
  const levelIndex = circle - 1

  let thaco = thacoOf({ classIndex: characterClass, levelIndex })
  thaco -= weaponAdjustment
  thaco -= Math.trunc(weaponProficiency / proficDivisorOf(characterClass))
  thaco -= bonusOf(effectiveStrength)

  if (characterClass < 10) {
    return level < 101 ? Math.max(0, thaco) : Math.max(-5, thaco)
  }
  return Math.max(-10, thaco)
}

/**
 * 최대 소지량 resolver — `player.c:1099`의 max_weight를 직접 산술로 구현한 SUT.
 *
 * `20 + effectiveStrength*10`이 기본이며, barbarian(class 2)만 `trunc((level+3)/4)*10`을
 * 가산한다. 이 barbarian 항의 `(level+3)/4`는 computeThaco의 circle과 달리 `[1,20]` clamp가
 * **없다**(L>=81에서 발산) — circle 헬퍼를 공유하지 않고 인라인으로 계산한다.
 */
export function maxWeight(context: EffectiveStatContext): number {
  const { effectiveStrength, characterClass, level } = context

  let n = 20 + effectiveStrength * 10
  if (characterClass === 2) {
    n += Math.trunc((level + 3) / 4) * 10
  }
  return n
}
