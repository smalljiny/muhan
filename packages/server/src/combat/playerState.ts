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
  /** 클래스 인덱스(1-12) — 피해 분기(BARBARIAN/MAGE/CLERIC/INVINCIBLE)·PALADIN 정렬 보정에 소비. */
  readonly class: number
  /** 유효 힘(effectiveContext.effectiveStrength) — 피해 `bonus[str]` 항에 bonusOf로 소비. */
  readonly effectiveStrength: number
  /**
   * 유효 지능 — magic 에픽(#84) Caster.intBonus의 소싱 입력(bonusOf로 사전 계산). effectiveStrength가
   * effectiveContext에서 오는 것과 달리 EffectiveStatContext에 intelligence 슬롯이 없어(shared zod
   * 스키마·context 타입 불변 제약) character.stats[3]에서 직접 소싱한다 — #84엔 int-수정 장비가 없어
   * base==effective이며, #85가 실 effective 합성으로 정밀화한다(realm=[0,0,0,0] seam과 동일 패턴).
   */
  readonly effectiveIntelligence: number
  /** 파생 방어도(computeAc 결과). */
  readonly armor: number
  /** 파생 THAC0(computeThaco 결과). */
  readonly thaco: number
  /** 유효 민첩(effectiveContext.effectiveDexterity). */
  readonly dexterity: number
  /**
   * 플레이어 상태 플래그 — creature flags와 동일한 hex string 바이트 배열(원작에서 플레이어도
   * creature 구조체). PBLIND=42·PFEARS=43은 비트 인덱스 >31이라 number bitfield로 표현 불가하므로
   * hex string이 정본이다. F_ISSET(flags, bit)로 판정하며 신선한 플레이어는 빈 hex(상태 플래그 없음).
   */
  readonly flags: string
  /** 성향(PALADIN 정렬 보정에 Story 5가 소비). */
  readonly alignment: number
  /** 무기 데미지 서술자 — 미착용이면 null(맨손 분기). mdice(weapon)은 착용 시에만 소비. */
  readonly weapon: WeaponDamage | null
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
  /**
   * 무기 object flags(hex string) — 크리/불발 판정용(OALCRT=42 자동 크리, OCURSE=22 낙하 제외).
   * 옵셔널(additive non-breaking) — 미지정이면 빈 hex로 취급해 어느 플래그도 세팅되지 않은 것과 동일.
   */
  readonly flags?: string
}

/**
 * Character + 유효 스탯 컨텍스트 + 무기 데미지 서술자를 라이브 PlayerCombatState로 조립한다.
 *
 * armor/thaco는 반드시 computeAc/computeThaco로 파생한다(재구현 금지 — stats-core 소비).
 * base 필드는 character에서, dexterity/effectiveStrength는 effectiveContext에서, 무기는 weaponDamage에서
 * 취한다(미착용이면 null 전달). alignment는 character.alignment ?? 0, flags는 빈 hex(상태 플래그 없음),
 * nextAttackAt은 초기값 0. 새 객체를 반환한다.
 */
export function toPlayerCombatState(
  character: Character,
  effectiveContext: EffectiveStatContext,
  weaponDamage: WeaponDamage | null,
): PlayerCombatState {
  return {
    characterId: character._id,
    hpCurrent: character.hpCurrent,
    mpCurrent: character.mpCurrent,
    level: character.level,
    class: character.class,
    effectiveStrength: effectiveContext.effectiveStrength,
    // 오라클 능력치 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4.
    // #84엔 int-수정 장비가 없어 base==effective — #85가 실 effective 합성으로 대체한다.
    effectiveIntelligence: character.stats[3],
    armor: computeAc(effectiveContext),
    thaco: computeThaco(effectiveContext),
    dexterity: effectiveContext.effectiveDexterity,
    flags: '',
    alignment: character.alignment ?? 0,
    weapon: weaponDamage,
    nextAttackAt: 0,
  }
}
