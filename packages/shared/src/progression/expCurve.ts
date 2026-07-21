import { needed_exp, MAXALVL } from './tables.js'

/**
 * progression/expCurve — 무한 exp 곡선 룩업(`neededExp`)과 역함수(`expToLevel`)의 순수 이식.
 *
 * 결정적(RNG 없음)이며 순수 함수다. 원본 `command7.c:590-593`(neededExp)과
 * `misc.c:472-481`(exp_to_lev)의 동작을 그대로 재현한다. Story 6 train 게이트가 이 두
 * 함수를 직접 소비한다.
 *
 * ## 결정적 함정: 배열 상한과 선형 확장 피벗의 불일치
 * `neededExp(128)`은 `needed_exp[127]=190000000`을 읽지만, L128 초과 선형 확장과
 * `expToLevel`의 선형 역산은 모두 `needed_exp[126]=100000000`을 피벗으로 쓴다. 이 때문에
 * round-trip `expToLevel(neededExp(L))===L+1`은 L∈[1,127]∪[129,∞)에서만 성립하고 L=128은
 * 깨진다(neededExp(128)=190M → expToLevel=146). 원본을 충실히 이식한 결과다.
 */

/** L128 초과 구간의 레벨당 선형 exp 증가폭. 원본 command7.c:592. */
const LINEAR_STEP = 5_000_000

/** 선형 확장의 피벗 인덱스(needed_exp[126]=100000000). expToLevel 역산과 공유한다. */
const LINEAR_PIVOT_INDEX = MAXALVL - 2

/**
 * 레벨 `level`을 달성(→ level+1로 승급)하는 데 필요한 누적 exp 임계를 반환한다.
 *
 * - `1 <= level <= 128`: `needed_exp[level-1]` (배열 룩업). neededExp(128)=190000000.
 * - `level > 128`: `needed_exp[126] + (level-127)*5000000` (선형 확장, index 126 피벗).
 *   neededExp(129)=110000000.
 * - `level < 1`: 방어적으로 `needed_exp[0]`(128)을 반환한다. 소비자는 항상 level>=1을
 *   전달하지만, 음수/0 인덱스가 배열 밖을 읽지 않도록 하한을 고정한다.
 *
 * 원본 command7.c:590-593.
 */
export function neededExp(level: number): number {
  if (level < 1) return needed_exp[0]!
  if (level <= MAXALVL) return needed_exp[level - 1]!
  return needed_exp[LINEAR_PIVOT_INDEX]! + (level - (MAXALVL - 1)) * LINEAR_STEP
}

/**
 * 누적 exp `exp`에 해당하는 레벨을 반환한다(`neededExp`의 역함수).
 *
 * `neededExp(L)`은 L→L+1 승급 임계이므로, 그 exp를 정확히 채우면 L+1로 해석된다
 * (예: expToLevel(128)===2). 임계를 `>=`로 스캔하며 최대 index 126까지 넘어 배열 상한
 * (레벨 128)에 도달하면 index 126 피벗 기준 선형 역산으로 전환한다.
 *
 * - `expToLevel(0)===1`, `expToLevel(127)===1`, `expToLevel(128)===2`, `expToLevel(256)===3`.
 * - 결과는 `max(1, ...)`로 하한 1을 방어한다(음수 exp → 1).
 *
 * 원본 misc.c:472-481 (exp_to_lev).
 */
export function expToLevel(exp: number): number {
  let level = 1
  while (level < MAXALVL && exp >= needed_exp[level - 1]!) {
    level += 1
  }
  if (level >= MAXALVL) {
    level = Math.trunc((exp - needed_exp[LINEAR_PIVOT_INDEX]!) / LINEAR_STEP) + MAXALVL
  }
  return Math.max(1, level)
}
