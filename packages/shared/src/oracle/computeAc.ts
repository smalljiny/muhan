import { bonus } from '../stats/tables.js'
import type { ComputeAcInput } from './generators/computeAcFixture.js'

/**
 * compute_ac(방어도) SUT — 골든 fixture 하네스의 self-test 대상 함수다.
 *
 * 이 `computeAc`는 골든 fixture 하네스 self-test용 SUT이며, E6 전투 엔진으로의
 * 편입 여부는 E6의 결정이다. 여기서는 fixture 러너(approve)가 실제 차이를 잡아내는지
 * 시연하기 위한 참조 대상일 뿐, 전투 엔진의 정식 API가 아니다.
 *
 * ## referenceComputeAc와의 독립 표현
 * 원본 `player.c:971` 정공식은 동일하지만, 표현은 생성기의 `referenceComputeAc`
 * (steps 배열 + for-루프 누적)와 의도적으로 분리한다. 여기서는 명시적 clamp 헬퍼 +
 * 직접 산술식 체이닝으로 작성해 우연한 문장 일치(tautology)를 피한다. bonus 테이블은
 * 원본 상수이므로 재정의하지 않고 단일 물리 출처 `stats/tables.ts`의 `bonus`를 import해 재사용한다.
 */

/** 값을 [lo, hi] 범위로 clamp하는 명시적 헬퍼. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

/**
 * 방어도 계산: `ac = 100 - 5*bonus[MIN(dex,63)] - equipArmor - (protection ? 10 : 0)`,
 * 최종적으로 [-127, 127]로 clamp한다.
 */
export function computeAc(input: ComputeAcInput): number {
  // MIN(dex,63) + 인덱스 하한 방어([0,63] 보장). bonus[dexIndex]는 항상 정의되지만
  // noUncheckedIndexedAccess 하에서 타입은 number|undefined이므로 `?? 0`으로 좁힌다.
  const dexIndex = Math.max(0, Math.min(input.dexterity, 63))
  const dexBonus = bonus[dexIndex] ?? 0

  const protectionPenalty = input.protection ? 10 : 0
  const raw = 100 - 5 * dexBonus - input.equipArmor - protectionPenalty

  return clamp(raw, -127, 127)
}
