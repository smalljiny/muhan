import { computeHpMax, computeMpMax, neededExp, type EffectiveStatContext } from 'shared'

/**
 * 현재 Character 스키마 버전. alignment를 required로 승격한 v6가 최신이다.
 * v1 문서(vitals·level 부재)는 backfillCharacterV2가, v2 문서(experience 부재)는
 * backfillCharacterV3가, v3 문서는 backfillCharacterV4가, v4 문서(spells·realm 부재)는
 * backfillCharacterV5가, v5 문서(alignment 부재)는 backfillCharacterV6가 load 직전 순차
 * 승격한다(합성 체인 V6∘V5∘V4∘V3∘V2). 생성 경로(createCharacter)와 이 상수를 공유해
 * 버전 드리프트를 차단한다.
 *
 * stepwise 마이그레이션 규약: 각 스텝 함수(V2·V3·V4·V5·V6)의 진입 가드와 출구 스탬프는 자기 리터럴
 * 버전에 매인다(CURRENT 참조 금지). CURRENT가 다음 버전으로 오르면 이전 스텝이 자기 대상
 * 문서를 지나쳐 vitals/level/spells/alignment를 silent 클로버하는 회귀를 막는 불변식이다.
 */
export const CURRENT_CHARACTER_SCHEMA_VERSION = 6

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
 * spell store 시드 — 빈 지식 비트마스크(uint8[16]=128비트, 전 0)와 realm 누적경험치[4]=[0,0,0,0].
 * 생성 경로(createCharacter)와 v4→v5 backfill이 공유하는 단일 시드 출처(seedVitals 선례) — 신규·승격
 * 문서가 동일한 빈 store로 출발해 버전 드리프트를 차단한다. buffs는 선택 필드라 시딩하지 않는다.
 */
export function seedSpellStore(): {
  spells: number[]
  realm: [number, number, number, number]
} {
  return { spells: new Array<number>(16).fill(0), realm: [0, 0, 0, 0] }
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

/**
 * v3 raw 문서를 v4로 승격하는 순수 스텝 헬퍼 — 합성 체인의 세 번째 단계다.
 *
 * v4는 statusEffects(poison·disease·blind 등 상태이상 트랙)를 도입했지만 이 필드는 스키마상
 * 선택(optional)이라 승격 시 시딩하지 않는다. strict parse가 statusEffects 부재를 거부하지
 * 않으므로 재시딩이 불필요하며, V4는 버전 스탬프만 3→4로 올린다(V2·V3의 필드 시딩과 대조).
 *
 * 진입 가드·출구 스탬프는 리터럴 4에 매인다(CURRENT 참조 금지) — CURRENT가 5로 오른 뒤에도
 * 이 스텝은 v4 문서를 통과시켜(재스탬프 없이) 다음 스텝에 넘겨야 하기 때문이다. schemaVersion>=4
 * 문서는 그대로 반환한다(passthrough). 원본을 변형하지 않고 스프레드로 새 객체를 반환한다.
 */
export function backfillCharacterV4(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= 4) return raw

  return {
    ...raw,
    schemaVersion: 4,
  }
}

/**
 * v4 raw 문서를 v5로 승격하는 순수 스텝 헬퍼 — 합성 체인의 네 번째 단계다.
 *
 * v5는 spell store(spells 비트마스크·realm 누적경험치)를 required로 도입했다. strict parse가
 * spells/realm 부재를 거부하므로 V2·V3의 필드 시딩과 대칭으로 seedSpellStore()로 빈 store를 시딩한다
 * (spells=16바이트 0, realm=[0,0,0,0]). buffs는 선택 필드라 시딩하지 않는다(V4 statusEffects 선례).
 *
 * 진입 가드·출구 스탬프는 리터럴 5에 매인다(CURRENT 참조 금지) — CURRENT가 6으로 오른 뒤에도
 * 이 스텝은 v5 문서를 통과시켜(실 지식·숙련을 빈값으로 재시딩하지 않고) 다음 스텝에 넘겨야 하기
 * 때문이다. schemaVersion>=5 문서는 그대로 반환한다(passthrough). 원본을 변형하지 않고 스프레드로
 * 새 객체를 반환한다.
 */
export function backfillCharacterV5(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= 5) return raw

  return {
    ...raw,
    ...seedSpellStore(),
    schemaVersion: 5,
  }
}

/**
 * v5 raw 문서를 v6로 승격하는 순수 스텝 헬퍼 — 합성 체인의 다섯 번째 단계다.
 *
 * v6는 alignment를 선택에서 required로 승격했다. strict parse가 alignment 부재를 거부하므로
 * V2·V3·V5의 필드 시딩과 대칭으로 중립 sentinel 0을 시딩한다(v4의 statusEffects·v5의 buffs는
 * 선택 필드라 무시딩했던 것과 대조 — 필수 승격 필드만 시딩한다는 기준이다). silence·fear는
 * statusEffects 하위의 선택 키라 여기서도 시딩하지 않는다(V4 선례).
 *
 * 시딩은 조건부다 — v5에서 alignment가 선택이었으므로 v5 문서 중 일부는 이미 1(선)·2(악) 실값을
 * 갖는다. V5의 무조건 시딩(v4엔 spells가 존재할 수 없었다)과 달리 값 보유 문서를 0으로 클로버하면
 * 안 된다. 가드는 `typeof raw.alignment === 'number'`다 — `=== undefined` 비교는 Mongo가 null로
 * 저장한 값을 통과시켜 z.int() parse를 깨뜨린다(V2의 raw.class, V3의 raw.level과 동일 관용).
 *
 * 진입 가드·출구 스탬프는 리터럴 6에 매인다(CURRENT 참조 금지) — CURRENT가 7로 오른 뒤에도
 * 이 스텝은 v6 문서를 통과시켜(실 성향을 0으로 재시딩하지 않고) 다음 스텝에 넘겨야 하기 때문이다.
 * schemaVersion>=6 문서는 그대로 반환한다(passthrough). 원본을 변형하지 않고 스프레드로 새 객체를
 * 반환한다.
 */
export function backfillCharacterV6(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version >= 6) return raw

  return {
    ...raw,
    // Number.isInteger는 typeof보다 좁다 — null·undefined뿐 아니라 NaN·1.5도 "값이 아님"으로 보고
    // 재시딩한다. typeof만 쓰면 손상 문서의 NaN이 그대로 보존돼 z.int() parse에서 hard throw하고
    // 그 캐릭터가 영구히 로드 불가가 된다(자가 치유 없음). 값역 위반(예 5)은 시딩 대상이 아니라
    // parse 에러로 드러나야 하므로 여기서 범위는 보지 않는다.
    ...(Number.isInteger(raw.alignment) ? {} : { alignment: 0 }),
    schemaVersion: 6,
  }
}
