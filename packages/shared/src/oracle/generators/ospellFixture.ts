import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * ospell 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `global.c:637-659`의 osp_t 20행을 **독립 리터럴**로 전사해(전사 pass 2) 각 행을
 * spellNo 조회 케이스로 감싼다. SUT `ospellOf`는 `magic/catalog.ts`의 realm×tier 격자
 * 전개(전사 pass 1)를 읽으므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일에서 catalog.ts를 import하지 않고 오라클 블록에서 직접 옮긴 리터럴이다 —
 * catalog 값을 여기로 복사하면 anti-tautology가 무너지므로 global.c 원본에서만 전사한다.
 * realm 코드: EARTH=1 WIND=2 FIRE=3 WATER=4 (mtype.h:142-145).
 *
 * ## 재생성 (수동 트리거)
 * `.js` 확장자 ESM re-export를 소비하므로 plain `node -e`는 `.js`→`.ts` 해석에 실패한다.
 * TS 로더(tsx)로 실행한다:
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/ospellFixture.ts'; writeFixtureFile('./src/oracle/fixtures/ospell.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** ospell 행 형태 — struct osp_t(global.c:637-659)를 그대로 옮긴 값 객체. */
interface OspellRow {
  readonly spellNo: number
  readonly realm: number
  readonly mp: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly bonusType: number
}

// 독립 전사(pass 2) — global.c:637-659 ospell[] 20행. { splno, realm, mp, ndice, sdice, pdice, bonus_type }.
const OSPELL_ORACLE: readonly OspellRow[] = [
  { spellNo: 1, realm: 2, mp: 3, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 }, // SHURTS WIND  삭풍
  { spellNo: 26, realm: 1, mp: 3, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 }, // SRUMBL EARTH 지동술
  { spellNo: 27, realm: 3, mp: 3, ndice: 1, sdice: 7, pdice: 1, bonusType: 1 }, // SBURNS FIRE  화선도(예외)
  { spellNo: 28, realm: 4, mp: 3, ndice: 1, sdice: 8, pdice: 0, bonusType: 1 }, // SBLIST WATER 탄수공
  { spellNo: 29, realm: 2, mp: 7, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 }, // SDUSTG WIND  풍마현
  { spellNo: 31, realm: 1, mp: 7, ndice: 2, sdice: 5, pdice: 7, bonusType: 2 }, // SCRUSH EARTH 폭진
  { spellNo: 6, realm: 3, mp: 7, ndice: 2, sdice: 5, pdice: 8, bonusType: 2 }, // SFIREB FIRE  화궁(예외)
  { spellNo: 30, realm: 4, mp: 7, ndice: 2, sdice: 5, pdice: 8, bonusType: 2 }, // SWBOLT WATER 파초식(예외)
  { spellNo: 25, realm: 2, mp: 10, ndice: 2, sdice: 5, pdice: 13, bonusType: 2 }, // SSHOCK WIND  권풍술
  { spellNo: 32, realm: 1, mp: 10, ndice: 2, sdice: 5, pdice: 13, bonusType: 2 }, // SENGUL EARTH 낙석
  { spellNo: 33, realm: 3, mp: 10, ndice: 2, sdice: 5, pdice: 13, bonusType: 2 }, // SBURST FIRE  화풍술
  { spellNo: 34, realm: 4, mp: 10, ndice: 2, sdice: 5, pdice: 13, bonusType: 2 }, // SSTEAM WATER 화룡대천
  { spellNo: 13, realm: 2, mp: 15, ndice: 3, sdice: 4, pdice: 18, bonusType: 3 }, // SLGHTN WIND  뇌전
  { spellNo: 35, realm: 1, mp: 15, ndice: 3, sdice: 4, pdice: 19, bonusType: 3 }, // SSHATT EARTH 토합술(예외)
  { spellNo: 36, realm: 3, mp: 15, ndice: 3, sdice: 4, pdice: 18, bonusType: 3 }, // SIMMOL FIRE  주작현
  { spellNo: 37, realm: 4, mp: 15, ndice: 3, sdice: 4, pdice: 18, bonusType: 3 }, // SBLOOD WATER 열사천
  { spellNo: 38, realm: 2, mp: 25, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 }, // STHUND WIND  파천풍
  { spellNo: 39, realm: 1, mp: 25, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 }, // SEQUAK EARTH 지옥패
  { spellNo: 40, realm: 3, mp: 25, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 }, // SFLFIL FIRE  태양안
  { spellNo: 14, realm: 4, mp: 25, ndice: 4, sdice: 5, pdice: 30, bonusType: 3 }, // SICEBL WATER 동설주
]

/** 20 ospell 행을 spellNo 조회 케이스로 전개한다. expected는 OSPELL_ORACLE 리터럴이다. */
export function buildCases(): GoldenFixture<number, OspellRow>['cases'] {
  return OSPELL_ORACLE.map((row) => ({ input: row.spellNo, expected: row }))
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<number, OspellRow> {
  return makeManualFixture('ospell', 'global.c:637-659 (A6 §2)', buildCases(), clock)
}
