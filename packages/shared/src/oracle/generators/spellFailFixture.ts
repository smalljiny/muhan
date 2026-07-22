import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * spell_fail 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `magic8.c:791-897`의 클래스별 chance switch를 **독립 리터럴**로 전사해(전사 pass 2) 결정적
 * 굴림 n과 함께 성공/실패(boolean) 케이스로 감싼다. SUT `spellFail`(server/magic)은 spellFail.ts의
 * 구현(전사 pass 1)을 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일의 oracleFail(magic8.c 독립 전사)에서 계산한다 — spellFail.ts를 import하지 않는다.
 * import하면 SUT와 fixture가 같은 코드가 되어 anti-tautology가 무너진다. 클래스 인덱스도 server
 * 상수를 참조하지 않고 magic8.c 리터럴(1-8)로 직접 쓴다.
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/spellFail.test.ts`) — shared는 server를
 * import 못 하므로, 이 파일은 fixture만 생성하고 approve는 server 테스트가 디스크 json을 읽어 실행한다.
 *
 * ## 재생성 (수동 트리거)
 * `.js` 확장자 ESM re-export를 소비하므로 plain `node -e`는 `.js`→`.ts` 해석에 실패한다. TS 로더(tsx)로 실행한다:
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/spellFailFixture.ts'; writeFixtureFile('./src/oracle/fixtures/spell_fail.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** spell_fail 굴림 입력 — 클래스·레벨·지능 보너스·결정적 굴림값 n. */
interface SpellFailInput {
  readonly class: number
  readonly level: number
  readonly intBonus: number
  readonly n: number
}

/**
 * 독립 전사(pass 2) — magic8.c:791-897 chance switch. base = L4 + bonus[intelligence].
 *   L4 = (level+3)/4 (C 정수 나눗셈 = Math.trunc). null = default(굴림 없이 무조건 성공).
 * cap 없음 — chance>100은 그대로 둔다(무cap 앵커가 이 성질을 검증한다).
 */
function oracleChance(cls: number, level: number, intBonus: number): number | null {
  const base = Math.trunc((level + 3) / 4) + intBonus
  switch (cls) {
    case 1:
      return base * 5 + 30 // ASSASSIN
    case 2:
      return base * 5 + 0 // BARBARIAN
    case 3:
      return base * 5 + 65 // CLERIC
    case 4:
      return base * 5 + 10 // FIGHTER
    case 5:
      return base * 5 + 75 // MAGE
    case 6:
      return base * 5 + 50 // PALADIN
    case 7:
      return base * 4 + 56 // RANGER
    case 8:
      return base * 6 + 22 // THIEF
    default:
      return null // magic8.c default: return 0 (무조건 성공)
  }
}

/** 독립 전사 굴림 — n > chance면 실패(true), default(null)는 무조건 성공(false). */
function oracleFail(input: SpellFailInput): boolean {
  const chance = oracleChance(input.class, input.level, input.intBonus)
  if (chance === null) return false
  return input.n > chance
}

/** input을 oracleFail로 감싼 케이스로 만든다(expected는 독립 전사 계산값). */
function makeCase(input: SpellFailInput, note?: string): GoldenFixture<SpellFailInput, boolean>['cases'][number] {
  const base = { input, expected: oracleFail(input) }
  return note ? { ...base, note } : base
}

/**
 * 케이스를 조립한다:
 *   - 8클래스 chance 공식 lock: level5/int2(base=4)에서 각 클래스 chance 경계 2개(n=chance 성공, n=chance+1 실패).
 *   - 무cap 앵커: MAGE L100 int5(chance=225) → n 1/50/100 전부 성공.
 *   - default 앵커: class 0/9/11/12 → n=100(실패할 법한 굴림)이어도 성공.
 *   - 저레벨 전사 실패 + chance=5 경계.
 */
export function buildCases(): GoldenFixture<SpellFailInput, boolean>['cases'] {
  const cases: GoldenFixture<SpellFailInput, boolean>['cases'] = []

  // 8클래스 chance 공식 경계 lock (level5/int2 → base=4).
  for (let cls = 1; cls <= 8; cls += 1) {
    const chance = oracleChance(cls, 5, 2)
    if (chance === null) continue // 1-8은 전부 non-null이나 타입 안전을 위해 방어.
    cases.push(makeCase({ class: cls, level: 5, intBonus: 2, n: chance }, 'n==chance → 성공(경계)'))
    cases.push(makeCase({ class: cls, level: 5, intBonus: 2, n: chance + 1 }, 'n==chance+1 → 실패'))
  }

  // 무cap 앵커 — MAGE L100 int5: base=trunc(103/4)+5=30, chance=225(>100). 어떤 n도 성공.
  cases.push(makeCase({ class: 5, level: 100, intBonus: 5, n: 1 }, '무cap: chance=225, n=1 성공'))
  cases.push(makeCase({ class: 5, level: 100, intBonus: 5, n: 50 }, '무cap: chance=225, n=50 성공'))
  cases.push(makeCase({ class: 5, level: 100, intBonus: 5, n: 100 }, '무cap: chance=225, n=100 성공'))

  // default 앵커 — 굴림 없이 무조건 성공(n=100이어도).
  cases.push(makeCase({ class: 0, level: 1, intBonus: 0, n: 100 }, 'default: 무조건 성공'))
  cases.push(makeCase({ class: 9, level: 50, intBonus: 3, n: 100 }, 'default(INVINCIBLE): 무조건 성공'))
  cases.push(makeCase({ class: 11, level: 50, intBonus: 3, n: 100 }, 'default: 무조건 성공'))
  cases.push(makeCase({ class: 12, level: 50, intBonus: 3, n: 100 }, 'default(DM): 무조건 성공'))

  // 저레벨 전사 실패 + chance=5 경계(BARBARIAN L1 int0 → chance=5).
  cases.push(makeCase({ class: 2, level: 1, intBonus: 0, n: 50 }, '저레벨 전사: chance=5, n=50 실패'))
  cases.push(makeCase({ class: 2, level: 1, intBonus: 0, n: 5 }, '경계: n==chance(5) 성공'))
  cases.push(makeCase({ class: 2, level: 1, intBonus: 0, n: 6 }, '경계: n==chance+1(6) 실패'))

  return cases
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<SpellFailInput, boolean> {
  return makeManualFixture('spell_fail', 'magic8.c:791-897 (A6 §3)', buildCases(), clock)
}
