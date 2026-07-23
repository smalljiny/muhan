import { type Character } from 'shared'
import { F_SET, PPOISN, PDISEA, PBLIND } from '../world/hexFlags.js'

/**
 * statusEffects — 명명 상태이상(Story 1 characterSchema.statusEffects)의 부여·만료 순수 헬퍼와
 * 명명 필드 → combat flag hex 뷰 투영.
 *
 * 만료 관례: statusEffects의 until은 befuddledUntil/charmedUntil과 동일한 절대-틱 만료다(잔여-틱
 * 아님). 현재 틱 now를 파라미터로 받아 `until < now`이면 비활성, `until >= now`이면 활성으로 본다.
 *
 * 투영 계약: Character에는 combat flags 필드가 없다(flags는 라이브 PlayerCombatState 소관). 따라서
 * 병합 대상이 없어, ZERO_FLAGS(16자 0)에서 활성 명명 상태이상 비트만 F_SET한 fresh hex를 반환한다.
 * 소비측은 combat의 F_ISSET(projectedHex, PBLIND) 관용을 그대로 써서 판독한다(#99 라이브 배선 유예 —
 * 이 모듈은 투영 함수만 노출하고 attackStats.ts:29·combatTick.ts:142 소비측을 건드리지 않는다).
 *
 * immutability: 모든 grant는 입력 Character·기존 statusEffects 객체를 변형하지 않고 새 객체를 반환한다.
 */

/** 8바이트(16자) 0 기반 flag hex. PDISEA=41·PBLIND=42가 byte 5에 안착하도록 full-width에서 시작한다. */
const ZERO_FLAGS = '0000000000000000'

/** poison until/interval을 세팅한 새 Character를 반환한다(기존 statusEffects 병합, 입력 불변). */
export function grantPoison(character: Character, until: number, interval: number): Character {
  return {
    ...character,
    statusEffects: { ...character.statusEffects, poison: { until, interval } },
  }
}

/** disease until/interval을 세팅한 새 Character를 반환한다(기존 statusEffects 병합, 입력 불변). */
export function grantDisease(character: Character, until: number, interval: number): Character {
  return {
    ...character,
    statusEffects: { ...character.statusEffects, disease: { until, interval } },
  }
}

/** blind until을 세팅한 새 Character를 반환한다(간격 없음 — 시야 차단은 주기 피해가 아니다). */
export function grantBlind(character: Character, until: number): Character {
  return {
    ...character,
    statusEffects: { ...character.statusEffects, blind: { until } },
  }
}

/** 절대-틱 만료 판정 — 효과가 존재하고 until >= now이면 활성. */
function isActive(effect: { until: number } | undefined, now: number): boolean {
  return effect !== undefined && effect.until >= now
}

/** poison이 활성(만료 안 됨)인지. */
export function isPoisonActive(character: Character, now: number): boolean {
  return isActive(character.statusEffects?.poison, now)
}

/** disease가 활성(만료 안 됨)인지. */
export function isDiseaseActive(character: Character, now: number): boolean {
  return isActive(character.statusEffects?.disease, now)
}

/** blind가 활성(만료 안 됨)인지. */
export function isBlindActive(character: Character, now: number): boolean {
  return isActive(character.statusEffects?.blind, now)
}

/**
 * 명명 상태이상 → combat flag hex 뷰 투영. 활성(만료 안 된) 효과만 대응 P-flag 비트를 세팅한다:
 * poison→PPOISN(16), disease→PDISEA(41), blind→PBLIND(42). 만료 효과는 제외한다.
 * 반환 hex는 F_ISSET로 판독 가능하다(소비측의 combat flag 관용 무파괴).
 */
export function projectStatusFlags(character: Character, now: number): string {
  let hex = ZERO_FLAGS
  if (isPoisonActive(character, now)) hex = F_SET(hex, PPOISN)
  if (isDiseaseActive(character, now)) hex = F_SET(hex, PDISEA)
  if (isBlindActive(character, now)) hex = F_SET(hex, PBLIND)
  return hex
}
