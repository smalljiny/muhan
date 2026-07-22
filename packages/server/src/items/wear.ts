/**
 * 방어구 착용(wear) 다층 게이트 — 오라클 command3.c wear()(라인 52~194)의 게이트 순서를
 * 글자 그대로 이식한 순수 함수. 실 인벤 이동·객체 파괴는 outcome만 반환하고 배선은 유예한다.
 *
 * 게이트는 첫 실패에서 즉시 반환한다. questnum·ONEWEV(flags)를 반드시 스레드해야 소각·레벨
 * 게이트가 정확히 발화한다. 저주(OCURSE)는 게이트에 포함하지 않는다 — 저주는 탈착 시점 판정이다.
 */

import type { ObjectInstance } from 'shared'
import { F_ISSET } from '../world/hexFlags.js'
import { MAGE, CLERIC, INVINCIBLE } from '../combat/constants.js'
import { ARMOR, BODY, WIELD, HELD, resolveSlot } from './taxonomy.js'
import {
  ONOMAG,
  OCLSEL,
  ONEWEV,
  genderAllowed,
  isMarriageGated,
  alignmentAllowed,
  sizeAllowed,
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
  if (
    F_ISSET(flags, OCLSEL) &&
    !F_ISSET(flags, OCLSEL + actor.class) &&
    actor.class < INVINCIBLE
  ) {
    return { kind: 'rejected', reason: '당신의 직업에 맞지 않습니다.' }
  }

  // ⑩ OSIZE — class<INVINCIBLE 게이트. sizeAllowed는 INVINCIBLE 우회를 담지 않으므로 외부에서 감싼다(command3.c:165-184).
  if (!sizeAllowed(flags, actor.race) && actor.class < INVINCIBLE) {
    return { kind: 'rejected', reason: '당신 몸에 맞지 않습니다.' }
  }

  // 통과 — ⑥에서 얻은 slot으로 equipped 새 인스턴스(입력 불변).
  return { kind: 'equipped', object: { ...instance, equipped: true, slot } }
}
