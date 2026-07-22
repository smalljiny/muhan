/**
 * 방어구 착용(wear) 다층 게이트 — 오라클 command3.c wear()(라인 52~194)의 게이트 순서를
 * 글자 그대로 이식한 순수 함수. 실 인벤 이동·객체 파괴는 outcome만 반환하고 배선은 유예한다.
 *
 * 게이트는 첫 실패에서 즉시 반환한다. questnum·ONEWEV(flags)를 반드시 스레드해야 소각·레벨
 * 게이트가 정확히 발화한다. 저주(OCURSE)는 게이트에 포함하지 않는다 — 저주는 탈착 시점 판정이다.
 */

import type { ObjectInstance } from 'shared'
import { F_ISSET, OALCRT } from '../world/hexFlags.js'
import {
  MAGE,
  CLERIC,
  FIGHTER,
  ASSASSIN,
  THIEF,
  PALADIN,
  RANGER,
  INVINCIBLE,
} from '../combat/constants.js'
import { SHARP, THRUST, ARMOR, BODY, WIELD, HELD, resolveSlot } from './taxonomy.js'
import {
  ONOMAG,
  ONEWEV,
  ONSHAT,
  OEVENT,
  genderAllowed,
  isMarriageGated,
  alignmentAllowed,
  sizeAllowed,
  isPersonalBound,
  oclselBlocks,
} from './flags.js'

// ── 오라클 밸런스 상수(command3.c wear) ──────────────────────────────────────
/** 소각 임계 — shotsmax/shotscur가 이 값을 초과하면 손상 아이템으로 소각(command3.c:79 `> 1001`). */
const SHOTS_BURN_THRESHOLD = 1001
/** AC 소각 임계 — check_ac가 이 값을 초과하면 소각(command3.c:93 `> 151`). */
const AC_BURN_THRESHOLD = 151
/** AC 레벨 하한 — check_ac가 이 값 미만이면 0으로 리셋해 레벨 게이트를 면제(command3.c:98 `< 30`). */
const AC_LEVEL_FLOOR = 30
/** BODY 착용 시 AC 가중(command3.c:90 `armor *2`). */
const BODY_AC_WEIGHT = 2
/** 비BODY 착용 시 AC 가중(command3.c:91 `armor * 5`). */
const OTHER_AC_WEIGHT = 5
/** 소각 메시지 — shots 소각(③)·AC 소각(④)이 공유(command3.c "푸른 연기와 함께 사라졌습니다"). */
const BURN_REASON = '푸른 연기와 함께 사라졌습니다.'

/**
 * 착용 주체 — E6 유예 필드(married·수치 alignment)를 명시 입력으로 받는다.
 * gender는 1=남/2=여. race는 mtype.h RACE 인코딩.
 */
export interface WearActor {
  readonly class: number
  readonly level: number
  readonly gender: number
  readonly alignment: number
  readonly race: number
  readonly married: boolean
}

/**
 * wearGate 입력 — object의 instance + template 스탯 + 점유 슬롯 + 착용 주체.
 * questnum·flags(ONEWEV 포함)를 스레드해야 소각·레벨 게이트가 정확히 발화한다.
 */
export interface WearParams {
  readonly flags: string
  readonly type: number
  readonly wearflag: number
  readonly armor: number
  readonly shotsmax: number
  readonly shotscur: number
  readonly questnum: number
  readonly instance: ObjectInstance
  readonly occupiedSlots: ReadonlySet<number>
  readonly actor: WearActor
}

/**
 * 착용 결과 판별 유니온:
 * - equipped: 착용 성공, slot 설정된 새 인스턴스
 * - rejected: 게이트 거부(인벤에 그대로)
 * - burned: 밸런스 소각(파괴 — 배선 유예)
 * - bounced: 정렬 반발로 몸에서 튕겨 바닥 낙하(reject와 별개)
 */
export type WearOutcome =
  | { readonly kind: 'equipped'; readonly object: ObjectInstance }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'burned'; readonly reason: string }
  | { readonly kind: 'bounced'; readonly reason: string }

/**
 * 방어구 착용 다층 게이트 — 오라클 순서대로 첫 실패에서 즉시 반환한다.
 * 통과 시 ⑥에서 얻은 slot으로 equipped 새 인스턴스를 반환한다(입력 불변).
 */
export function wearGate(params: WearParams): WearOutcome {
  const { flags, type, wearflag, armor, shotsmax, shotscur, questnum, instance, occupiedSlots, actor } =
    params

  // 0. 라우팅 — wear는 방어구/장신구 전용. 무기(WIELD)·든 물건(HELD)·미착용(0)은 거부.
  if (wearflag === 0 || wearflag === WIELD || wearflag === HELD) {
    return { kind: 'rejected', reason: '입는 물건이 아닙니다.' }
  }

  // ① ONOMAG — type===ARMOR 조건부, MAGE/CLERIC 착용 금지(command3.c:61).
  // flags.ts의 융합 classAllowed(ONOMAG+OCLSEL)를 쓰지 않는다 — 오라클은 ONOMAG를 ①,
  // OCLSEL을 ⑨로 분리 검사하므로 융합 predicate를 쓰면 게이트 순서가 깨진다(⑨ 참조).
  if (type === ARMOR && F_ISSET(flags, ONOMAG) && (actor.class === MAGE || actor.class === CLERIC)) {
    return { kind: 'rejected', reason: '도술사, 불제자들은 사용할수 없습니다.' }
  }

  // ② 성별 — type===ARMOR 조건부, ONOFEM+여성·ONOMAL+남성 거부(command3.c:67-74).
  if (type === ARMOR && !genderAllowed(flags, actor.gender)) {
    return { kind: 'rejected', reason: '성별이 맞지 않습니다.' }
  }

  // ③ 소각-shots — shotsmax/shotscur가 1001 초과면 questnum===0일 때 소각, 아니면 우회(command3.c:79).
  if (shotsmax > SHOTS_BURN_THRESHOLD || shotscur > SHOTS_BURN_THRESHOLD) {
    if (questnum === 0) {
      return { kind: 'burned', reason: BURN_REASON }
    }
    // questnum!==0이면 소각 우회 — 다음 게이트로 진행.
  }

  // ④ 레벨/AC — intra-순서 엄격(command3.c:90-100).
  let checkAc = wearflag === BODY ? armor * BODY_AC_WEIGHT : armor * OTHER_AC_WEIGHT
  // 소각은 <30 리셋 이전에 검사 — ONEWEV은 이 소각을 면제하지 않는다(questnum만).
  if (checkAc > AC_BURN_THRESHOLD && questnum === 0) {
    return { kind: 'burned', reason: BURN_REASON }
  }
  // 소각 검사 이후에 리셋 — >151 아이템을 구제하지 못한다.
  if (checkAc < AC_LEVEL_FLOOR) checkAc = 0
  // ONEWEV은 이 레벨 거부만 면제한다.
  if (
    actor.class < INVINCIBLE &&
    questnum === 0 &&
    !F_ISSET(flags, ONEWEV) &&
    actor.level < checkAc
  ) {
    return { kind: 'rejected', reason: '당신의 능력으로는 사용할 수 없는 물건입니다.' }
  }

  // ⑤ 결혼 — type===ARMOR 조건부, OMARRI+미혼 거부(command3.c:105).
  if (type === ARMOR && isMarriageGated(flags) && !actor.married) {
    return { kind: 'rejected', reason: '결혼한 사람들만 입을 수 있습니다.' }
  }

  // ⑥ 슬롯 점유 — resolveSlot 1회만 호출. null이면 만석 거부, non-null이면 T5.3에서 재사용.
  const slot = resolveSlot(wearflag, occupiedSlots)
  if (slot === null) {
    return { kind: 'rejected', reason: '더이상 착용할 수 없습니다.' }
  }

  // ⑦ 파손 — shotscur<1이면 부서져서 착용 불가(command3.c:126).
  if (shotscur < 1) {
    return { kind: 'rejected', reason: '부서져서 입을 수 없게 되었습니다.' }
  }

  // ⑧ 정렬 — OGOODO+정렬<-50·OEVILO+정렬>50이면 몸에서 튕겨 바닥 낙하(command3.c:132·142).
  if (!alignmentAllowed(flags, actor.alignment)) {
    return { kind: 'bounced', reason: '당신 몸에서 튕겨져 나가 바닥에 떨어집니다.' }
  }

  // ⑨ OCLSEL — class<INVINCIBLE 게이트. ONOMAG은 ①에서 이미 처리하므로 OCLSEL만 개별 검사(command3.c:159).
  if (oclselBlocks(flags, actor.class)) {
    return { kind: 'rejected', reason: '당신의 직업에 맞지 않습니다.' }
  }

  // ⑩ OSIZE — class<INVINCIBLE 게이트. sizeAllowed는 INVINCIBLE 우회를 담지 않으므로 외부에서 감싼다(command3.c:165-184).
  if (!sizeAllowed(flags, actor.race) && actor.class < INVINCIBLE) {
    return { kind: 'rejected', reason: '당신 몸에 맞지 않습니다.' }
  }

  // 통과 — ⑥에서 얻은 slot으로 equipped 새 인스턴스(입력 불변).
  return { kind: 'equipped', object: { ...instance, equipped: true, slot } }
}

// ── 무기 장착(ready)·쥠(hold) 게이트 상수(command3.c ready/hold) ─────────────
// WIELD 슬롯은 WIELD−1(=19), HELD 슬롯은 HELD−1(=16)이며 단일 슬롯이므로 resolveSlot 결과를 그대로 재사용한다
// (오라클 `ready[WIELD-1]`·`ready[HELD-1]`).
/** 마법사 무거운무기 dice합 임계 — 초과 시 MAGE/CLERIC 거부(command3.c:724 `> 14`). */
const MAGE_WEAPON_DICE_LIMIT = 14
/** 무기 dice합 소각 임계 — 초과 시(questnum===0 && !ONEWEV) 소각(command3.c:786 `>39`). */
const WEAPON_BURN_DICE_LIMIT = 39
/** 무기 shots 소각 임계 — shotsmax/shotscur가 초과 시(!ONEWEV) 소각(command3.c:793 `> 600`). */
const WEAPON_SHOTS_LIMIT = 600
/** 레벨 게이트 check_dmg 임계 — 초과 시 레벨 검사(command3.c:815 `check_dmg > 15`). */
const LEVEL_CHECK_DMG_THRESHOLD = 15
/** 레벨 요구 배수 — level < check_dmg*3이면 거부(command3.c:816 `check_dmg * 3`). */
const LEVEL_DMG_MULTIPLIER = 3
/** FIGHTER check_dmg 완화(command3.c:809 `check_dmg -= 7`). */
const FIGHTER_DMG_RELIEF = 7
/** ASSASSIN/THIEF check_dmg 완화(command3.c:810-811 `check_dmg -= 3`). */
const ASSASSIN_THIEF_DMG_RELIEF = 3
/** PALADIN/RANGER check_dmg 완화(command3.c:812-813 `check_dmg -= 2`). */
const PALADIN_RANGER_DMG_RELIEF = 2
/** hold 강력무기 dice합 임계 — 초과 시 거부(command3.c:906 `> 100`). */
const HELD_DICE_LIMIT = 100
/** ready 소각 메시지(command3.c:788·795·801). */
const READY_BURN_REASON = '당신이 무기를 쥐자 푸른 빛을 내며 사라집니다.'
/** ready 정렬 반발 메시지(command3.c:762·771). */
const READY_BOUNCE_REASON = '당신의 몸에서 튕겨져 나가 바닥에 떨어집니다.'
/** hold 정렬 반발 메시지(command3.c:922·931). */
const HOLD_BOUNCE_REASON = '당신의 손에서 튕겨져 나가 땅에 떨어집니다.'

/**
 * readyGate 입력 — object의 instance + template 무기 스탯 + 점유 슬롯 + 착용 주체 + 소유자 일치 여부.
 * isBoundOwner는 오라클 `strcmp(obj->key[2], ply->name)==0`(command3.c:820)의 명시 입력이다(배선 유예).
 */
export interface ReadyParams {
  readonly flags: string
  readonly type: number
  readonly wearflag: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly shotsmax: number
  readonly shotscur: number
  readonly questnum: number
  readonly instance: ObjectInstance
  readonly occupiedSlots: ReadonlySet<number>
  readonly actor: WearActor
  readonly isBoundOwner: boolean
}

/**
 * holdGate 입력 — object의 instance + template 스탯 + 점유 슬롯 + 착용 주체(class·alignment 사용).
 */
export interface HoldParams {
  readonly flags: string
  readonly type: number
  readonly wearflag: number
  readonly ndice: number
  readonly sdice: number
  readonly pdice: number
  readonly questnum: number
  readonly instance: ObjectInstance
  readonly occupiedSlots: ReadonlySet<number>
  readonly actor: WearActor
}

/**
 * 무기 장착(ready) 다층 게이트 — 오라클 command3.c ready()(라인 691~835)의 순서를 글자 그대로 이식한다.
 * 게이트는 첫 실패에서 즉시 반환한다. 실 인벤 이동·객체 파괴는 outcome만 반환하고 배선은 유예한다.
 */
export function readyGate(params: ReadyParams): WearOutcome {
  const { flags, type, wearflag, ndice, sdice, pdice, shotsmax, shotscur, questnum, instance, occupiedSlots, actor, isBoundOwner } =
    params
  const dmg = ndice * sdice + pdice
  const isWeaponEdge = type === SHARP || type === THRUST

  // ① WIELD 아님 — 무장 대상이 아니면 거부(command3.c:718).
  if (wearflag !== WIELD) {
    return { kind: 'rejected', reason: '당신은 그것을 무장할 수 없습니다.' }
  }

  // ② 마법사 무거운무기 제한 — dice-threshold(ONOMAG 아님!). SHARP/THRUST + dice합>14 + MAGE/CLERIC 거부.
  // 플래그 없는 dice 규칙이다(command3.c:723-728). questnum!==0·ONEWEV이면 우회.
  if (
    isWeaponEdge &&
    questnum === 0 &&
    !F_ISSET(flags, ONEWEV) &&
    dmg > MAGE_WEAPON_DICE_LIMIT &&
    (actor.class === MAGE || actor.class === CLERIC)
  ) {
    return { kind: 'rejected', reason: '도술사, 불제자는 사용할수 없습니다.' }
  }

  // ③ 성별 — SHARP/THRUST 조건부. ONOFEM+여성·ONOMAL+남성 거부(command3.c:730-740).
  if (isWeaponEdge && !genderAllowed(flags, actor.gender)) {
    return { kind: 'rejected', reason: '성별이 맞지 않습니다.' }
  }

  // ④ WIELD 슬롯 점유 — resolveSlot 1회 호출. null(슬롯19 점유)이면 거부, non-null이면 통과 시 재사용(command3.c:742).
  const slot = resolveSlot(WIELD, occupiedSlots)
  if (slot === null) {
    return { kind: 'rejected', reason: '당신은 이미 무장하고 있습니다.' }
  }

  // ⑤ OCLSEL — class<INVINCIBLE 게이트(command3.c:749-753).
  if (oclselBlocks(flags, actor.class)) {
    return { kind: 'rejected', reason: '당신의 직업에 맞지 않습니다.' }
  }

  // ⑥ 정렬 — OGOODO+정렬<-50·OEVILO+정렬>50이면 몸에서 튕겨 바닥 낙하(command3.c:755-773).
  if (!alignmentAllowed(flags, actor.alignment)) {
    return { kind: 'bounced', reason: READY_BOUNCE_REASON }
  }

  // ⑦ OSIZE — class<INVINCIBLE 게이트(command3.c:775-784).
  if (!sizeAllowed(flags, actor.race) && actor.class < INVINCIBLE) {
    return { kind: 'rejected', reason: '당신의 몸 크기와 맞지 않습니다.' }
  }

  // ⑧ dice-소각 — dice합>39 + questnum===0 + !ONEWEV이면 소각(command3.c:786-792).
  if (dmg > WEAPON_BURN_DICE_LIMIT && questnum === 0 && !F_ISSET(flags, ONEWEV)) {
    return { kind: 'burned', reason: READY_BURN_REASON }
  }

  // ⑨ shots-소각 — !ONEWEV + (shotsmax>600 || shotscur>600)이면 소각. questnum 무관(⑧과 비대칭, command3.c:793-798).
  if (!F_ISSET(flags, ONEWEV) && (shotsmax > WEAPON_SHOTS_LIMIT || shotscur > WEAPON_SHOTS_LIMIT)) {
    return { kind: 'burned', reason: READY_BURN_REASON }
  }

  // ⑩ shatter-crit 소각 — ONSHAT+OALCRT 동시면 소각(command3.c:799-803).
  // 플랜 T6.1 요약 초과, 오라클 충실.
  if (F_ISSET(flags, ONSHAT) && F_ISSET(flags, OALCRT)) {
    return { kind: 'burned', reason: READY_BURN_REASON }
  }

  // ⑪ 레벨 — check_dmg 직업별 감산 후 판정(command3.c:804-818).
  let checkDmg = dmg
  if (actor.class === FIGHTER) checkDmg -= FIGHTER_DMG_RELIEF
  if (actor.class === ASSASSIN || actor.class === THIEF) checkDmg -= ASSASSIN_THIEF_DMG_RELIEF
  if (actor.class === PALADIN || actor.class === RANGER) checkDmg -= PALADIN_RANGER_DMG_RELIEF
  if (
    actor.class < INVINCIBLE &&
    checkDmg > LEVEL_CHECK_DMG_THRESHOLD &&
    !F_ISSET(flags, ONEWEV) &&
    actor.level < checkDmg * LEVEL_DMG_MULTIPLIER &&
    questnum === 0
  ) {
    return { kind: 'rejected', reason: '당신의 능력으로는 사용할 수 없는 무기입니다.' }
  }

  // ⑫ ONEWEV 귀속 — 귀속템이며 소유자가 아니면 거부(command3.c:819-822).
  if (isPersonalBound(flags) && !isBoundOwner) {
    return { kind: 'rejected', reason: '다른 사람의 물건은 사용할 수 없습니다.' }
  }

  // 통과 — ④에서 얻은 slot(=WIELD_SLOT)으로 equipped 새 인스턴스(입력 불변).
  return { kind: 'equipped', object: { ...instance, equipped: true, slot } }
}

/**
 * 쥠(hold) 다층 게이트 — 오라클 command3.c hold()(라인 860~950)의 순서를 글자 그대로 이식한다.
 * 게이트는 첫 실패에서 즉시 반환한다. 통과 시 type과 무관하게 equipped+HELD 슬롯을 무조건 설정한다
 * (오라클 `ready[HELD-1]=obj`는 무조건이며, `type<ARMOR` 조건은 포트가 drop한 OWHELD 플래그 전용이다).
 */
export function holdGate(params: HoldParams): WearOutcome {
  const { flags, wearflag, ndice, sdice, pdice, questnum, instance, occupiedSlots, actor } = params
  const dmg = ndice * sdice + pdice

  // ① HELD/WIELD 아님 — 쥘 수 있는 대상이 아니면 거부(command3.c:887).
  if (wearflag !== HELD && wearflag !== WIELD) {
    return { kind: 'rejected', reason: '당신은 그것을 쥘 수 없습니다.' }
  }

  // ② 이벤트템/임무템 — OEVENT || questnum>0이면 거부(command3.c:891-894).
  if (F_ISSET(flags, OEVENT) || questnum > 0) {
    return { kind: 'rejected', reason: '당신은 그것을 쥘 수 없습니다.' }
  }

  // ③ 귀속템/임무템 — ONEWEV || questnum>0이면 거부(command3.c:895-898). questnum>0은 ②와 중복이나 오라클 충실.
  if (F_ISSET(flags, ONEWEV) || questnum > 0) {
    return { kind: 'rejected', reason: '당신은 그것을 쥘 수 없습니다.' }
  }

  // ④ HELD 슬롯 점유 — resolveSlot 1회 호출. null(슬롯16 점유)이면 거부, non-null이면 통과 시 재사용(command3.c:900).
  const slot = resolveSlot(HELD, occupiedSlots)
  if (slot === null) {
    return { kind: 'rejected', reason: '당신은 이미 다른것을 쥐고 있습니다.' }
  }

  // ⑤ 강력무기 — dice합>100이면 거부(command3.c:906).
  if (dmg > HELD_DICE_LIMIT) {
    return { kind: 'rejected', reason: '당신은 그것을 쥘 수 없습니다.' }
  }

  // ⑥ OCLSEL — class<INVINCIBLE 게이트(command3.c:913-917). 플랜 T6.2 요약 초과, 오라클 충실.
  if (oclselBlocks(flags, actor.class)) {
    return { kind: 'rejected', reason: '당신의 직업에 맞지 않습니다.' }
  }

  // ⑦ 정렬 — OGOODO+정렬<-50·OEVILO+정렬>50이면 손에서 튕겨 바닥 낙하(command3.c:919-937).
  // 플랜 T6.2 요약 초과, 오라클 충실.
  if (!alignmentAllowed(flags, actor.alignment)) {
    return { kind: 'bounced', reason: HOLD_BOUNCE_REASON }
  }

  // 통과 — ④에서 얻은 slot(=HELD−1=16)으로 equipped 새 인스턴스(입력 불변). type과 무관하게 무조건 설정.
  return { kind: 'equipped', object: { ...instance, equipped: true, slot } }
}
