import type { GoldenFixture } from '../types.js'
import { SPELL_NO } from '../../magic/catalog.js'
import { makeManualFixture, writeFixtureFile } from './fixtureIo.js'

// 재생성 명령이 `import { buildBuffFixture, buildDebuffFixture, writeFixtureFile }`로 소비한다.
export { writeFixtureFile }

/**
 * 버프/디버프 dur 골든 전사-diff fixture 생성기 — manual oracle(A6 §6·§7, magic2-8.c).
 *
 * 원본 magic2.c:374(버프)·magic8.c(디버프)의 dur 공식을 **독립 리터럴**로 전사해(전사 pass 2)
 * 케이스로 감싼다. SUT computeBuffDur/computeDebuffDur(server)는 buffCatalog 메타 테이블을 소비하는
 * 다른 구조(전사 pass 1)이므로, approve가 두 전사의 불일치를 잡아낸다(anti-tautology).
 *
 * ## 두 fixture 분리
 * computeBuffDur·computeDebuffDur는 별 함수라 fn·입력 셰이프가 다르다. buff_duration.json(fn=
 * computeBuffDur)·debuff_duration.json(fn=computeDebuffDur)으로 나눈다. SUT 소비 approve는
 * server(spellDuration.test.ts)가 소유한다 — shared는 server를 import 못 하므로 여기선 fixture만 만든다.
 *
 * ## 디버프 굴림 결정성
 * fear/charm은 mrand(1,30)*10 굴림을 갖는다. case input에 `roll`(mrand 결과)을 실어 결정성을 확보하고,
 * server approve가 `rng = () => roll`로 SUT를 호출한다. silence(굴림 없음)는 roll을 무시한다.
 *
 * ## 재생성 (수동 트리거)
 * ```
 * cd packages/shared
 * node ../server/node_modules/tsx/dist/cli.mjs --eval "import { buildBuffFixture, buildDebuffFixture, writeFixtureFile } from './src/oracle/generators/buffDurationFixture.ts'; const c=()=>new Date('2026-07-16T00:00:00.000Z'); writeFixtureFile('./src/oracle/fixtures/buff_duration.json', buildBuffFixture(c)); writeFixtureFile('./src/oracle/fixtures/debuff_duration.json', buildDebuffFixture(c))"
 * ```
 */

// ── 클래스 리터럴(mtype.h) ──────────────────────────────────────────────────
const CLERIC = 3
const MAGE = 5
const PALADIN = 6

// ── 버프 fixture ────────────────────────────────────────────────────────────
export interface BuffDurInput {
  readonly spellNo: number
  readonly intBonus: number
  readonly level: number
  readonly casterClass: number
  readonly gated: boolean
  readonly rpmext: boolean
}

/** classBonus 대상 클래스(독립 전사) — protection/bless=CLERIC/PALADIN, detect*=MAGE, 그 외 없음. */
function classBonusClasses(spellNo: number): readonly number[] {
  if (spellNo === SPELL_NO.SPROTE || spellNo === SPELL_NO.SBLESS) return [CLERIC, PALADIN]
  if (spellNo === SPELL_NO.SDINVI || spellNo === SPELL_NO.SDMAGI) return [MAGE]
  return []
}

/** RPMEXT 보너스(독립 전사) — detect/fly=600, 나머지 표준=800. */
function rpmextAmount(spellNo: number): number {
  if (spellNo === SPELL_NO.SDINVI || spellNo === SPELL_NO.SDMAGI || spellNo === SPELL_NO.SFLYSP) {
    return 600
  }
  return 800
}

/**
 * 독립 전사(pass 2) — magic2.c:374-385 표준 버프 dur.
 *   비-CAST → 1200; CAST → MAX(300, 1200+B*600) [+ 60*L4] [+ rpmext].
 */
export function oracleBuffDur(input: BuffDurInput): number {
  if (!input.gated) return 1200
  let dur = Math.max(300, 1200 + input.intBonus * 600)
  if (classBonusClasses(input.spellNo).includes(input.casterClass)) {
    dur += 60 * Math.trunc((input.level + 3) / 4)
  }
  if (input.rpmext) dur += rpmextAmount(input.spellNo)
  return dur
}

function makeBuffCase(
  input: BuffDurInput,
  note?: string,
): GoldenFixture<BuffDurInput, number>['cases'][number] {
  const base = { input, expected: oracleBuffDur(input) }
  return note ? { ...base, note } : base
}

/**
 * 버프 케이스:
 *   - base(B=0, 클래스/RPMEXT 없음).
 *   - B>0 스케일.
 *   - 음수 B → MAX(300) 하한.
 *   - CLERIC protection +60*L4.
 *   - MAGE detectinvis +60*L4.
 *   - RPMEXT 800(표준)·600(detect/fly).
 *   - 클래스+RPMEXT 동시.
 *   - 비-CAST 고정 1200.
 */
export function buildBuffCases(): GoldenFixture<BuffDurInput, number>['cases'] {
  const g = { level: 10, casterClass: 4, gated: true, rpmext: false }
  return [
    makeBuffCase({ ...g, spellNo: SPELL_NO.SPROTE, intBonus: 0 }, 'base: MAX(300,1200)=1200'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SRFIRE, intBonus: 2, casterClass: 5 }, 'B=2 → 2400'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SRFIRE, intBonus: -2, casterClass: 5 }, '음수 B → 하한 300'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SPROTE, intBonus: 0, casterClass: CLERIC }, 'CLERIC +60*L4=180 → 1380'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SDINVI, intBonus: 0, casterClass: MAGE }, 'MAGE detect +180 → 1380'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SDINVI, intBonus: 0, casterClass: CLERIC }, '비-MAGE detect → 1200'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SRFIRE, intBonus: 0, casterClass: 5, rpmext: true }, 'RPMEXT 800 → 2000'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SFLYSP, intBonus: 0, casterClass: 5, rpmext: true }, 'fly RPMEXT 600 → 1800'),
    makeBuffCase({ ...g, spellNo: SPELL_NO.SBLESS, intBonus: 0, casterClass: CLERIC, rpmext: true }, 'CLERIC+RPMEXT → 2180'),
    makeBuffCase({ spellNo: SPELL_NO.SPROTE, intBonus: 5, level: 60, casterClass: CLERIC, gated: false, rpmext: true }, '비-CAST 고정 1200'),
  ]
}

export function buildBuffFixture(clock: () => Date): GoldenFixture<BuffDurInput, number> {
  return makeManualFixture('computeBuffDur', 'magic2.c:374-385 (A6 §6 표준 버프)', buildBuffCases(), clock)
}

// ── 디버프 fixture ──────────────────────────────────────────────────────────
export interface DebuffDurInput {
  readonly spellNo: number
  readonly intBonus: number
  readonly prmagi: boolean
  readonly roll: number
}

/**
 * 독립 전사(pass 2) — magic8.c fear/silence/charm dur.
 *   fear   : 600 + roll*10 + B*150.
 *   silence: 3600 고정(roll·B 무시).
 *   charm  : 300 + roll*10 + B*30.
 *   PRMAGI 대상 → trunc(dur/2).
 */
export function oracleDebuffDur(input: DebuffDurInput): number {
  let dur: number
  if (input.spellNo === SPELL_NO.SFEARS) {
    dur = 600 + input.roll * 10 + input.intBonus * 150
  } else if (input.spellNo === SPELL_NO.SSILNC) {
    dur = 3600
  } else if (input.spellNo === SPELL_NO.SCHARM) {
    dur = 300 + input.roll * 10 + input.intBonus * 30
  } else {
    throw new Error(`디버프 fixture 미지원 주문번호: ${input.spellNo}`)
  }
  if (input.prmagi) dur = Math.trunc(dur / 2)
  return dur
}

function makeDebuffCase(
  input: DebuffDurInput,
  note?: string,
): GoldenFixture<DebuffDurInput, number>['cases'][number] {
  const base = { input, expected: oracleDebuffDur(input) }
  return note ? { ...base, note } : base
}

/**
 * 디버프 케이스:
 *   - fear base(roll·B).
 *   - silence 고정 3600.
 *   - charm base.
 *   - PRMAGI silence 3600→1800(결정적 anti-tautology).
 *   - PRMAGI fear 홀수 dur trunc 내림.
 */
export function buildDebuffCases(): GoldenFixture<DebuffDurInput, number>['cases'] {
  return [
    makeDebuffCase({ spellNo: SPELL_NO.SFEARS, intBonus: 2, prmagi: false, roll: 5 }, 'fear 600+50+300=950'),
    makeDebuffCase({ spellNo: SPELL_NO.SSILNC, intBonus: 5, prmagi: false, roll: 30 }, 'silence 고정 3600'),
    makeDebuffCase({ spellNo: SPELL_NO.SCHARM, intBonus: 1, prmagi: false, roll: 10 }, 'charm 300+100+30=430'),
    makeDebuffCase({ spellNo: SPELL_NO.SSILNC, intBonus: 0, prmagi: true, roll: 1 }, 'PRMAGI 3600→1800'),
    makeDebuffCase({ spellNo: SPELL_NO.SFEARS, intBonus: 0, prmagi: true, roll: 1 }, 'PRMAGI 610→305 trunc'),
  ]
}

export function buildDebuffFixture(clock: () => Date): GoldenFixture<DebuffDurInput, number> {
  return makeManualFixture('computeDebuffDur', 'magic8.c (A6 §7 fear/silence/charm)', buildDebuffCases(), clock)
}
