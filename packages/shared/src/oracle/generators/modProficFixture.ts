import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * mod_profic 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `player.c:1032`의 클래스→숙련도 나눗수 switch를 인덱스 0-12 **독립 리터럴**로
 * 전사해(전사 pass 2) 각 클래스를 조회 케이스로 감싼다. SUT `proficDivisorOf`는
 * `stats/tables.ts`(전사 pass 1)를 읽으므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일에서 tables.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/modProficFixture.ts'; writeFixtureFile('./src/oracle/fixtures/mod_profic.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

// 독립 전사(pass 2) — player.c:1032 switch. 인덱스=클래스, 값=나눗수.
// FIGHTER(4)/BARBARIAN(2)/INVINCIBLE(9)/CARETAKER(10)=20, RANGER(7)/PALADIN(6)=25,
// THIEF(8)/ASSASSIN(1)/CLERIC(3)=30, 그 외(MAGE(5)/0/11/12)=40(default).
const MOD_PROFIC_ORACLE: readonly number[] = [
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

/** 클래스 0-12 = 13개를 조회 케이스로 전개한다. expected는 MOD_PROFIC_ORACLE 리터럴이다. */
export function buildCases(): GoldenFixture<number, number>['cases'] {
  return MOD_PROFIC_ORACLE.map((expected, classIndex) => ({ input: classIndex, expected }))
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<number, number> {
  return makeManualFixture('mod_profic', 'player.c:1032 (A7 §2)', buildCases(), clock)
}
