import type { CombatRng } from '../combat/dice.js'
import {
  ASSASSIN,
  BARBARIAN,
  CLERIC,
  FIGHTER,
  MAGE,
  PALADIN,
  RANGER,
  THIEF,
} from '../combat/constants.js'

/**
 * spell_fail — 클래스별 시전 성공/실패 굴림(magic8.c:791-897 byte 정본).
 *
 * ## 굴림 vs 호출 조건의 분리(A6 §3)
 * 두 개념을 별도 함수로 나눈다:
 *   - spellFail/spellFailChance = chance 테이블. 8클래스(MAGE·CLERIC **포함**)의 chance 공식을 보유하고
 *     굴림한다. 이 테이블은 fixture로 고정된다.
 *   - rollsSpellFail = 호출 조건 predicate. 실제로 이 굴림을 호출하는 건 전사계 6클래스뿐이다 —
 *     정규 캐스터(MAGE·CLERIC)의 주문 fn은 spell_fail을 굴리지 않는다. chance 테이블에 MAGE·CLERIC이
 *     있는 것과 호출 여부는 별개다.
 * #84 offensive 데미지 경로(S5)는 spell_fail을 굴리지 않으므로(A6 §4 단계에 없음) 여기 함수는 독립
 * 유닛으로 두고 데미지 파이프에 배선하지 않는다.
 */

/**
 * 클래스별 `chance = base*mult + add` 계수 테이블(magic8.c switch의 데이터화). base = L4 + bonus[int].
 * 값 변화는 (배수, 가산항)뿐이라 테이블이 자연스럽다 — MAGE/CLERIC/BARBARIAN 등 6클래스는 배수 5,
 * RANGER만 4, THIEF만 6. 미등록 클래스는 magic8.c `default: return 0`(무조건 성공). 골든 fixture의
 * oracleChance는 이와 독립하게 리터럴 switch로 전사하므로(구조가 다름) anti-tautology 교차검증이 강화된다.
 */
const CHANCE_COEFFS: ReadonlyMap<number, readonly [mult: number, add: number]> = new Map([
  [ASSASSIN, [5, 30]],
  [BARBARIAN, [5, 0]],
  [CLERIC, [5, 65]],
  [FIGHTER, [5, 10]],
  [MAGE, [5, 75]],
  [PALADIN, [5, 50]],
  [RANGER, [4, 56]], // 유일한 *4 배수
  [THIEF, [6, 22]], // 유일한 *6 배수
])

/**
 * 클래스별 chance를 계산한다. base = L4 + bonus[intelligence].
 *   L4 = (level+3)/4 (C 정수 나눗셈 = Math.trunc), bonus[intelligence] = intBonus(사전 계산).
 *
 * 반환 null은 magic8.c의 `default: return 0` — 굴림 없이 무조건 성공하는 클래스(비전사)를 뜻한다.
 * chance=0(모든 n에서 실패)과 구분하려 sentinel로 null을 쓴다.
 *
 * chance에 **cap 없음** — 고레벨·고지능은 chance>100이 되어 어떤 n(1~100)에서도 실패하지 않는다.
 */
export function spellFailChance(cls: number, level: number, intBonus: number): number | null {
  const coeffs = CHANCE_COEFFS.get(cls)
  if (coeffs === undefined) return null // magic8.c default: return 0(BARD·MONK 등 주석 처리 포함).
  const base = Math.trunc((level + 3) / 4) + intBonus // L4 + bonus[intelligence]
  return base * coeffs[0] + coeffs[1]
}

/**
 * spell_fail 굴림 — true=실패, false=성공. `n = rng(1,100)`을 굴려 `n > chance`면 실패한다.
 *
 * default 클래스(chance=null)는 굴림 자체를 하지 않고 무조건 성공(false)한다 — magic8.c가 default에서
 * 굴림 전에 return 0 하는 것을 그대로 옮긴다.
 */
export function spellFail(cls: number, level: number, intBonus: number, rng: CombatRng): boolean {
  const chance = spellFailChance(cls, level, intBonus)
  if (chance === null) return false // 무조건 성공(굴림 없음).
  const n = rng(1, 100)
  return n > chance // cap 없음 — chance>100이면 n<=100이라 항상 성공.
}

/** 전사계 6클래스 — spell_fail 굴림을 실제로 호출하는 클래스(MAGE·CLERIC 제외). */
const WARRIOR_CLASSES: ReadonlySet<number> = new Set([
  FIGHTER,
  BARBARIAN,
  RANGER,
  PALADIN,
  ASSASSIN,
  THIEF,
])

/**
 * 호출 조건 predicate(A6 §3) — 이 클래스가 spell_fail을 굴리는가?
 *
 * 전사계 6클래스만 true다. 정규 캐스터(MAGE·CLERIC)는 chance 테이블엔 있어도 개별 주문 fn이
 * spell_fail을 호출하지 않으므로 false다. 굴림 함수(spellFail)와 호출 여부(이 predicate)는 별개다.
 */
export function rollsSpellFail(cls: number): boolean {
  return WARRIOR_CLASSES.has(cls)
}
