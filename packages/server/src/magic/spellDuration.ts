import { BUFF_DUR_META, DEBUFF_DUR_META, NON_CAST_BUFF_DUR, type Character } from 'shared'
import type { CombatRng } from '../combat/dice.js'
import { isActive } from '../combat/statusEffects.js'

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
 * computeBuffDur — A6 §6 표준 버프 지속(초). 순서(오라클 magic2.c:374-385):
 *   1. 비-CAST면 고정 1200 반환.
 *   2. base = MAX(300, 1200 + B*600).
 *   3. 시전자 클래스가 classBonusClasses면 += 60*trunc((level+3)/4) (하한 뒤 가산).
 *   4. 방 RPMEXT면 += meta.rpmext (표준 800, detect/fly 600).
 *
 * 미등록 주문(invis/levit/light 등)은 throw한다 — 표준 공식이 아니다(Story 9 OpenQ 소관).
 */
export function computeBuffDur(spellNo: number, input: BuffDurInput): number {
  const meta = BUFF_DUR_META.get(spellNo)
  if (meta === undefined) {
    throw new Error(`표준 버프가 아닌 주문번호: ${spellNo} (invis/levit/light는 Story 9 소관)`)
  }
  if (!input.gated) return NON_CAST_BUFF_DUR
  let dur = Math.max(BUFF_FLOOR, BUFF_BASE + input.intBonus * BUFF_INT_MULT)
  if (meta.classBonusClasses.includes(input.casterClass)) {
    dur += CLASS_BONUS_PER_L4 * Math.trunc((input.level + 3) / 4)
  }
  if (input.rpmext) dur += meta.rpmext
  return dur
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
