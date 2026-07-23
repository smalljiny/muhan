import { SPELL_NO } from './catalog.js'

/**
 * buffCatalog — 지속효과 dur 공식 메타 테이블(A6 §6 버프 · §7 디버프, magic2-8.c).
 *
 * ## 역할: 선언 데이터, 산술 없음
 * dur 산술(MAX(300,…)·PRMAGI dur/2·rng 굴림)은 소비처(server spellDuration.ts computeBuffDur/
 * computeDebuffDur)가 소유한다. 이 모듈은 주문번호별 **상수·클래스 보너스 대상·RPMEXT 양·굴림 계수**만
 * 담는다(offensiveSpell의 OSPELL_GRID 선례 — 격자 데이터는 shared, 산술은 server).
 *
 * ## 범위 경계 (Story 5 = 표준 공식만)
 * BUFF_DUR_META는 A6 §6 **표준 버프 11종**만 담는다 — 전부 `MAX(300, 1200+B*600)` 공식을 쓴다.
 * invisibility(SINVIS)·levitate(SLEVIT)·light(SLIGHT)는 MAX(300) 하한이 빠졌거나(A6 §11-b) 연산자
 * 우선순위 버그(A6 §11-a)로 표준 공식을 벗어난다. 이 세 주문의 dur 복원 여부는 Story 9 OpenQ #3-a/#3-b라
 * 여기 등록하지 않는다 — computeBuffDur가 미등록 주문에 throw해 Story 9 전 오용을 차단한다.
 *
 * DEBUFF_DUR_META는 A6 §7 **PRMAGI→dur/2 모델 3종**(fear·silence·charm)만 담는다. befuddle은 저항 시
 * dur=3(단축)·else MAX(5)라는 다른 모델이고 MRBEFD/MNOCHA 플래그·자기변형에 결합돼 Story 8 소관이다.
 *
 * ## 클래스 리터럴 (mtype.h)
 * classBonusClasses는 mtype.h 클래스 인덱스 리터럴이다: CLERIC=3·PALADIN=6·MAGE=5. shared는 server의
 * combat/constants.ts를 import하지 못하므로 mproficFixture 선례대로 리터럴+주석으로 전사한다.
 */

/** 비-CAST(scroll/potion/wand) 버프 고정 지속 — magic2-8.c의 `else interval = 1200`. */
export const NON_CAST_BUFF_DUR = 1200

/** 표준 버프 dur 메타 — 클래스 보너스 대상 클래스·RPMEXT 방 보너스 양(초). */
export interface BuffDurMeta {
  /** `+60*L4` 클래스 보너스를 받는 클래스 리터럴(mtype.h). 빈 배열이면 클래스 보너스 없음. */
  readonly classBonusClasses: readonly number[]
  /** RPMEXT 방에서 가산되는 보너스(초). 표준 800, detect/fly 600. */
  readonly rpmext: number
}

/**
 * BUFF_DUR_META — A6 §6 표준 버프 11종. 전부 base=MAX(300, 1200+B*600).
 *   protection/bless: CLERIC(3)/PALADIN(6) +60*L4, RPMEXT +800.
 *   resist(fire/cold/magic)·breathe_water·earth_shield·know_alignment: 클래스 보너스 없음, RPMEXT +800.
 *   detectinvis/detectmagic: MAGE(5) +60*L4, RPMEXT +600.
 *   fly: 클래스 보너스 없음, RPMEXT +600.
 */
export const BUFF_DUR_META: ReadonlyMap<number, BuffDurMeta> = new Map([
  [SPELL_NO.SPROTE, { classBonusClasses: [3, 6], rpmext: 800 }],
  [SPELL_NO.SBLESS, { classBonusClasses: [3, 6], rpmext: 800 }],
  [SPELL_NO.SRFIRE, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SRCOLD, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SRMAGI, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SBRWAT, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SSSHLD, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SKNOWA, { classBonusClasses: [], rpmext: 800 }],
  [SPELL_NO.SDINVI, { classBonusClasses: [5], rpmext: 600 }],
  [SPELL_NO.SDMAGI, { classBonusClasses: [5], rpmext: 600 }],
  [SPELL_NO.SFLYSP, { classBonusClasses: [], rpmext: 600 }],
])

/**
 * 디버프 dur 메타 — `dur = constant + (rollDie>0 ? mrand(1,rollDie)*rollMult : 0) + B*intMult`,
 * 이어 PRMAGI 대상이면 `trunc(dur/2)`. silence는 굴림·int 항이 없는 고정 3600(rollDie/intMult=0).
 */
export interface DebuffDurMeta {
  /** 기본 상수 항. */
  readonly constant: number
  /** mrand(1, rollDie) 상한. 0이면 굴림 없음(silence). */
  readonly rollDie: number
  /** 굴림 결과에 곱하는 계수. */
  readonly rollMult: number
  /** intBonus(B)에 곱하는 계수. */
  readonly intMult: number
}

/**
 * DEBUFF_DUR_META — A6 §7 PRMAGI→dur/2 모델 3종(CAST dur).
 *   fear   (LT_FEARS 33): 600 + mrand(1,30)*10 + B*150   (magic8.c:329).
 *   silence(LT_SILNC 34): 3600 고정                        (magic8.c:466).
 *   charm  (LT_CHRMD 36): 300 + mrand(1,30)*10 + B*30     (magic8.c:689).
 */
export const DEBUFF_DUR_META: ReadonlyMap<number, DebuffDurMeta> = new Map([
  [SPELL_NO.SFEARS, { constant: 600, rollDie: 30, rollMult: 10, intMult: 150 }],
  [SPELL_NO.SSILNC, { constant: 3600, rollDie: 0, rollMult: 0, intMult: 0 }],
  [SPELL_NO.SCHARM, { constant: 300, rollDie: 30, rollMult: 10, intMult: 30 }],
])
