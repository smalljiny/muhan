import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * class_stats 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `global.c:37`의 클래스 성장 스탯 13×7 테이블을 **독립 리터럴**로 전사해(전사 pass 2)
 * 각 셀을 조회 케이스로 감싼다. SUT `classStatOf`는 `stats/tables.ts`(전사 pass 1)를 읽으므로,
 * approve가 두 전사의 불일치(오타)를 셀 단위로 잡아낸다(anti-tautology).
 *
 * expected는 이 파일에서 tables.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/classStatsFixture.ts'; writeFixtureFile('./src/oracle/fixtures/class_stats.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** class_stats 조회 입력 — 행 인덱스 + named 필드. */
export type ClassStatsInput = {
  classIndex: number
  field: 'hpstart' | 'mpstart' | 'hp' | 'mp' | 'ndice' | 'sdice' | 'pdice'
}

// 필드 순서 — C 구조체 `{hpstart, mpstart, hp, mp, ndice, sdice, pdice}`.
const FIELD_ORDER: ClassStatsInput['field'][] = [
  'hpstart',
  'mpstart',
  'hp',
  'mp',
  'ndice',
  'sdice',
  'pdice',
]

// 독립 전사(pass 2) — global.c:37. 행=클래스 인덱스, 열=FIELD_ORDER 순서.
// tables.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다.
const CLASS_STATS_ORACLE: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1, 1, 1], // [0] placeholder
  [55, 40, 5, 2, 1, 6, 0], // [1] assassin
  [57, 40, 7, 1, 2, 3, 1], // [2] barbarian
  [54, 50, 4, 3, 1, 4, 0], // [3] cleric
  [56, 50, 6, 1, 1, 5, 0], // [4] fighter
  [54, 50, 4, 3, 1, 3, 0], // [5] mage
  [55, 50, 5, 2, 1, 4, 0], // [6] paladin
  [56, 40, 6, 2, 2, 2, 0], // [7] ranger
  [55, 50, 5, 2, 2, 2, 1], // [8] thief
  [400, 250, 4, 4, 2, 4, 0], // [9] invincible
  [50, 50, 5, 5, 5, 5, 5], // [10] caretaker
  [50, 50, 5, 5, 5, 5, 5], // [11] sub_dm
  [50, 50, 7, 4, 5, 5, 5], // [12] DM
]

/**
 * 13행 × 7필드 = 91개 셀을 조회 케이스로 전개한다. expected는 CLASS_STATS_ORACLE 리터럴이다.
 */
export function buildCases(): GoldenFixture<ClassStatsInput, number>['cases'] {
  const cases: GoldenFixture<ClassStatsInput, number>['cases'] = []
  CLASS_STATS_ORACLE.forEach((row, classIndex) => {
    FIELD_ORDER.forEach((field, col) => {
      const expected = row[col]
      if (expected === undefined) {
        throw new Error(`class_stats oracle 손상: [${classIndex}][${col}]`)
      }
      cases.push({ input: { classIndex, field }, expected })
    })
  })
  return cases
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<ClassStatsInput, number> {
  return makeManualFixture('class_stats', 'global.c:37 (A7 §2)', buildCases(), clock)
}
