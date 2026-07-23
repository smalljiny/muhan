import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * spllv 전수등급 골든 fixture 생성기 — manual oracle.
 *
 * 원본 `magic1.c:212-235`의 spllv별 전수 권한 5-if 체인을 **독립 리터럴로 전사**(전사 pass 2)해
 * {class, spllv} → boolean(전수 가능 여부) 케이스로 감싼다. SUT `canTeachSpllv`(server/magic/learning)는
 * learning.ts의 구현(전사 pass 1)을 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일의 `oracleCanTeachSpllv`(magic1.c 독립 전사)에서 계산한다 — server learning.ts를
 * import하지 않는다. import하면 SUT와 fixture가 같은 코드가 되어 anti-tautology가 무너진다. 클래스 인덱스도
 * server 상수를 참조하지 않고 mtype.h 리터럴로 직접 쓴다(CLERIC=3·MAGE=5·INVINCIBLE=9·CARETAKER=10·SUB_DM=11).
 *
 * ## 경계 주의 — spllv 테이블만 전사한다(base-class 게이트 제외)
 * magic1.c teach()는 spllv 5-if 체인 앞에 base-class 게이트(CARETAKER/MAGE/CLERIC만 통과)를 둔다. 이 fixture는
 * spllv 체인만 독립 전사하므로 INVINCIBLE(9)→spllv1→true처럼 base 게이트가 실제로 막는 조합도 true로 나온다.
 * 이는 SUT `canTeachSpllv`가 spllv 체크만 담당하는 계약과 정확히 대응한다 — base-class 게이트는 `teach()`가
 * 조합한다(server 단위 테스트가 별도 검증).
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/learning.test.ts`) — shared는 server를
 * import 못 하므로, 이 파일은 fixture만 생성하고 approve는 server 테스트가 디스크 json을 읽어 실행한다.
 *
 * ## 재생성 (수동 트리거)
 * `.js` 확장자 ESM re-export를 소비하므로 plain `node -e`는 `.js`→`.ts` 해석에 실패한다. TS 로더(tsx)로 실행한다:
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/spllvTeachFixture.ts'; writeFixtureFile('./src/oracle/fixtures/spllv_teach.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** spllv 전수 권한 입력 — 시전자 클래스·주문 전수등급(spllv). */
export interface SpllvTeachInput {
  readonly class: number
  readonly spllv: number
}

// 독립 전사(pass 2) — mtype.h #define 클래스 리터럴(server 상수 미참조).
const CLERIC = 3
const MAGE = 5
const INVINCIBLE = 9
const CARETAKER = 10
const SUB_DM = 11

/**
 * 독립 전사 canTeachSpllv — magic1.c:212-235 spllv 5-if 체인. 각 if는 조건 성립 시 전수 거부(return 0)이며,
 * 여기서는 그 부정(전수 가능)을 반환한다:
 *   spllv 1: !(class!=CLERIC && class<INVINCIBLE)  →  class==CLERIC || class>=INVINCIBLE
 *   spllv 2: !(class!=MAGE   && class<INVINCIBLE)  →  class==MAGE   || class>=INVINCIBLE
 *   spllv 3: !(class<INVINCIBLE)                   →  class>=INVINCIBLE
 *   spllv 4: !(class<CARETAKER)                    →  class>=CARETAKER
 *   spllv 5: !(class<SUB_DM)                       →  class>=SUB_DM
 * spllv가 1-5 밖이면 매칭 if가 없어 어떤 거부도 발화하지 않는다 → 전수 가능(true).
 */
export function oracleCanTeachSpllv(cls: number, spllv: number): boolean {
  if (spllv === 1) return cls === CLERIC || cls >= INVINCIBLE
  if (spllv === 2) return cls === MAGE || cls >= INVINCIBLE
  if (spllv === 3) return cls >= INVINCIBLE
  if (spllv === 4) return cls >= CARETAKER
  if (spllv === 5) return cls >= SUB_DM
  return true
}

/** input을 oracleCanTeachSpllv로 감싼 케이스로 만든다(expected는 독립 전사 계산값). */
function makeCase(
  input: SpllvTeachInput,
  note?: string,
): GoldenFixture<SpllvTeachInput, boolean>['cases'][number] {
  const base = { input, expected: oracleCanTeachSpllv(input.class, input.spllv) }
  return note ? { ...base, note } : base
}

/**
 * 케이스를 조립한다 — spllv 1-5 × 대표 클래스(CLERIC·MAGE·CARETAKER·SUB_DM·INVINCIBLE)의 권한 격자:
 *   - spllv1: CLERIC 허용, MAGE 거부, CARETAKER 허용(>=INVINCIBLE).
 *   - spllv2: MAGE 허용, CLERIC 거부, INVINCIBLE 허용.
 *   - spllv3: INVINCIBLE↑만 허용(CARETAKER 허용, CLERIC/MAGE 거부).
 *   - spllv4: CARETAKER↑만 허용(INVINCIBLE 거부).
 *   - spllv5: SUB_DM↑만 허용(CARETAKER 거부 — 전수 불가 quirk 고정).
 *   - 범위 밖 spllv(0) → true(매칭 if 없음).
 */
export function buildCases(): GoldenFixture<SpllvTeachInput, boolean>['cases'] {
  return [
    makeCase({ class: CLERIC, spllv: 1 }, 'spllv1 CLERIC → 허용'),
    makeCase({ class: MAGE, spllv: 1 }, 'spllv1 MAGE → 거부(class!=CLERIC && <INVINCIBLE)'),
    makeCase({ class: CARETAKER, spllv: 1 }, 'spllv1 CARETAKER → 허용(>=INVINCIBLE)'),
    makeCase({ class: MAGE, spllv: 2 }, 'spllv2 MAGE → 허용'),
    makeCase({ class: CLERIC, spllv: 2 }, 'spllv2 CLERIC → 거부(class!=MAGE && <INVINCIBLE)'),
    makeCase({ class: INVINCIBLE, spllv: 2 }, 'spllv2 INVINCIBLE → 허용(>=INVINCIBLE)'),
    makeCase({ class: INVINCIBLE, spllv: 3 }, 'spllv3 INVINCIBLE → 허용'),
    makeCase({ class: CARETAKER, spllv: 3 }, 'spllv3 CARETAKER → 허용(>=INVINCIBLE)'),
    makeCase({ class: MAGE, spllv: 3 }, 'spllv3 MAGE → 거부(<INVINCIBLE)'),
    makeCase({ class: CARETAKER, spllv: 4 }, 'spllv4 CARETAKER → 허용'),
    makeCase({ class: INVINCIBLE, spllv: 4 }, 'spllv4 INVINCIBLE → 거부(<CARETAKER)'),
    makeCase({ class: SUB_DM, spllv: 5 }, 'spllv5 SUB_DM → 허용'),
    makeCase({ class: CARETAKER, spllv: 5 }, 'spllv5 CARETAKER → 거부(<SUB_DM) — 전수불가 quirk'),
    makeCase({ class: CLERIC, spllv: 0 }, '범위 밖 spllv=0 → true(매칭 if 없음)'),
  ]
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<SpllvTeachInput, boolean> {
  return makeManualFixture('canTeachSpllv', 'magic1.c:212-235 (A6 §8 spllv 전수등급)', buildCases(), clock)
}
