import type { GoldenFixture } from '../types.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * realmGrowthAmount 골든 전사-diff fixture 생성기 — manual oracle.
 *
 * 원본 `magic1.c:1122-1130`의 realm 숙련 성장량 공식을 **독립 리터럴**로 전사해(전사 pass 2) {m, exp,
 * hpmax} 조회 케이스로 감싼다. SUT `realmGrowthAmount`(server/magic)은 realmGrowth.ts 구현(전사 pass 1)을
 * 소비하므로, approve가 두 전사의 불일치를 잡아낸다.
 *
 * ## combat exp 분배와 동형(Criterion 5)
 * oracleRealmGrowth의 공식 `MIN(trunc((m*exp)/MAX(1,hpmax)), exp)`는 deathDistribution 기여자 exp
 * `expdiv = trunc(exp*dmg/MAX(hpmax,1))` 캡 exp(creature.c:287)와 **동일**하다(그룹킬 `+exp/10` 항은
 * realm 성장에 대응물 없음 — base expdiv에만 동형). server 테스트가 이 fixture를 realmGrowthAmount로
 * approve하고, 나아가 단일 기여자 distributeCreatureDeath award와 동치임을 대조해 동형을 고정한다.
 *
 * PvE 가드(`crt->type != PLAYER`)·realm 슬롯 적용(realm[i]+=)은 호출자·#99 소관이라 fixture는 순수
 * 성장량 스칼라만 pin한다(오라클 delta 반환 선례 충실).
 *
 * SUT 소비 approve는 server가 소유한다(`packages/server/src/magic/realmGrowth.test.ts`) — shared는 server를
 * import 못 하므로, 이 파일은 fixture만 생성하고 approve는 server 테스트가 디스크 json을 읽어 실행한다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildFixture, writeFixtureFile } from './src/oracle/generators/addRealmFixture.ts'; writeFixtureFile('./src/oracle/fixtures/addrealm.json', buildFixture(() => new Date('2026-07-16T00:00:00.000Z')))"
 * ```
 */

/** realmGrowthAmount 시나리오 입력 — 피해 m·대상 exp·대상 hpmax. */
export interface RealmGrowthInput {
  readonly m: number
  readonly exp: number
  readonly hpmax: number
}

/**
 * 독립 전사(pass 2) — magic1.c:1122-1130.
 *   addrealm = MIN(trunc((m*exp)/MAX(1,hpmax)), exp).
 * base 공식은 creature.c:287 expdiv와 동일(combat exp 분배 동형). delta 스칼라만 반환.
 */
export function oracleRealmGrowth(input: RealmGrowthInput): number {
  return Math.min(Math.trunc((input.m * input.exp) / Math.max(1, input.hpmax)), input.exp)
}

/** input을 oracleRealmGrowth로 감싼 케이스로 만든다(expected는 독립 전사 계산값). */
function makeCase(input: RealmGrowthInput, note?: string): GoldenFixture<RealmGrowthInput, number>['cases'][number] {
  const base = { input, expected: oracleRealmGrowth(input) }
  return note ? { ...base, note } : base
}

/**
 * 케이스를 조립한다:
 *   - 기본 성장(정수 배당).
 *   - trunc 절삭(분수 배당).
 *   - exp 캡(m>hpmax 방어 케이스).
 *   - hpmax=0 → MAX(1,hpmax) 0분모 가드.
 *   - exp=0 몬스터 → 성장 0.
 *   - m==hpmax 경계.
 */
export function buildCases(): GoldenFixture<RealmGrowthInput, number>['cases'] {
  return [
    makeCase({ m: 15, exp: 100, hpmax: 30 }, 'trunc(15*100/30)=50, MIN(50,100)=50'),
    makeCase({ m: 7, exp: 10, hpmax: 30 }, 'trunc 절삭: trunc(70/30)=2'),
    makeCase({ m: 60, exp: 10, hpmax: 30 }, 'exp 캡: trunc(600/30)=20 > exp=10 → MIN=10'),
    makeCase({ m: 5, exp: 10, hpmax: 0 }, 'hpmax=0 → MAX(1,0)=1 → trunc(50/1)=50, MIN(50,10)=10'),
    makeCase({ m: 15, exp: 0, hpmax: 30 }, 'exp=0 몬스터 → 성장 0'),
    makeCase({ m: 30, exp: 40, hpmax: 30 }, 'm==hpmax 경계: trunc(1200/30)=40'),
  ]
}

/** 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 결정적 스탬프. */
export function buildFixture(clock: () => Date): GoldenFixture<RealmGrowthInput, number> {
  return makeManualFixture(
    'realmGrowthAmount',
    'magic1.c:1122-1130 (A6 §5, ≅ creature.c:287 expdiv)',
    buildCases(),
    clock,
  )
}
