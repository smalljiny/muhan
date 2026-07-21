import { computeHpMax, computeMpMax, type EffectiveStatContext } from 'shared'

/**
 * 현재 Character 스키마 버전. hpCurrent/mpCurrent/level을 required로 도입한 v2가 최신이다.
 * v1 문서(이 3필드 부재)는 load 직전 backfillCharacterV2가 승격한다.
 */
export const CURRENT_CHARACTER_SCHEMA_VERSION = 2

/**
 * computeHpMax/computeMpMax는 characterClass·level만 판독하지만 EffectiveStatContext는
 * 8필드 required다. 판독하지 않는 6필드는 더미(숫자 0, protection: false)로 채운다.
 */
function vitalsContext(characterClass: number, level: number): EffectiveStatContext {
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
 * class·level로 최대치 기준 vitals 시드를 계산한다. 생성 경로(createCharacter)와 v1 backfill이
 * 공유하는 단일 산술 출처 — 현재 HP/MP를 최대치로 시딩한다(신규·승격 문서는 만피/만마).
 */
export function seedVitals(
  characterClass: number,
  level: number,
): { hpCurrent: number; mpCurrent: number } {
  const context = vitalsContext(characterClass, level)
  return { hpCurrent: computeHpMax(context), mpCurrent: computeMpMax(context) }
}

/**
 * v1 raw 문서를 v2로 승격하는 순수 헬퍼 — characterSchema.parse 직전에 통과시킨다.
 *
 * strict parse는 hpCurrent/mpCurrent/level이 없는 v1 문서를 거부하므로, load 경로(findById·
 * findByAccount)는 parse 이전에 raw 문서를 이 헬퍼로 승격한다. schemaVersion>=2 문서는 재계산
 * 없이 그대로 반환한다(passthrough). 원본을 변형하지 않고 스프레드로 새 객체를 반환한다.
 */
export function backfillCharacterV2(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= CURRENT_CHARACTER_SCHEMA_VERSION) return raw

  const characterClass = typeof raw.class === 'number' ? raw.class : 0
  const level = 1
  return {
    ...raw,
    level,
    ...seedVitals(characterClass, level),
    schemaVersion: CURRENT_CHARACTER_SCHEMA_VERSION,
  }
}
