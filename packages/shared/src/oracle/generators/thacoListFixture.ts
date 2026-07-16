import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * thaco_list 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `global.c:105`의 클래스×레벨 THAC0 13×20 테이블을 **독립 리터럴**로 전사해(전사 pass 2)
 * 각 셀을 조회 케이스로 감싼다. SUT `thacoOf`는 `stats/tables.ts`(전사 pass 1)를 읽으므로,
 * approve가 두 전사의 불일치(오타)를 셀 단위로 잡아낸다(anti-tautology).
 *
 * expected는 이 파일에서 tables.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/thacoListFixture.ts'; writeFixtureFile('./src/oracle/fixtures/thaco_list.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** thaco_list 조회 입력 — 행 인덱스 + 0-based 레벨 인덱스(0-19). */
export type ThacoInput = { classIndex: number; levelIndex: number }

// 독립 전사(pass 2) — global.c:105. 행=클래스 인덱스, 열=레벨 인덱스(0-19).
// tables.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다.
const THACO_ORACLE: readonly (readonly number[])[] = [
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
 * 13행 × 20레벨 = 260개 셀을 조회 케이스로 전개한다. expected는 THACO_ORACLE 리터럴이다.
 */
export function buildCases(): GoldenFixture<ThacoInput, number>['cases'] {
  const cases: GoldenFixture<ThacoInput, number>['cases'] = []
  THACO_ORACLE.forEach((row, classIndex) => {
    row.forEach((expected, levelIndex) => {
      cases.push({ input: { classIndex, levelIndex }, expected })
    })
  })
  return cases
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<ThacoInput, number> {
  return makeManualFixture('thaco_list', 'global.c:105 (A7 §2)', buildCases(), clock)
}
