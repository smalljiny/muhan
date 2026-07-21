import { computeHpMax, computeMpMax } from '../stats/derived.js'
import type { EffectiveStatContext } from '../stats/context.js'
import type { Character } from '../schema/character.js'

/**
 * progression/maxResolvers — HP/MP 최대치의 단일 소비 지점(D2). stats-core 폐형
 * (`computeHpMax`/`computeMpMax`)과 초인(CARETAKER) 오버라이드를 한 래퍼로 통합한다.
 *
 * 최대치는 **저장하지 않고 compute-on-read**한다 — Character의 `class`·`level`만으로
 * 매 판독 시 파생한다. 능력치는 HP/MP 폐형에 불필요하므로 컨텍스트 더미로 채운다.
 * 레벨업·강등·재생·승급(Story 4·5·7·8)이 이 함수와 `clampVital`을 공유 소비한다.
 */

/** CARETAKER(초인) 클래스 인덱스(mtype.h 정본). 폐형을 오버라이드하는 유일한 클래스다. */
const CARETAKER = 10

/** 초인 HP 최대치 고정값(레벨 무관). */
const CARETAKER_HP_MAX = 800

/** 초인 MP 최대치 고정값(레벨 무관). */
const CARETAKER_MP_MAX = 600

/**
 * computeHpMax/computeMpMax는 characterClass·level만 판독하지만 EffectiveStatContext는
 * 8필드 required다. 판독하지 않는 6필드는 더미(숫자 0, protection: false)로 채운다.
 * server의 characterBackfill.vitalsContext와 동일 패턴이나, shared→server 역참조를
 * 피하려 여기 인라인한다.
 */
function closedFormContext(characterClass: number, level: number): EffectiveStatContext {
  return {
    effectiveDexterity: 0,
    effectiveStrength: 0,
    equipArmor: 0,
    protection: false,
    characterClass,
    level,
    weaponAdjustment: 0,
    weaponProficiency: 0,
  }
}

/**
 * 캐릭터의 HP 최대치를 반환한다. CARETAKER(class 10)이면 레벨과 무관하게 800 고정,
 * 그 외 모든 클래스는 `computeHpMax` 폐형에 위임한다. INVINCIBLE(class 9)은 오버라이드가
 * 아니라 폐형(400+성장)을 그대로 따른다.
 *
 * `class`·`level`만 필요하므로 구조적 subset으로 받는다 — 전체 Character도 할당 가능하다.
 */
export function resolveHpMax(char: Pick<Character, 'class' | 'level'>): number {
  if (char.class === CARETAKER) return CARETAKER_HP_MAX
  return computeHpMax(closedFormContext(char.class, char.level))
}

/**
 * 캐릭터의 MP 최대치를 반환한다. CARETAKER(class 10)이면 레벨과 무관하게 600 고정,
 * 그 외 모든 클래스는 `computeMpMax` 폐형에 위임한다. INVINCIBLE(class 9)은 오버라이드가
 * 아니라 폐형을 그대로 따른다.
 */
export function resolveMpMax(char: Pick<Character, 'class' | 'level'>): number {
  if (char.class === CARETAKER) return CARETAKER_MP_MAX
  return computeMpMax(closedFormContext(char.class, char.level))
}

/**
 * `hpCurrent <= resolveHpMax`(및 mp 대칭) 불변식을 유지하는 클램프 헬퍼.
 * 초과분을 max로 내린다. 레벨업·강등·재생·승급이 공유 소비한다.
 *
 * 음수 방어는 하지 않는다(단순 Math.min) — schema에서 hpCurrent/mpCurrent가 min(0)이라
 * 음수 입력은 비정상이며 소비자 책임이다.
 */
export function clampVital(current: number, max: number): number {
  return Math.min(current, max)
}
