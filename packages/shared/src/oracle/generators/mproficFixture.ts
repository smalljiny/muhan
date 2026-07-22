import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * mprofic 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `player.c:1204-1261`의 클래스별 prof_array[12] 임계 테이블 + 십분위 보간을 **독립 리터럴**로
 * 전사해(전사 pass 2) {class, realm[], index} 조회 케이스로 감싼다. SUT `mprofic`(server/magic)은
 * mprofic.ts의 구현(전사 pass 1)을 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * expected는 이 파일의 `oracleMprofic`(player.c 독립 전사)에서 계산한다 — server mprofic.ts를 import하지
 * 않는다. import하면 SUT와 fixture가 같은 코드가 되어 anti-tautology가 무너진다. 클래스 인덱스도 server
 * 상수를 참조하지 않고 mtype.h 리터럴로 직접 쓴다(MAGE=5·CLERIC=3·PALADIN=6·RANGER=7·INVINCIBLE=9…).
 *
 * `oracleMprofic`은 offensiveSpellFixture가 bns 기대값 계산에 재사용한다(shared 내 단일 pass-2 전사).
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/mprofic.test.ts`) — shared는 server를
 * import 못 하므로, 이 파일은 fixture만 생성하고 approve는 server 테스트가 디스크 json을 읽어 실행한다.
 *
 * ## 재생성 (수동 트리거)
 * `.js` 확장자 ESM re-export를 소비하므로 plain `node -e`는 `.js`→`.ts` 해석에 실패한다. TS 로더(tsx)로 실행한다:
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/mproficFixture.ts'; writeFixtureFile('./src/oracle/fixtures/mprofic.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** mprofic 입력 — 클래스·realm 원시경험치 배열(길이 4)·realm 번호 index(1-4). */
export interface MproficInput {
  readonly class: number
  readonly realm: readonly number[]
  readonly index: number
}

// 독립 전사(pass 2) — player.c:1215-1258 클래스별 prof_array[12] 테이블. 클래스 리터럴은 mtype.h #define.
const PROF_MAGE = [0, 1024, 2048, 4096, 8192, 16384, 35768, 85536, 140000, 459410, 2073306, 500000000]
const PROF_CLERIC = [0, 1024, 4092, 8192, 16384, 32768, 70536, 119000, 226410, 709410, 2973307, 500000000]
const PROF_PALADIN = [0, 1024, 8192, 16384, 32768, 65536, 105000, 165410, 287306, 809410, 3538232, 500000000]
const PROF_DEFAULT = [0, 1024, 40000, 80000, 120000, 160000, 205000, 222000, 380000, 965410, 5495000, 500000000]

/** 클래스 → prof_array 선택(player.c:1211-1259 switch). MAGE(5)/INVINCIBLE(9)/CARETAKER(10)/SUB_DM(11)/DM(12) 계열. */
function oracleProfArray(cls: number): readonly number[] {
  if (cls === 5 || cls === 9 || cls === 10 || cls === 11 || cls === 12) return PROF_MAGE
  if (cls === 3) return PROF_CLERIC // CLERIC
  if (cls === 6 || cls === 7) return PROF_PALADIN // PALADIN/RANGER
  return PROF_DEFAULT
}

/**
 * 독립 전사 mprofic — player.c:1204-1261. n=realm[index-1], 엄격 <로 십분위 구간, trunc 보간.
 * OOB(n>=5억)는 port 결정으로 110 clamp(server mprofic.ts와 동일 정의된 동작).
 */
export function oracleMprofic(cls: number, realm: readonly number[], index: number): number {
  const profTable = oracleProfArray(cls)
  const n = realm[index - 1] ?? 0
  for (let i = 0; i < 11; i += 1) {
    const hi = profTable[i + 1]
    if (hi !== undefined && n < hi) {
      const lo = profTable[i] ?? 0
      return 10 * i + Math.trunc(((n - lo) * 10) / (hi - lo))
    }
  }
  return 110
}

/** input을 oracleMprofic로 감싼 케이스로 만든다(expected는 독립 전사 계산값). */
function makeCase(input: MproficInput, note?: string): GoldenFixture<MproficInput, number>['cases'][number] {
  const base = { input, expected: oracleMprofic(input.class, input.realm, input.index) }
  return note ? { ...base, note } : base
}

/**
 * 케이스를 조립한다:
 *   - realm=0 → 0 (전 몬스터 realm=0, 라이브 정본).
 *   - 엄격 < 경계(realm=1024 → 10, realm=1023 → 9대역): 경계 정확성.
 *   - 클래스별 테이블 분기(MAGE·CLERIC·PALADIN·default) 중간대역 보간.
 *   - trunc 분수항(MAGE 5000 → 32).
 *   - index 슬롯 선택(index 2/4).
 *   - OOB clamp(realm>=5억 → 110).
 */
export function buildCases(): GoldenFixture<MproficInput, number>['cases'] {
  return [
    makeCase({ class: 5, realm: [0, 0, 0, 0], index: 1 }, 'realm=0 → prof=0(MAGE)'),
    makeCase({ class: 3, realm: [0, 0, 0, 0], index: 2 }, 'realm=0 → prof=0(CLERIC)'),
    makeCase({ class: 4, realm: [0, 0, 0, 0], index: 3 }, 'realm=0 → prof=0(default/FIGHTER)'),
    makeCase({ class: 5, realm: [1024, 0, 0, 0], index: 1 }, '엄격 < 경계: n==1024 → i=1, prof=10'),
    makeCase({ class: 5, realm: [1023, 0, 0, 0], index: 1 }, '경계 직하: n=1023 → i=0, prof=9대역'),
    makeCase({ class: 5, realm: [3072, 0, 0, 0], index: 1 }, 'MAGE 보간: 3072 → 25'),
    makeCase({ class: 5, realm: [5000, 0, 0, 0], index: 1 }, 'MAGE trunc 분수항: 5000 → 32'),
    makeCase({ class: 3, realm: [4092, 0, 0, 0], index: 1 }, 'CLERIC 테이블: 4092 → 20'),
    makeCase({ class: 6, realm: [8192, 0, 0, 0], index: 1 }, 'PALADIN 테이블: 8192 → 20'),
    makeCase({ class: 7, realm: [8192, 0, 0, 0], index: 1 }, 'RANGER 테이블: 8192 → 20'),
    makeCase({ class: 4, realm: [40000, 0, 0, 0], index: 1 }, 'default 테이블: 40000 → 20'),
    makeCase({ class: 5, realm: [0, 3072, 0, 0], index: 2 }, 'index=2 → realm[1] 선택'),
    makeCase({ class: 5, realm: [0, 0, 0, 3072], index: 4 }, 'index=4 → realm[3] 선택'),
    makeCase({ class: 5, realm: [500000000, 0, 0, 0], index: 1 }, 'OOB clamp: n>=5억 → 110'),
  ]
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<MproficInput, number> {
  return makeManualFixture('mprofic', 'player.c:1204-1261 (A6 §2)', buildCases(), clock)
}
