import type { GoldenFixture } from '../types.js'
import { needed_exp } from '../../progression/tables.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildFixture, writeFixtureFile }`로 소비하므로 writer를 re-export한다.
export { writeFixtureFile }

/**
 * needed_exp(exp 곡선 룩업·역함수) 골든 fixture 생성기 — manual oracle의 독립 참조 구현.
 *
 * 원본 `global.c:129`(needed_exp 테이블) + `command7.c:590`(neededExp) + `misc.c:472`
 * (exp_to_lev)의 동작을 참조 구현(`referenceNeededExp`/`referenceExpToLevel`)으로 옮기고,
 * 대표 12개 케이스를 fixture로 감싸 `fixtures/needed_exp.json`에 기록한다. 산술 정본은
 * 런타임 `progression/expCurve.ts`(SUT)에 두며, 이 참조는 그 SUT와 **독립 표현**으로 작성한다:
 * - `referenceNeededExp`: 배열 인덱싱 대신 `.at()` + 선형항을 분배 형태로 재표현.
 * - `referenceExpToLevel`: 명령형 while 루프 대신 임계 배열 `filter` 카운트로 재표현
 *   (index 0..126이 단조 증가라 while 루프의 leading-threshold 카운트와 등가).
 * needed_exp 테이블 자체는 `progression/tables.ts`에서 import한다(재전사 금지).
 *
 * ## 결정적 함정: 배열 상한 vs 선형 피벗 불일치
 * neededExp(128)=needed_exp[127]=190000000이지만 선형 확장·역산 피벗은 needed_exp[126]=
 * 100000000이다. round-trip은 L=128에서 깨진다(fixture는 L=128을 forward 케이스로만 포함).
 *
 * ## 재생성 (수동 트리거)
 * `expected`·`generatedAt`은 체크인 후 frozen이며, 회귀 테스트 중 자동 재생성은 없다.
 *
 * ```
 * cd packages/shared
 * node --input-type=module -e "import { buildFixture, writeFixtureFile } from './src/oracle/generators/neededExpFixture.ts'; writeFixtureFile('./src/oracle/fixtures/needed_exp.json', buildFixture(() => new Date('2026-07-21T00:00:00.000Z')))"
 * ```
 */

/** 선형 확장 스칼라 — SUT와 동일 상수(스칼라 재정의는 128칸 테이블 전사 독립성을 해치지 않는다). */
const LINEAR_STEP = 5_000_000
const MAXALVL = 128

/**
 * neededExp 참조 구현 — SUT(`expCurve.ts`)와 독립 표현.
 *
 * SUT는 `needed_exp[level-1]` 인덱싱과 `(level-127)*STEP` 곱을 쓰지만, 여기선 `.at()`로
 * 조회하고 선형항을 `STEP*level - STEP*127 + pivot` 분배 형태로 재표현한다(값 동일·표현만 다름).
 */
export function referenceNeededExp(level: number): number {
  if (level < 1) return needed_exp.at(0)!
  if (level <= MAXALVL) return needed_exp.at(level - 1)!
  const pivot = needed_exp.at(MAXALVL - 2)!
  return LINEAR_STEP * level - LINEAR_STEP * (MAXALVL - 1) + pivot
}

/**
 * expToLevel 참조 구현 — SUT와 독립 표현.
 *
 * SUT는 명령형 while 루프로 임계를 순차 넘지만, 여기선 index 0..126 임계 중 exp가 충족한
 * 개수를 `filter`로 세어 레벨을 산출한다(index 0..126 단조 증가 → leading-threshold 카운트와
 * 등가). 배열 상한 도달 시 index 126 피벗 기준 선형 역산으로 전환한다.
 */
export function referenceExpToLevel(exp: number): number {
  const thresholdsMet = needed_exp.slice(0, MAXALVL - 1).filter((t) => exp >= t).length
  let level = 1 + thresholdsMet
  if (level >= MAXALVL) {
    level = Math.trunc((exp - needed_exp.at(MAXALVL - 2)!) / LINEAR_STEP) + MAXALVL
  }
  return Math.max(1, level)
}

/** fixture 한 case의 input — 어느 함수를 어느 인자로 호출하는지 판별하는 discriminated 형태. */
export type NeededExpCaseInput = { fn: 'neededExp' | 'expToLevel'; arg: number }

/** 참조 구현으로 discriminated input을 계산한다 — 골든 회귀 SUT 디스패치와 동형. */
function referenceCompute(input: NeededExpCaseInput): number {
  return input.fn === 'neededExp' ? referenceNeededExp(input.arg) : referenceExpToLevel(input.arg)
}

/** fixture 한 case의 형태. */
type NeededExpCase = { input: NeededExpCaseInput; expected: number; note?: string }

/** expected를 채우기 전의 case 초안. */
type NeededExpCaseDraft = Omit<NeededExpCase, 'expected'>

/**
 * 골든 케이스 12개를 구성한다. expected는 생성기 정상 경로대로 참조 구현으로 채운다.
 * (테스트 측 Layer B 앵커는 이와 독립적으로 확정 정본 하드 리터럴로 tautology를 차단한다.)
 */
export function buildCases(): NeededExpCase[] {
  const inputs: NeededExpCaseDraft[] = [
    { input: { fn: 'neededExp', arg: 1 }, note: 'L1 배열 룩업 needed_exp[0]=128' },
    { input: { fn: 'neededExp', arg: 2 }, note: 'L2 배열 룩업 needed_exp[1]=256' },
    { input: { fn: 'neededExp', arg: 36 }, note: 'L36 배열 룩업 needed_exp[35]=100000' },
    { input: { fn: 'neededExp', arg: 104 }, note: 'L104 배열 룩업 needed_exp[103]=10000000' },
    { input: { fn: 'neededExp', arg: 128 }, note: 'L128 배열 상한 needed_exp[127]=190000000 (비단조 forward)' },
    { input: { fn: 'neededExp', arg: 129 }, note: 'L129 선형 확장 index 126 피벗 → 110000000' },
    { input: { fn: 'expToLevel', arg: 0 }, note: 'exp 0 → L1 (첫 임계 128 미만)' },
    { input: { fn: 'expToLevel', arg: 127 }, note: 'exp 127 → L1 (첫 임계 바로 아래)' },
    { input: { fn: 'expToLevel', arg: 128 }, note: 'exp 128 → L2 round-trip(L1 임계 충족)' },
    { input: { fn: 'expToLevel', arg: 256 }, note: 'exp 256 → L3 round-trip(L2 임계 충족)' },
    { input: { fn: 'expToLevel', arg: 100000000 }, note: 'exp 100M → L128 (index 126 임계 충족, 배열 상한)' },
    { input: { fn: 'expToLevel', arg: 110000000 }, note: 'exp 110M → L130 선형 역산 round-trip(L129)' },
  ]

  return inputs.map((c) => ({ ...c, expected: referenceCompute(c.input) }))
}

/**
 * 케이스를 골든 fixture로 감싼다. `generatedAt`은 주입 clock으로 스탬프해 결정적으로 만든다.
 */
export function buildFixture(clock: () => Date): GoldenFixture<NeededExpCaseInput, number> {
  return makeManualFixture(
    'needed_exp',
    'global.c:129 needed_exp / command7.c:590 / misc.c:472',
    buildCases(),
    clock,
  )
}
