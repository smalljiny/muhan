/**
 * stats/effectiveStat — base 능력치 + 모디파이어를 유효 능력치로 합성하는 순수 가산 계층.
 *
 * 합성은 clamp를 넣지 않는다(Open Q #4). `[3, 18]` 같은 상한은 상위 계층 책임이며,
 * 이 계층은 버프가 유효값을 18 초과로 밀 수 있어야 한다. 순수 함수·불변 입력만 다룬다.
 */

import type { StatKey } from './tables.js'

/**
 * 능력치 모디파이어 한 건. `stat` 필드는 소비자가 stat별로 modifier를 선별할 때 쓰는
 * 메타데이터다 — effectiveStat 자체는 stat-agnostic이라 이 필드를 읽지 않는다.
 * - source: 모디파이어 출처 식별자(장비·버프·저주 등).
 * - stat: 이 모디파이어가 겨냥하는 능력치 키.
 * - delta: 유효값에 더할 증감량(음수 가능).
 */
export type StatModifier = {
  source: string
  stat: StatKey
  delta: number
}

/**
 * base 능력치에 모디파이어 delta 합을 더한 유효 능력치를 반환한다.
 * `base + Σ modifiers.delta` 순수 가산이며 clamp는 없다. 빈 배열이면 base를 그대로 반환한다.
 */
export function effectiveStat(base: number, modifiers: readonly StatModifier[]): number {
  return modifiers.reduce((sum, modifier) => sum + modifier.delta, base)
}
