import { BUFF_DUR_META, DEBUFF_DUR_META, NON_CAST_BUFF_DUR, SPELL_NO, type Character } from 'shared'
import type { CombatRng } from '../combat/dice.js'
import { isActive } from '../combat/statusEffects.js'
import { MAGE } from '../combat/constants.js'

/**
 * spellDuration — G4 버프/디버프 지속(dur) 순수식 + 만료 판정(A6 §6·§7, magic2-8.c).
 *
 * ## 범위 (Story 5 = dur 계산 + polling 만료 판정만, D3)
 * dur 스칼라·grant(buffs 필드 write)·isExpired 판정만 노출한다. 신규 event 발행 타이머 seam은
 * 도입하지 않는다 — 소비처(Story 7-9 effect·라이브 틱)가 `isExpired(until, tick)`로 polling 만료한다.
 * dur 메타(상수·클래스 보너스 대상·RPMEXT 양·굴림 계수)는 shared buffCatalog가 소유하고, 이 모듈은
 * 산술(MAX 하한·클래스 +60*L4·RPMEXT 가산·PRMAGI dur/2)만 담는다.
 *
 * ## 만료 관례 (statusEffects isActive와 정확히 일치)
 * combat/statusEffects.ts의 `isActive(effect, now) = until >= now`(활성)와 동일 절대-틱 관례다.
 * 그 대우가 만료 판정이다: `isExpired(until, tick) = tick > until`. 경계 tick==until은 아직 활성(만료
 * 아님)이다 — statusEffects·befuddledUntil/charmedUntil과 동일하게 `>` 경계를 쓴다(`>=` 아님).
 *
 * ## 표준 공식 한정 (invis/levit/light 제외)
 * computeBuffDur는 A6 §6 **표준 공식** `MAX(300, 1200+B*600) + 클래스/RPMEXT`만 재현한다. MAX(300)
 * 하한이 빠진 invisibility·levitate(A6 §11-b)와 연산자 버그의 light(A6 §11-a)는 dur 복원이 Story 9
 * OpenQ #3-a/#3-b라 buffCatalog에 미등록 → computeBuffDur가 throw한다(Story 9 전 오용 차단).
 */

/** MAX(300) 하한 — magic2.c:374 `MAX(300, …)`. */
const BUFF_FLOOR = 300
/** 표준 버프 base 상수 — magic2.c:374 `1200 + …`. */
const BUFF_BASE = 1200
/** B(=bonus[int]) 계수 — magic2.c:375 `bonus[int]*600`. */
const BUFF_INT_MULT = 600
/** 클래스 보너스 계수 — magic2.c:378 `60*((level+3)/4)`. */
const CLASS_BONUS_PER_L4 = 60
/** 표준 버프 RPMEXT 방 보너스(초) — magic2-7.c `+= 800L`. buffCatalog rpmext(표준)와 동값. */
const RPMEXT_STD = 800
/** detect/fly/invis RPMEXT 방 보너스(초) — magic3-5.c `+= 600L`. buffCatalog rpmext(detect/fly)와 동값. */
const RPMEXT_DETECT = 600

/** computeBuffDur 입력 — B(intBonus)·level·시전자 클래스·gated(CAST 여부)·rpmext(방 플래그). */
export interface BuffDurInput {
  /** bonus[intelligence] 사전 계산값(B). */
  readonly intBonus: number
  /** 시전자 레벨 — 클래스 보너스 L4=(level+3)/4 산출. */
  readonly level: number
  /** 시전자 클래스 리터럴(mtype.h) — classBonusClasses 매칭. */
  readonly casterClass: number
  /** CAST 여부. false(scroll/potion/wand)면 고정 1200(offensiveSpell ctx.gated 관례). */
  readonly gated: boolean
  /** 시전 방 RPMEXT 플래그 — true면 meta.rpmext 가산. */
  readonly rpmext: boolean
}

/**
 * standardDurArith — A6 §6 표준 버프 dur 산술(초). 순서(오라클 magic2.c:374-385):
 *   1. 비-CAST면 고정 1200 반환.
 *   2. base 항 = MAX(300, base + B*600).
 *   3. 시전자 클래스가 classBonusClasses면 += 60*trunc((level+3)/4) (하한 뒤 가산).
 *   4. 방 RPMEXT면 += rpmextAmt (표준 800, detect/fly/invis 600).
 *
 * computeBuffDur(표준 base=1200)·computeSpecialBuffDur의 invis(base=1200)·levit(base=2400) 분기가 공유한다 —
 * 세 곳이 동일 산술이라(invis는 SDINVI와 증명적 동형) 구조를 단일화한다. light는 산술 구조가 달라(gated 무관·
 * floor 없음·L4 스케일 base) 이 헬퍼를 쓰지 않는다.
 */
function standardDurArith(
  input: BuffDurInput,
  base: number,
  classBonusClasses: readonly number[],
  rpmextAmt: number,
): number {
  if (!input.gated) return NON_CAST_BUFF_DUR
  let dur = Math.max(BUFF_FLOOR, base + input.intBonus * BUFF_INT_MULT)
  if (classBonusClasses.includes(input.casterClass)) {
    dur += CLASS_BONUS_PER_L4 * Math.trunc((input.level + 3) / 4)
  }
  if (input.rpmext) dur += rpmextAmt
  return dur
}

/**
 * computeBuffDur — A6 §6 표준 버프 지속(초). base=1200 표준 산술을 standardDurArith에 위임한다.
 * 미등록 주문(invis/levit/light 등)은 throw한다 — 표준 공식이 아니다(Story 9 OpenQ 소관).
 */
export function computeBuffDur(spellNo: number, input: BuffDurInput): number {
  const meta = BUFF_DUR_META.get(spellNo)
  if (meta === undefined) {
    throw new Error(`표준 버프가 아닌 주문번호: ${spellNo} (invis/levit/light는 Story 9 소관)`)
  }
  return standardDurArith(input, BUFF_BASE, meta.classBonusClasses, meta.rpmext)
}

/** levitate base 상수 — magic5.c:515 `2400 + B*600`(표준 1200의 2배). */
const LEVIT_BASE = 2400
/** light base 상수 — magic2.c:316 `300 + L4*300`(레벨 스케일). */
const LIGHT_BASE = 300
/** light L4 계수 — magic2.c:316 `((level+3)/4)*300`. */
const LIGHT_PER_L4 = 300

/**
 * computeSpecialBuffDur — A6 §6 **표준 공식 예외** 3주문(SINVIS·SLEVIT·SLIGHT)의 dur(초).
 * 이 셋은 computeBuffDur(BUFF_DUR_META)에 미등록이라 throw되므로 여기서 별도 산출한다(Story 9 소관).
 *
 * ## OpenQ #3-b — invisibility·levitate MAX(300) 하한 복원 (A6 §11-b)
 * 오라클(magic3.c:456 invis `1200+B*600`, magic5.c:515 levit `2400+B*600`)은 표준 버프와 달리 MAX(300)
 * 하한이 빠져 저지능(B 음수)이면 dur이 0/음수가 된다(형상 결함). A6 §11-b 결정("표준 버프처럼 하한 적용")에
 * 따라 **표준 버프와 동일하게 MAX(300) 하한을 복원**한다 — 하한은 base 항(1200/2400 + B*600)에 걸고,
 * 클래스/RPMEXT 보너스는 하한 뒤 가산한다(computeBuffDur 순서 동형). 비-CAST는 표준처럼 고정 1200.
 *   - invisibility: MAX(300, 1200+B*600) + (MAGE ? 60*L4 : 0) + (rpmext ? 600 : 0). ⇒ SDINVI와 동형.
 *   - levitate:     MAX(300, 2400+B*600) + (rpmext ? 800 : 0). 클래스 보너스 없음.
 *
 * ## OpenQ #3-a — light 스케일 공식 복원 (A6 §11-a)
 * 오라클(magic2.c:316-317)은 `300+L4*300 + (RPMEXT)?600:0`이 연산자 우선순위 버그로 `(합계)?600:0`으로
 * 파싱돼 **항상 600초 고정**(레벨 스케일 무효)이다. A6 §11-a 결정("의도된 스케일 공식으로 복원")에 따라
 * **의도된 스케일** `300 + L4*300 + (rpmext ? 600 : 0)`을 복원한다(L4=trunc((level+3)/4)). base가 항상
 * ≥300이라 MAX(300) 하한은 불필요하다. 오라클 light()엔 how 분기가 없어(unconditional interval 세팅)
 * dur은 delivery 무관 — gated를 무시한다(non-CAST 고정 1200 미적용).
 *
 * 미등록 주문(표준 버프 등)은 throw한다 — computeBuffDur와 대칭 가드.
 */
export function computeSpecialBuffDur(spellNo: number, input: BuffDurInput): number {
  switch (spellNo) {
    case SPELL_NO.SINVIS:
      // MAX(300,1200+B*600) + MAGE?60*L4 + rpmext?600 — SDINVI와 동형(표준 산술 공유).
      return standardDurArith(input, BUFF_BASE, [MAGE], RPMEXT_DETECT)
    case SPELL_NO.SLEVIT:
      // MAX(300,2400+B*600) + rpmext?800 — 클래스 보너스 없음(표준 산술, base만 2400).
      return standardDurArith(input, LEVIT_BASE, [], RPMEXT_STD)
    case SPELL_NO.SLIGHT:
      // delivery 무관(gated 무시)·floor 불필요·L4 스케일 base — 표준 산술과 구조가 달라 인라인.
      return LIGHT_BASE + Math.trunc((input.level + 3) / 4) * LIGHT_PER_L4 + (input.rpmext ? RPMEXT_DETECT : 0)
    default:
      throw new Error(`특수 dur 주문이 아님: ${spellNo} (SINVIS/SLEVIT/SLIGHT만 처리)`)
  }
}

/** computeDebuffDur 입력 — B(intBonus)·대상 PRMAGI 보유 여부. */
export interface DebuffDurInput {
  /** bonus[intelligence] 사전 계산값(B). */
  readonly intBonus: number
  /** 대상이 마법저항(PRMAGI/MRMAGI)을 보유하면 dur/2. */
  readonly targetHasPrmagi: boolean
}

/**
 * computeDebuffDur — A6 §7 디버프 지속(초, CAST). fear/silence/charm 3종:
 *   dur = constant + (rollDie>0 ? rng(1,rollDie)*rollMult : 0) + B*intMult.
 *   대상 PRMAGI면 dur = trunc(dur/2) (무효화 아님, 절반 단축).
 *
 * rng는 mrand(1,rollDie) 굴림 seam이다(dice.ts CombatRng 관례). silence(rollDie=0)는 rng를 호출하지
 * 않는다. befuddle(dur=3/MAX(5) 저항 모델)·drain_exp/blind(타이머 없음)는 미등록 → throw(Story 8 소관).
 *
 * 스코프: **CAST 전용**이다. fear/silence/charm은 오라클(magic8.c:328·466·689)상 SCROLL·WAND/POTION
 * delivery별로 상수·굴림·intMult가 다른 별도 dur 분기를 갖지만(예: silence SCROLL≈350 vs CAST 3600),
 * 아이템 delivery는 #86(스펙 §5 Non-goal)이라 본 함수는 CAST 분기만 전사한다. non-CAST 디버프 dur
 * 변형은 Story 8 디버프 delivery 배선 시점에 추가한다(버프측 gated/NON_CAST_BUFF_DUR 대응).
 */
export function computeDebuffDur(spellNo: number, input: DebuffDurInput, rng: CombatRng): number {
  const meta = DEBUFF_DUR_META.get(spellNo)
  if (meta === undefined) {
    throw new Error(`fear/silence/charm이 아닌 주문번호: ${spellNo} (befuddle 등은 Story 8 소관)`)
  }
  const roll = meta.rollDie > 0 ? rng(1, meta.rollDie) * meta.rollMult : 0
  let dur = meta.constant + roll + input.intBonus * meta.intMult
  if (input.targetHasPrmagi) dur = Math.trunc(dur / 2)
  return dur
}

// buffs 필드의 동적 주문번호 키 접근 — characterSchema buffs는 strictObject(키='0'..'55')라 정적
// 인덱스 시그니처가 없어 변수 키 read/write에 타입 에러가 난다. 주문번호 키는 카탈로그(0-55)로
// 한정되므로 Record<string,{until}> 뷰로 좁혀 안전하게 동적 접근한다(schema는 카탈로그 밖 키를 거부).
type BuffMap = Record<string, { until: number }>

/**
 * grantBuff — 주문번호 buff의 until(절대-틱)을 세팅한 새 Character를 반환한다(immutable, grantPoison 선례).
 * 기존 buffs를 병합하고 같은 주문 재grant는 until을 덮어쓴다. 입력 Character·buffs는 변형하지 않는다.
 */
export function grantBuff(character: Character, spellNo: number, until: number): Character {
  const buffs: BuffMap = { ...(character.buffs as BuffMap | undefined), [String(spellNo)]: { until } }
  return { ...character, buffs }
}

/**
 * isExpired — 절대-틱 만료 판정. statusEffects isActive(`until >= now`=활성)의 대우:
 * `tick > until`이면 만료. 경계 tick==until은 활성(만료 false).
 */
export function isExpired(until: number, tick: number): boolean {
  return tick > until
}

/**
 * isBuffActive — Character의 주문번호 buff가 현재 tick에 활성인지. 경계 규칙(tick==until 활성)의 단일
 * 출처는 combat/statusEffects.isActive다 — 재구현하지 않고 buff 엔트리(객체 또는 undefined)를 그대로
 * 위임한다(buff 없음→undefined→비활성). magic→combat 의존은 offensiveSpell→accumulateDamage 선례.
 */
export function isBuffActive(character: Character, spellNo: number, tick: number): boolean {
  const entry = (character.buffs as BuffMap | undefined)?.[String(spellNo)]
  return isActive(entry, tick)
}
