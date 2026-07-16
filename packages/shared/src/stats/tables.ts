/**
 * stats/tables — 무한 전투·경제·레벨링의 정적 룩업 테이블 단일 물리 출처.
 *
 * 원본 C 전역 상수(`global.c`·`player.c`)를 32비트 oracle에서 전사한 4종 테이블과,
 * clamp 내장 접근자를 제공한다. 순수 데이터 모듈이며 런타임 I/O import(`node:fs` 등)를
 * 절대 포함하지 않는다 — 서버·클라이언트 어느 쪽에서도 안전하게 import된다.
 *
 * ## oracle 출처
 * - `bonus[64]`   — `player.c` 전역 (능력치→보너스). compute_ac 등이 재사용.
 * - `class_stats` — `global.c:37` (클래스별 HP/MP 성장·타격 주사위).
 * - `thaco_list`  — `global.c:105` (클래스×레벨 THAC0).
 * - `mod_profic`  — `player.c:1032` (클래스→숙련도 나눗수).
 */

// ---------------------------------------------------------------------------
// 능력치 5-tuple 고정 순서 (mstruct.h:177-181, A7 §1)
// ---------------------------------------------------------------------------

/**
 * 능력치 인덱스 상수 — creature 구조체의 stat 배열 고정 순서.
 * strength=0, dexterity=1, constitution=2, intelligence=3, piety=4.
 */
export const StatIndex = {
  strength: 0,
  dexterity: 1,
  constitution: 2,
  intelligence: 3,
  piety: 4,
} as const

/** 능력치 키 리터럴 유니온 — StatIndex의 키. */
export type StatKey = keyof typeof StatIndex

// ---------------------------------------------------------------------------
// bonus[64] — 능력치→보너스 (player.c 전역)
// ---------------------------------------------------------------------------

/**
 * 능력치 보너스 테이블 `bonus[64]`. 정확히 64개 원소.
 * compute_ac 등 여러 공식이 이 단일 물리 출처를 재사용한다.
 */
export const bonus: readonly number[] = [
  -4, -4, -4, -3, -3, -2, -2, -1, // 0-7
  -1, -1, 0, 0, 0, 0, 1, 1, // 8-15
  1, 2, 2, 2, 3, 3, 3, 3, // 16-23
  4, 4, 4, 4, 4, 5, 5, 5, // 24-31
  5, 5, 5, 6, 6, 6, 6, 6, // 32-39
  6, 6, 6, 6, 7, 7, 7, 7, // 40-47
  7, 7, 7, 7, 7, 7, 7, 7, // 48-55
  7, 7, 7, 7, 7, 7, 7, 7, // 56-63
]

/**
 * 능력치 점수의 보너스를 반환한다. 인덱스를 `[0, 63]`으로 clamp한 뒤 `bonus[i]`를 조회한다.
 * clamp가 인덱스를 항상 유효 범위로 만들므로 `?? 0`은 도달 불가한 타입 안전망이다.
 */
export function bonusOf(abilityScore: number): number {
  const index = Math.max(0, Math.min(abilityScore, 63))
  return bonus[index] ?? 0
}

// ---------------------------------------------------------------------------
// class_stats[13] — 클래스별 성장 스탯 (global.c:37)
// ---------------------------------------------------------------------------

/**
 * 클래스 성장 스탯 한 행. 필드 순서는 C 구조체 `{hpstart, mpstart, hp, mp, ndice, sdice, pdice}`.
 * - hpstart/mpstart: 1레벨 기본 HP/MP.
 * - hp/mp: 레벨당 성장 계수(폐형 `start + trunc(coef*(level-1)/2)`).
 * - ndice/sdice/pdice: 클래스 타격 주사위(개수/면수/추가).
 */
export type ClassStats = {
  hpstart: number
  mpstart: number
  hp: number
  mp: number
  ndice: number
  sdice: number
  pdice: number
}

/** 배열 튜플을 named 필드 객체로 감싸는 내부 헬퍼(전사 정합성 유지용). */
function makeClassStats(
  hpstart: number,
  mpstart: number,
  hp: number,
  mp: number,
  ndice: number,
  sdice: number,
  pdice: number,
): ClassStats {
  return { hpstart, mpstart, hp, mp, ndice, sdice, pdice }
}

/**
 * `class_stats[13]` — global.c:37. 인덱스 0은 placeholder(제작).
 * 1=assassin 2=barbarian 3=cleric 4=fighter 5=mage 6=paladin 7=ranger 8=thief
 * 9=invincible 10=caretaker 11=sub_dm 12=DM.
 */
export const class_stats: readonly ClassStats[] = [
  makeClassStats(1, 1, 1, 1, 1, 1, 1), // [0] placeholder
  makeClassStats(55, 40, 5, 2, 1, 6, 0), // [1] assassin
  makeClassStats(57, 40, 7, 1, 2, 3, 1), // [2] barbarian
  makeClassStats(54, 50, 4, 3, 1, 4, 0), // [3] cleric
  makeClassStats(56, 50, 6, 1, 1, 5, 0), // [4] fighter
  makeClassStats(54, 50, 4, 3, 1, 3, 0), // [5] mage
  makeClassStats(55, 50, 5, 2, 1, 4, 0), // [6] paladin
  makeClassStats(56, 40, 6, 2, 2, 2, 0), // [7] ranger
  makeClassStats(55, 50, 5, 2, 2, 2, 1), // [8] thief
  makeClassStats(400, 250, 4, 4, 2, 4, 0), // [9] invincible
  makeClassStats(50, 50, 5, 5, 5, 5, 5), // [10] caretaker
  makeClassStats(50, 50, 5, 5, 5, 5, 5), // [11] sub_dm
  makeClassStats(50, 50, 7, 4, 5, 5, 5), // [12] DM
]

/**
 * `class_stats[classIndex][field]` 셀을 named 필드로 조회한다.
 * 범위 밖 classIndex는 RangeError로 거부한다(무효 입력을 조용히 삼키지 않는다).
 */
export function classStatOf(input: { classIndex: number; field: keyof ClassStats }): number {
  const row = class_stats[input.classIndex]
  if (row === undefined) {
    throw new RangeError(`class_stats: 잘못된 classIndex ${input.classIndex}`)
  }
  return row[input.field]
}

// ---------------------------------------------------------------------------
// thaco_list[13][20] — 클래스×레벨 THAC0 (global.c:105)
// ---------------------------------------------------------------------------

/**
 * `thaco_list[13][20]` — global.c:105. 행=클래스 인덱스, 열=레벨 인덱스(0-19).
 * 인덱스 0 행은 placeholder(전부 20).
 */
export const thaco_list: readonly (readonly number[])[] = [
  [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20], // [0] placeholder
  [18, 18, 18, 17, 17, 16, 16, 15, 15, 14, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9], // [1] assassin
  [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 3, 2], // [2] barbarian
  [20, 20, 19, 18, 18, 17, 16, 16, 15, 14, 14, 13, 13, 12, 12, 11, 10, 10, 9, 8], // [3] cleric
  [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 3, 3], // [4] fighter
  [20, 20, 19, 19, 18, 18, 18, 17, 17, 16, 16, 16, 15, 15, 14, 14, 14, 13, 13, 11], // [5] mage
  [19, 19, 18, 18, 17, 16, 16, 15, 15, 14, 14, 13, 13, 12, 11, 11, 10, 9, 8, 7], // [6] paladin
  [19, 19, 18, 17, 16, 16, 15, 15, 14, 14, 13, 12, 12, 11, 11, 10, 9, 9, 8, 7], // [7] ranger
  [20, 20, 19, 19, 18, 18, 17, 17, 16, 16, 15, 15, 14, 14, 13, 13, 12, 12, 11, 11], // [8] thief
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // [9] invincible
  [-5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5], // [10] caretaker
  [-5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5], // [11] sub_dm
  [-5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5], // [12] DM
]

/**
 * `thaco_list[classIndex][levelIndex]` 셀을 조회한다. levelIndex는 0-based(0-19).
 * 범위 밖 인덱스는 RangeError로 거부한다.
 */
export function thacoOf(input: { classIndex: number; levelIndex: number }): number {
  const row = thaco_list[input.classIndex]
  if (row === undefined) {
    throw new RangeError(`thaco_list: 잘못된 classIndex ${input.classIndex}`)
  }
  const value = row[input.levelIndex]
  if (value === undefined) {
    throw new RangeError(`thaco_list: 잘못된 levelIndex ${input.levelIndex}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// mod_profic — 클래스→숙련도 나눗수 (player.c:1032)
// ---------------------------------------------------------------------------

/**
 * `mod_profic[13]` — 클래스 인덱스→숙련도 나눗수. 원본 `player.c:1032`의 switch를
 * 인덱스 0-12로 전사한다. 나눗수가 클수록 숙련 상승이 느리다.
 * FIGHTER/BARBARIAN/INVINCIBLE/CARETAKER=20, RANGER/PALADIN=25,
 * THIEF/ASSASSIN/CLERIC=30, 그 외(MAGE 및 placeholder/sub_dm/DM)=40(default).
 */
export const mod_profic: readonly number[] = [
  40, // [0] placeholder (default)
  30, // [1] assassin
  20, // [2] barbarian
  30, // [3] cleric
  20, // [4] fighter
  40, // [5] mage (default)
  25, // [6] paladin
  25, // [7] ranger
  30, // [8] thief
  20, // [9] invincible
  20, // [10] caretaker
  40, // [11] sub_dm (default)
  40, // [12] DM (default)
]

/**
 * 클래스 인덱스의 숙련도 나눗수를 반환한다. 범위 밖 인덱스는 원본 switch의 default(40)를 반환한다.
 */
export function proficDivisorOf(classIndex: number): number {
  return mod_profic[classIndex] ?? 40
}
