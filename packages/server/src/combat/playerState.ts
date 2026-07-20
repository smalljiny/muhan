import { computeAc, computeThaco, type EffectiveStatContext, type Character } from 'shared'
import type { DiceSpec } from './dice.js'

/**
 * 라이브 플레이어 전투상태 — 세션 액터의 매-라운드 전투 입력·가변 상태를 담는다(플랜 D2/T4.1).
 *
 * 플레이어는 방-물질화 객체(CreatureInstance)가 아니라 세션 액터이므로 방 부착이 아닌
 * characterId-keyed 레지스트리(combatRegistry)로 관리한다. armor/thaco는 stats-core의
 * computeAc/computeThaco로 파생하며(재구현 금지), 무기 데미지 서술자는 중첩 `weapon`으로
 * 담아 `mdice(state.weapon, rng)`(DiceSpec 구조 호환)로 바로 소비한다.
 *
 * 가변 carve-out: coding-style immutability 원칙과 달리 이 객체는 **가변**이다. 전투 resolver가
 * hpCurrent/mpCurrent/nextAttackAt을 in-place로 차감·갱신하고, 레지스트리는 그 참조를 보유한다.
 * 조립 헬퍼(toPlayerCombatState)는 새 객체를 반환하지만(조립 자체는 불변), 반환 객체는 freeze하지
 * 않는다.
 */
export type PlayerCombatState = {
  readonly characterId: string
  /** 현재 HP — 전투가 in-place 차감(가변). */
  hpCurrent: number
  /** 현재 MP — 마법 소비가 in-place 차감(가변). */
  mpCurrent: number
  readonly level: number
  /** 파생 방어도(computeAc 결과). */
  readonly armor: number
  /** 파생 THAC0(computeThaco 결과). */
  readonly thaco: number
  /** 유효 민첩(effectiveContext.effectiveDexterity). */
  readonly dexterity: number
  /** 플레이어 상태 플래그 비트(PFEARS/PBLIND 등 명중 보정에 Story 5가 소비). */
  readonly flags: number
  /** 성향(PALADIN 정렬 보정에 Story 5가 소비). */
  readonly alignment: number
  /** 무기 데미지 서술자(ndice/sdice/pdice는 DiceSpec 호환 — mdice 직접 소비). */
  readonly weapon: WeaponDamage
  /**
   * LT_ATTCK 반격 쿨다운 게이트 — 다음 공격 도래 시각.
   * 몬스터 CreatureInstance.nextActionAt과 **구분되는 별도 필드**다(플레이어 세션 액터 타이머).
   */
  nextAttackAt: number
}

/**
 * 무기 데미지 서술자 — mdice가 읽는 DiceSpec(ndice/sdice/pdice)을 확장해 명중 보정·숙련도를 더한다.
 * `DiceSpec`을 명시적으로 확장해 mdice 소비 계약을 컴파일 시점에 고정한다(DiceSpec 필드 변경이
 * WeaponDamage에 자동 전파). 장비/무기 해소는 상위 입력(범위 밖) — 조립 헬퍼는 이 값을 그대로 이식한다.
 */
export type WeaponDamage = DiceSpec & {
  readonly adjustment: number
  readonly proficiency: number
}

/**
 * Character + 유효 스탯 컨텍스트 + 무기 데미지 서술자를 라이브 PlayerCombatState로 조립한다.
 *
 * armor/thaco는 반드시 computeAc/computeThaco로 파생한다(재구현 금지 — stats-core 소비).
 * base 필드는 character에서, dexterity는 effectiveContext에서, 무기는 weaponDamage에서 취한다.
 * alignment는 character.alignment ?? 0, flags/nextAttackAt은 초기값 0. 새 객체를 반환한다.
 */
export function toPlayerCombatState(
  character: Character,
  effectiveContext: EffectiveStatContext,
  weaponDamage: WeaponDamage,
): PlayerCombatState {
  return {
    characterId: character._id,
    hpCurrent: character.hpCurrent,
    mpCurrent: character.mpCurrent,
    level: character.level,
    armor: computeAc(effectiveContext),
    thaco: computeThaco(effectiveContext),
    dexterity: effectiveContext.effectiveDexterity,
    flags: 0,
    alignment: character.alignment ?? 0,
    weapon: weaponDamage,
    nextAttackAt: 0,
  }
}
