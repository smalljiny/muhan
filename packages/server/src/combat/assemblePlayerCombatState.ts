import type { EffectiveStatContext } from 'shared'
import { findWieldedPair, projectEquipStats, type EquippedPair } from '../items/equipStats.js'
import { pairObjects } from '../items/objectPairing.js'
import type { ObjectTemplateIndex } from '../items/objectTemplate.js'
import type { LiveCharacter } from '../world/liveCharacterRegistry.js'
import { F_ISSET, PPROTE } from '../world/hexFlags.js'
import { toPlayerCombatState, type PlayerCombatState, type WeaponDamage } from './playerState.js'

/**
 * LiveCharacter → PlayerCombatState 조립기 — 세션 액터의 라이브 상태에서 전투 입력을 파생한다.
 *
 * `liveCharacterRegistry`는 `combat/`을 import하지 않는다(그 모듈 JSDoc의 분리 결정). 그 반대
 * 방향인 이 모듈이 두 계층을 잇는 어댑터이며, **순수 함수**다 — 시각(`now`)·레지스트리·저장소를
 * 만지지 않고 입력만으로 결정된다. `flags` hex도 합성하지 않고 주입받는다(`toPlayerCombatState`의
 * 같은 규약을 그대로 잇는다 — 합성 주체는 배선 계층의 `composeCharacterFlags(character, now)`다).
 *
 * 산술은 하나도 소유하지 않는다. armor/thaco는 `toPlayerCombatState`가 stats-core resolver로
 * 파생하고(이 모듈은 그 resolver를 직접 부르지 않는다), 장비 기여(equipArmor·weaponAdjustment)는
 * `projectEquipStats`가 만든다. 이 모듈은 그 seam들의 입력을 조립할 뿐이다.
 *
 * ## 설계 결정 D1 — 능력치 합성 헬퍼를 경유하지 않고 base 능력치를 직접 싣는다
 *
 * `EffectiveStatContext`의 `effective*` 필드는 "base + 수정자 합성이 끝난 값"이다. shared stats의
 * 합성 헬퍼를 쓰려면 수정자 목록이 있어야 하는데, 현 시점 이 프로젝트에 능력치를 수정하는 항이
 * **0개**다 — 장비 투영(`projectEquipStats`)은 armor·명중 보정·숙련만 내놓고 힘/민첩을 건드리지
 * 않으며, 버프 P-flag도 능력치 수정자를 만들지 않는다. 즉 합성 헬퍼를 경유해도 항상 base를 그대로
 * 돌려받는 항등 호출이라, 빈 수정자 배열을 지어내 넘기는 대신 base 능력치를 직접 싣는다. 능력치
 * 수정 효과(마법·저주 장비)가 실제로 생기는 시점에 이 자리에 합성을 넣는다.
 *
 * ## 알려진 divergence D2 — `weapon.proficiency`가 0 고정
 *
 * 오라클은 무기 종류별 숙련도(`creature.proficiency[5]`)를 영속화해 명중·피해에 반영한다. 그
 * 영속 필드가 아직 `Character` 스키마에 없어 여기서는 `proficiency: 0`을 싣고, 같은 이유로
 * `projectEquipStats(..., 0)`으로 `weaponProficiency`도 0을 넘긴다. 결과적으로 모든 플레이어가
 * 숙련 보너스 0인 상태로 계산된다 — 숙련도 영속화가 붙는 시점에 두 자리를 함께 교체한다.
 *
 * ## 알려진 divergence D11 — `PUPDMG` 미영속 → 초인 다중공격이 항상 1타
 *
 * `resolveAttack`은 `state.flags`의 `PUPDMG`를 읽어 `multiAttackCount`를 정한다. 그런데 이 모듈이
 * 싣는 `flags`의 유일한 생산자인 `composeCharacterFlags`는 **타이머 보유 효과 전용**이라
 * `PUPDMG`에 영속 경로가 없고 영원히 0을 반환한다(`character/flags.ts` 헤더의 파티션 표). 즉
 * 초인 다중공격은 배선된 순간부터 구조적으로 미발화한다 — 값이 틀린 것이 아니라 입력이 없다.
 * `PUPDMG` 영속화가 붙기 전에는 이 모듈 출력으로 다중공격을 기대하면 안 된다(#121 스펙 D11).
 */

/**
 * D2 divergence의 단일 출처 — 무기 숙련도 영속 필드가 없어 싣는 값이다.
 *
 * 두 자리(`weapon.proficiency`·`projectEquipStats`의 `weaponProficiency`)가 같은 divergence라
 * 상수 하나로 묶는다. 숙련도 영속화가 붙는 날 이 상수를 실값으로 바꾸면 두 자리가 함께 움직인다 —
 * 리터럴 0을 두 곳에 흩어 두면 한쪽만 고쳐 명중과 피해의 숙련 기준이 갈릴 수 있다.
 */
const UNPERSISTED_PROFICIENCY = 0

/**
 * 재조립 시 이월할 가변 상태 — 전투 중 in-place로 갱신되는 3필드다.
 *
 * 재조립(장비 교체·버프 만료로 armor/thaco가 바뀔 때)은 캐릭터 문서에서 값을 다시 읽으므로,
 * 진행 중인 전투의 현재 HP/MP와 공격 쿨다운이 조용히 되돌아간다. 그 3필드만 넘겨 유지한다(D4).
 */
export type CombatStateCarry = Pick<PlayerCombatState, 'hpCurrent' | 'mpCurrent' | 'nextAttackAt'>

/**
 * 등록된 전투상태에서 이월분을 뽑는다 — `CombatStateCarry` 필드 목록의 유일한 생산자다.
 *
 * 호출부가 `{ hpCurrent, mpCurrent, nextAttackAt }`을 손으로 적으면 이월 대상이 늘 때 타입만 넓어지고
 * 값은 조용히 빠진다(`assemblePlayerCombatState` 본문이 목록을 안 적는 것과 같은 이유). 생산자를
 * 여기 하나로 모아 타입과 값이 함께 움직이게 한다.
 *
 * 미등록(최초 조립) 분기는 호출부에 남긴다 — `undefined` 판정은 레지스트리 조회의 관심사다.
 */
export function toCarry(state: PlayerCombatState): CombatStateCarry {
  return {
    hpCurrent: state.hpCurrent,
    mpCurrent: state.mpCurrent,
    nextAttackAt: state.nextAttackAt,
  }
}

/**
 * WIELD 슬롯 착용 무기를 `WeaponDamage`로 해소한다. 미착용이면 `null`(맨손 분기).
 *
 * 착용 판정을 복제하지 않고 `findWieldedPair`에 위임한다 — `projectEquipStats`가 만드는
 * `weaponAdjustment`와 여기서 만드는 `weapon`이 **같은 아이템**을 설명해야 하고, 그 보장을
 * 주석이 아니라 공유 함수가 진다(근거는 `findWieldedPair` JSDoc).
 */
function resolveWieldedWeapon(paired: readonly EquippedPair[]): WeaponDamage | null {
  const wield = findWieldedPair(paired)
  if (wield === undefined) return null
  const { ndice, sdice, pdice, adjustment, flags } = wield.template
  return { ndice, sdice, pdice, adjustment, proficiency: UNPERSISTED_PROFICIENCY, flags }
}

/**
 * 라이브 캐릭터에서 전투상태를 조립한다. 입력을 변형하지 않고 새 객체를 반환한다.
 *
 * @param live 라이브 캐릭터 엔트리(캐릭터 문서 + 소유 오브젝트 인스턴스).
 * @param objectTemplates objnum → 템플릿 인덱스. 미해소 인스턴스는 조용히 빠진다(`pairObjects` 정책).
 * @param flags P-flag hex 스냅샷. 배선 계층이 `composeCharacterFlags(character, now)`로 합성해 주입한다.
 * @param carry 이월할 가변 3필드. 최초 조립에는 생략한다(캐릭터 문서 HP/MP + nextAttackAt 0).
 */
export function assemblePlayerCombatState(
  live: LiveCharacter,
  objectTemplates: ObjectTemplateIndex,
  flags: string,
  carry?: CombatStateCarry,
): PlayerCombatState {
  const { character } = live
  const paired = pairObjects(live.inventory, objectTemplates)
  const equipContribution = projectEquipStats(paired, UNPERSISTED_PROFICIENCY)

  const effectiveContext: EffectiveStatContext = {
    // spread를 **맨 앞**에 둔다 — 장비 기여가 나중에 능력치 필드로 넓어져도 아래 명시 필드를
    // 조용히 덮어쓰지 못한다(명시가 항상 이긴다). 지금은 키가 겹치지 않아 순서가 무해하지만,
    // 겹치는 날 사고가 나는 쪽 순서를 굳이 남겨 둘 이유가 없다.
    ...equipContribution,
    // 오라클 능력치 튜플 순서: strength0·dexterity1·constitution2·intelligence3·piety4.
    // D1 — 능력치 수정자가 0개라 base가 곧 effective다.
    effectiveStrength: character.stats[0],
    effectiveDexterity: character.stats[1],
    protection: F_ISSET(flags, PPROTE),
    characterClass: character.class,
    level: character.level,
  }

  const state = toPlayerCombatState(
    character,
    effectiveContext,
    resolveWieldedWeapon(paired),
    flags,
  )
  // 필드 목록을 본문에 다시 적지 않는다 — CombatStateCarry가 이월 대상의 단일 출처이므로
  // 이월 필드가 늘어도 타입만 고치면 된다(본문에 나열하면 타입만 넓히고 값은 조용히 버려진다).
  return carry === undefined ? state : { ...state, ...carry }
}
