import { writeFileSync } from 'node:fs'
import type { GoldenFixture } from '../types.js'

/**
 * 골든 fixture 생성기 공용 plumbing — manual-oracle envelope 조립 + frozen JSON 기록.
 *
 * 개별 생성기(computeAcFixture·classStatsFixture·thacoListFixture·modProficFixture)는
 * 대상별 `buildCases`(전사 리터럴)만 정의하고, envelope 규약(`method:'manual'`·`seed:null`·
 * clock 스탬프)과 디스크 포맷(2-space indent + trailing newline)은 이 모듈로 단일화한다.
 * anti-tautology의 핵심인 ORACLE 리터럴·`buildCases`는 생성기별로 남는다 — 이 plumbing은
 * 그 리터럴을 건드리지 않으므로 전사 독립성을 해치지 않는다.
 */

/**
 * manual oracle fixture envelope을 조립한다. `method:'manual'`·`seed:null` 규약과
 * `generatedAt` clock 스탬프의 단일 출처다. `cases`는 각 생성기의 `buildCases()` 결과다.
 */
export function makeManualFixture<I, O>(
  fn: string,
  source: string,
  cases: GoldenFixture<I, O>['cases'],
  clock: () => Date,
): GoldenFixture<I, O> {
  return {
    fn,
    oracle: {
      method: 'manual',
      source,
      generatedAt: clock().toISOString(),
      seed: null,
    },
    cases,
  }
}

/** fixture를 2-space pretty JSON으로 파일에 기록한다. frozen JSON 포맷의 단일 출처. */
export function writeFixtureFile<I, O>(path: string, fixture: GoldenFixture<I, O>): void {
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
}
