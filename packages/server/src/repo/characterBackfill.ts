import { computeHpMax, computeMpMax, neededExp, type EffectiveStatContext } from 'shared'

/**
 * 현재 Character 스키마 버전. experience를 required로 도입한 v3가 최신이다.
 * v1 문서(vitals·level 부재)는 backfillCharacterV2가, v2 문서(experience 부재)는
 * backfillCharacterV3가 load 직전 순차 승격한다(합성 체인 V3∘V2). 생성 경로(createCharacter)와
 * 이 상수를 공유해 버전 드리프트를 차단한다.
 *
 * stepwise 마이그레이션 규약: 각 스텝 함수(V2·V3)의 진입 가드와 출구 스탬프는 자기 리터럴
 * 버전에 매인다(CURRENT 참조 금지). CURRENT가 다음 버전으로 오르면 이전 스텝이 자기 대상
 * 문서를 지나쳐 vitals/level을 silent 클로버하는 회귀를 막는 불변식이다.
 */
export const CURRENT_CHARACTER_SCHEMA_VERSION = 3

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
 * v1 raw 문서를 v2로 승격하는 순수 스텝 헬퍼 — characterSchema.parse 직전 합성 체인의 첫 단계다.
 *
 * strict parse는 hpCurrent/mpCurrent/level이 없는 v1 문서를 거부하므로, load 경로(findById·
 * findByAccount)는 parse 이전에 raw 문서를 이 헬퍼로 승격한다. schemaVersion>=2 문서는 재계산
 * 없이 그대로 반환한다(passthrough). 원본을 변형하지 않고 스프레드로 새 객체를 반환한다.
 *
 * 진입 가드·출구 스탬프는 리터럴 2에 매인다(CURRENT 참조 금지) — CURRENT가 3으로 오른 뒤에도
 * 이 스텝은 v2 문서를 통과시켜(재시딩·level 클로버 없이) V3에 넘겨야 하기 때문이다.
 */
export function backfillCharacterV2(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= 2) return raw

  const characterClass = typeof raw.class === 'number' ? raw.class : 0
  const level = 1
  return {
    ...raw,
    level,
    ...seedVitals(characterClass, level),
    schemaVersion: 2,
  }
}

/**
 * v2 raw 문서를 v3로 승격하는 순수 스텝 헬퍼 — 합성 체인의 두 번째 단계다.
 *
 * strict parse는 experience가 없는 v2 문서를 거부하므로 parse 이전에 experience를 시딩한다.
 * level 정합 시딩: level L 도달 최소 누적 exp = neededExp(L-1)이므로 `level<=1 ? 0 : neededExp(level-1)`.
 * needed_exp 테이블은 재전사하지 않고 shared의 neededExp 함수를 단일 출처로 소비한다.
 *
 * 진입 가드·출구 스탬프는 리터럴 3에 매인다. schemaVersion>=3 문서는 experience 재계산 없이
 * 그대로 반환한다(passthrough — 이미 승급으로 갱신된 실제 exp를 neededExp로 덮어쓰지 않는다).
 * 원본을 변형하지 않고 스프레드로 새 객체를 반환한다. level은 V2 통과 후 항상 존재하지만,
 * 직접 호출·malformed 입력 방어를 위해 V2의 class 판독과 대칭으로 typeof 가드를 둔다.
 */
export function backfillCharacterV3(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= 3) return raw

  const level = typeof raw.level === 'number' ? raw.level : 1
  const experience = level <= 1 ? 0 : neededExp(level - 1)
  return {
    ...raw,
    experience,
    schemaVersion: 3,
  }
}
