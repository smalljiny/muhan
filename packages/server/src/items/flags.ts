/**
 * object 플래그 게이트 predicate substrate — 착용 게이트(Story 5/6)가 소비할 object 플래그 비트 상수와
 * 게이트 predicate(직업·성별·정렬·크기·저주·결혼·귀속)를 hex F_ISSET 위에 정의한다.
 *
 * 이 모듈은 순수 predicate substrate만 제공한다 — ARMOR type 검사·게이트 순서·INVINCIBLE 전역 우회
 * 조립은 Story 5/6 소관이다. 각 predicate는 flags(hex string)를 읽기만 하며 변형하지 않는다.
 *
 * 오라클: 비트 값은 mtype.h, 게이트 로직은 command3.c(착용 명령 wear).
 */

import { F_ISSET, OCURSE } from '../world/hexFlags.js'
import { MAGE, CLERIC, INVINCIBLE } from '../combat/constants.js'

// ── object 플래그 비트 상수(mtype.h 검증) ────────────────────────────────────
// OCURSE(22)는 world/hexFlags.js에서 import — 여기서 중복 정의하지 않는다.
/** 마법 클래스(MAGE·CLERIC) 착용 금지 — ONOMAG(command3.c:61). */
export const ONOMAG = 10
/** 선 정렬(-50 미만) 착용 금지 — OGOODO(command3.c:143). */
export const OGOODO = 12
/** 악 정렬(50 초과) 착용 금지 — OEVILO(command3.c:152). */
export const OEVILO = 13
/** 마법 부여됨(enchanted) 표식 — OENCHA. */
export const OENCHA = 14
/** 크기 게이트 고비트 — OSIZE1(command3.c:168, ×2 가중). */
export const OSIZE1 = 19
/** 크기 게이트 저비트 — OSIZE2(command3.c:168, ×1 가중). */
export const OSIZE2 = 20
/** 랜덤 인챈트 대상 — ORENCH(착용 시 rand_enchant 적용). */
export const ORENCH = 21
/** 착용 가능 표식 — OWEARS. */
export const OWEARS = 23
/** 남성 착용 금지 — ONOMAL(command3.c). 명명 주의: 남성을 거부한다. */
export const ONOMAL = 26
/** 여성 착용 금지 — ONOFEM(command3.c). 명명 주의: 여성을 거부한다. */
export const ONOFEM = 27
/** 클래스 선택 게이트 — OCLSEL(command3.c:162). 세트 시 (OCLSEL+class) 비트가 있어야 허용. */
export const OCLSEL = 31
/** 무기 미파쇄 표식 — ONSHAT(mtype.h:517 `weapon will never shatter`). OALCRT와 동시 세트 시 ready 소각(command3.c:800). */
export const ONSHAT = 41
/** 결혼 게이트 — OMARRI(착용 조건에 배우자 상태 요구). */
export const OMARRI = 45
/** 이벤트 아이템 — OEVENT. */
export const OEVENT = 46
/** 착용 유지(wield held) — OWHELD. */
export const OWHELD = 49
/** 개인 귀속(personal bound) — ONEWEV(신규 이벤트 귀속). */
export const ONEWEV = 50

// ── 종족 상수(mtype.h RACE, 코드베이스에 named 상수 부재 → 여기 정의) ─────────
/** 드워프. */
export const DWARF = 1
/** 엘프. */
export const ELF = 2
/** 하프엘프. */
export const HALFELF = 3
/** 호빗. */
export const HOBBIT = 4
/** 인간. */
export const HUMAN = 5
/** 오크. */
export const ORC = 6
/** 하프자이언트. */
export const HALFGIANT = 7
/** 노움. */
export const GNOME = 8

// ── 성별 인코딩 ──────────────────────────────────────────────────────────────
/** 남성. */
export const MALE = 1
/** 여성. */
export const FEMALE = 2

// ── 크기 게이트 조합 값(OSIZE1×2 + OSIZE2×1) ─────────────────────────────────
const SIZE_UNRESTRICTED = 0
const SIZE_SMALL = 1
const SIZE_MEDIUM = 2
const SIZE_LARGE = 3

const SMALL_RACES: readonly number[] = [GNOME, HOBBIT, DWARF]
const MEDIUM_RACES: readonly number[] = [HUMAN, ELF, HALFELF, ORC]

/**
 * 성별 착용 허용 — 오라클 command3.c:67-74.
 * ONOFEM 세트 + 여성이면 거부, ONOMAL 세트 + 남성이면 거부. 그 외 허용.
 */
export function genderAllowed(flags: string, gender: number): boolean {
  if (F_ISSET(flags, ONOFEM) && gender === FEMALE) return false
  if (F_ISSET(flags, ONOMAL) && gender === MALE) return false
  return true
}

/**
 * 정렬 착용 허용 — 오라클 command3.c:143·152.
 * OGOODO 세트 + 정렬 < -50이면 거부, OEVILO 세트 + 정렬 > 50이면 거부. 그 외 허용.
 */
export function alignmentAllowed(flags: string, alignment: number): boolean {
  if (F_ISSET(flags, OGOODO) && alignment < -50) return false
  if (F_ISSET(flags, OEVILO) && alignment > 50) return false
  return true
}

/**
 * 직업 착용 허용 — 오라클 command3.c:61-62·162-163.
 * ONOMAG 세트 + (MAGE|CLERIC)이면 거부. OCLSEL 세트 시 (OCLSEL+class) 비트가 없고
 * class < INVINCIBLE이면 거부(INVINCIBLE 이상은 우회). 그 외 허용.
 */
export function classAllowed(flags: string, characterClass: number): boolean {
  if (F_ISSET(flags, ONOMAG) && (characterClass === MAGE || characterClass === CLERIC)) {
    return false
  }
  if (
    F_ISSET(flags, OCLSEL) &&
    !F_ISSET(flags, OCLSEL + characterClass) &&
    characterClass < INVINCIBLE
  ) {
    return false
  }
  return true
}

/**
 * OCLSEL 직업선택 게이트 단독 판정 — 오라클 command3.c:162-163·749-753·913-917.
 * OCLSEL 세트 + (OCLSEL+class) 비트 없음 + class < INVINCIBLE이면 착용 거부(true 반환).
 * classAllowed는 ONOMAG를 융합하지만 wear/ready/hold 게이트는 OCLSEL을 ONOMAG와 다른 순서 위치에서
 * 검사하므로(융합 시 순서 붕괴), 이 OCLSEL 전용 predicate를 세 게이트가 공유해 INVINCIBLE 우회를 단일 출처로 둔다.
 */
export function oclselBlocks(flags: string, characterClass: number): boolean {
  return (
    F_ISSET(flags, OCLSEL) &&
    !F_ISSET(flags, OCLSEL + characterClass) &&
    characterClass < INVINCIBLE
  )
}

/**
 * 크기 착용 허용 — 오라클 command3.c:168-184.
 * i = OSIZE1?×2 + OSIZE2?×1. 0=무제한, 1=소형, 2=중형, 3=대형별 허용 종족 집합을 게이트한다.
 * INVINCIBLE 전역 우회는 여기 넣지 않는다(Story 5 게이트 조립 소관).
 */
export function sizeAllowed(flags: string, race: number): boolean {
  const i = (F_ISSET(flags, OSIZE1) ? 1 : 0) * 2 + (F_ISSET(flags, OSIZE2) ? 1 : 0)
  switch (i) {
    case SIZE_UNRESTRICTED:
      return true
    case SIZE_SMALL:
      return SMALL_RACES.includes(race)
    case SIZE_MEDIUM:
      return MEDIUM_RACES.includes(race)
    case SIZE_LARGE:
      return race === HALFGIANT
    default:
      return true
  }
}

/** 저주 여부 — F_ISSET(OCURSE). 탈착 시점 substrate(착용 게이트는 저주 미소비). */
export function isCursed(flags: string): boolean {
  return F_ISSET(flags, OCURSE)
}

/** 개인 귀속 여부 — F_ISSET(ONEWEV). */
export function isPersonalBound(flags: string): boolean {
  return F_ISSET(flags, ONEWEV)
}

/** 결혼 게이트 여부 — F_ISSET(OMARRI). */
export function isMarriageGated(flags: string): boolean {
  return F_ISSET(flags, OMARRI)
}

/** 랜덤 인챈트 대상 여부 — F_ISSET(ORENCH). */
export function needsRandEnchant(flags: string): boolean {
  return F_ISSET(flags, ORENCH)
}
