import type { CreatureInstance } from 'shared'
import type { PlayerCombatState } from './playerState.js'

/**
 * Combatant 어댑터 — 플레이어(세션 액터, PlayerCombatState)와 몬스터(방 물질화, CreatureInstance)를
 * 명중·피해 계산이 소비할 단일 operand로 통일한다(플랜 G1/G2, T5.1).
 *
 * 공통 표면(hpCurrent/armor/thaco/dexterity/flags/kind)만으로 명중 임계(hitThreshold)가 kind 비대칭을
 * 흡수한다. flags는 양측 hex string으로 통일해 `F_ISSET(combatant.flags, bit)` 단일 관용을 성립시킨다
 * (원작에서 플레이어도 creature 구조체라 flags 표현이 동일).
 *
 * 피해 계산은 kind별 추가 필드(플레이어=weapon/class/str, 크리처=ndice/sdice/pdice)를 요구하므로,
 * 공통 인터페이스를 부풀리지 않고 discriminated union으로 원본 참조(`state`/`instance`)를 담는다.
 * playerBaseDamage/monsterDamage가 이 참조에서 kind 고유 스탯을 읽는다.
 *
 * hpCurrent는 어댑트 시점 스냅샷(읽기 operand)이다. 피해 적용(in-place 차감)은 Story 8이 원본
 * 참조(state/instance)를 통해 수행한다 — Combatant는 스냅샷 뷰이므로 여기로 차감하지 않는다.
 */
type CombatantBase = {
  readonly hpCurrent: number
  readonly armor: number
  readonly thaco: number
  readonly dexterity: number
  readonly flags: string
}

export type PlayerCombatant = CombatantBase & {
  readonly kind: 'player'
  readonly state: PlayerCombatState
}

export type CreatureCombatant = CombatantBase & {
  readonly kind: 'creature'
  readonly instance: CreatureInstance
}

export type Combatant = PlayerCombatant | CreatureCombatant

export function toCombatant(source: PlayerCombatState): PlayerCombatant
export function toCombatant(source: CreatureInstance): CreatureCombatant
export function toCombatant(source: PlayerCombatState | CreatureInstance): Combatant {
  if ('characterId' in source) {
    return {
      kind: 'player',
      hpCurrent: source.hpCurrent,
      armor: source.armor,
      thaco: source.thaco,
      dexterity: source.dexterity,
      flags: source.flags,
      state: source,
    }
  }
  return {
    kind: 'creature',
    hpCurrent: source.hpcur,
    armor: source.armor,
    thaco: source.thaco,
    dexterity: source.dexterity,
    flags: source.flags,
    instance: source,
  }
}

/**
 * Combatant의 라이브 현재 hp를 **원본 참조**에서 읽는다(스냅샷 `hpCurrent`가 아님 — 그건 어댑트 시점
 * 값이라 차감 후 stale). 근접(resolveAttack)·주문(offensiveSpell) 데미지가 공유하는 판독 seam으로,
 * kind-dispatch를 이 추상 소유지로 접어 소비자별 open-code 중복을 없앤다(파일 상단 주석의 예고 이행).
 */
export function combatantHp(target: Combatant): number {
  return target.kind === 'creature' ? target.instance.hpcur : target.state.hpCurrent
}

/** Combatant 원본 참조에 피해를 in-place 차감한다(worldGraph 승인 carve-out — 근접·주문 데미지 공용). */
export function applyCombatantDamage(target: Combatant, damage: number): void {
  if (target.kind === 'creature') {
    target.instance.hpcur -= damage
  } else {
    target.state.hpCurrent -= damage
  }
}
