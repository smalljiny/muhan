/**
 * stats 배럴 — 전투·경제·레벨링 정적 룩업 테이블 + 유효 능력치 합성 + 파생 스탯 resolver의
 * 단일 출처.
 *
 * 4개 물리 모듈(tables·effectiveStat·context·derived)을 이 배럴 하나로 재노출한다.
 * 값 export와 타입 export를 분리해 isolatedModules를 준수한다.
 */

// tables — 능력치 인덱스·보너스·클래스 성장·THAC0·숙련도 정적 테이블 + clamp 내장 접근자.
export {
  bonus,
  bonusOf,
  StatIndex,
  class_stats,
  classStatOf,
  thaco_list,
  thacoOf,
  mod_profic,
  proficDivisorOf,
} from './tables.js'
export type { StatKey, ClassStats } from './tables.js'

// effectiveStat — base 능력치 + 모디파이어를 유효 능력치로 합성하는 순수 가산 계층.
export { effectiveStat } from './effectiveStat.js'
export type { StatModifier } from './effectiveStat.js'

// context — 파생 스탯 resolver 5종의 공통 입력 타입.
export type { EffectiveStatContext } from './context.js'

// derived — EffectiveStatContext를 입력으로 받는 파생 스탯 resolver 5종.
export { computeAc, computeThaco, maxWeight, computeHpMax, computeMpMax } from './derived.js'
