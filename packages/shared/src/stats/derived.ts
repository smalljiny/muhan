/**
 * stats/derived — `EffectiveStatContext`를 입력으로 받는 파생 스탯 resolver 런타임 계층.
 *
 * 산술 정본은 `oracle/*`에 단일 출처로 두고, 이 계층은 공통 컨텍스트를 각 oracle 함수의
 * 좁은 입력으로 어댑트해 호출하는 얇은 wrapper만 제공한다(Open Q #5: wrap). 방어도·명중률
 * 등 산술식을 여기서 재정의하지 않는다 — 드리프트 0을 위해 산술은 oracle 한 곳에만 존재한다.
 */

import { computeAc as computeAcOracle } from '../oracle/computeAc.js'
import type { ComputeAcInput } from '../oracle/generators/computeAcFixture.js'
import { thacoOf, bonusOf, proficDivisorOf, classStatOf } from './tables.js'
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
  // oracle 발산(의도): C `compute_thaco`(player.c:1011)는 `bonus[strength]`를 무클램프로
  // 첨자하나, `bonusOf`는 [0,63]으로 clamp한다. 정상 능력치 범위에서는 동일하고, clamp가
  // C의 잠재적 OOB 읽기보다 안전하다 — effectiveStrength>63(버프 스택) 극단에서만 갈린다.
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

/**
 * 최대 HP resolver — `player.c:805`의 up_level HP 성장 폐형을 직접 산술로 구현한 SUT.
 *
 * `hpMax = hpstart + trunc(hp * (level-1) / 2)`. `hpstart`(1레벨 기본)와 `hp`(레벨당 성장
 * 계수)는 `classStatOf`로 판독한다. 현재 HP·재생은 파생하지 않는다 — 최대치만 계산한다.
 *
 * ## 결정적 함정: 정수 나눗셈 그룹핑
 * C 원본 `hp * (level-1) / 2`는 `*`·`/` 동일 우선순위·좌결합이라 `(hp*(level-1))/2`이며
 * truncation이 **곱 결과에 적용**된다. `Math.trunc(hp * (level - 1) / 2)`로 그룹핑한다 —
 * `hp * Math.trunc((level-1)/2)`로 잘못 묶으면 오답이다(fighter L10이 83 아닌 80).
 *
 * ## oracle 발산 수용: 폐형만 구현
 * 원본 `up_level`은 폐형(805–808) 이전에 홀짝 증분(779–780)을 수행하고, 폐형 재계산은
 * `level==1`·`level%4==0`에서만 도달한다(791행 조기 return). `level%4≠0` 레벨은 증분
 * 누적값이 잔존해 폐형과 **발산**하며 그 값이 디스크에 저장·관측된다(fighter hpMax:
 * L2 게임56/폐형59, L5 71/68, L7 77/74). 이 발산은 `level%4` 조기 return이 만든 형상
 * 버그로 판단해 신규 스택은 **폐형 하나만** 구현한다 — 발산 레벨에서 원본과 다를 수 있으며
 * 수용된 결정이다(근거: `docs/notes/game-analysis-20260625/a7-player-progression.md` §2 정정).
 */
export function computeHpMax(context: EffectiveStatContext): number {
  const { characterClass, level } = context
  const hpstart = classStatOf({ classIndex: characterClass, field: 'hpstart' })
  const hp = classStatOf({ classIndex: characterClass, field: 'hp' })
  return hpstart + Math.trunc((hp * (level - 1)) / 2)
}

/**
 * 최대 MP resolver — `player.c:806`의 up_level MP 성장 폐형을 직접 산술로 구현한 SUT.
 *
 * `mpMax = mpstart + trunc(mp * (level-1) / 2)`. computeHpMax와 동일한 그룹핑 규칙을 따른다 —
 * truncation은 곱 결과에 적용한다. `mpstart`·`mp`는 `classStatOf`로 판독한다.
 * oracle 발산 수용(폐형만 구현)도 computeHpMax와 동일하다 — MP는 짝수 레벨 증분이라
 * `level%4≠0` 짝수 레벨에서 폐형과 발산한다(같은 A7 §2 근거).
 */
export function computeMpMax(context: EffectiveStatContext): number {
  const { characterClass, level } = context
  const mpstart = classStatOf({ classIndex: characterClass, field: 'mpstart' })
  const mp = classStatOf({ classIndex: characterClass, field: 'mp' })
  return mpstart + Math.trunc((mp * (level - 1)) / 2)
}
