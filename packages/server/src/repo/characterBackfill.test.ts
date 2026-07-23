import { describe, it, expect } from 'vitest'
import {
  characterSchema,
  computeHpMax,
  computeMpMax,
  neededExp,
  type EffectiveStatContext,
} from 'shared'
import {
  backfillCharacterV2,
  backfillCharacterV3,
  backfillCharacterV4,
  seedVitals,
  CURRENT_CHARACTER_SCHEMA_VERSION,
} from './characterBackfill.js'

/** 판독 6필드는 더미(0/false), class·level만 유효값으로 채운 컨텍스트. */
function ctx(characterClass: number, level: number): EffectiveStatContext {
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

/** hpCurrent/mpCurrent/level 없는 v1 raw 문서(디스크에서 온 형태). */
function rawV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'v1',
    name: '옛캐릭',
    class: 3,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    schemaVersion: 1,
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

describe('backfillCharacterV2', () => {
  it('schemaVersion<2 문서를 level=1·hpCurrent·mpCurrent·schemaVersion=2로 승격한다', () => {
    const result = backfillCharacterV2(rawV1())
    expect(result.level).toBe(1)
    expect(result.hpCurrent).toBe(computeHpMax(ctx(3, 1)))
    expect(result.mpCurrent).toBe(computeMpMax(ctx(3, 1)))
    expect(result.schemaVersion).toBe(2)
  })

  it('V2 단독 승격 결과는 experience가 없어 아직 parse를 통과하지 못한다 (V3 스텝 필요)', () => {
    // V2는 v1→v2(vitals)만 담당하고 experience는 V3 스텝 소유다. 합성(V3∘V2)해야 parse를 통과한다.
    const v2Only = backfillCharacterV2(rawV1())
    expect('experience' in v2Only).toBe(false)
    expect(characterSchema.safeParse(v2Only).success).toBe(false)
    expect(characterSchema.safeParse(backfillCharacterV3(v2Only)).success).toBe(true)
  })

  it('원본을 변형하지 않고 새 객체를 반환한다 (immutability)', () => {
    const raw = rawV1()
    const result = backfillCharacterV2(raw)
    expect(result).not.toBe(raw)
    expect('hpCurrent' in raw).toBe(false)
  })

  it('schemaVersion>=2 문서는 그대로 반환한다 (passthrough, 재계산 없음)', () => {
    const v2 = rawV1({ schemaVersion: 2, hpCurrent: 999, mpCurrent: 888, level: 7 })
    const result = backfillCharacterV2(v2)
    expect(result).toBe(v2)
    expect(result.hpCurrent).toBe(999)
    expect(result.level).toBe(7)
  })

  it('schemaVersion이 없는 문서도 v0으로 취급해 승격한다 (누락 버전 방어)', () => {
    const noVersion = rawV1()
    delete noVersion.schemaVersion
    const result = backfillCharacterV2(noVersion)
    expect(result.schemaVersion).toBe(2)
    expect(result.level).toBe(1)
  })

  it('class가 없는 문서는 placeholder 행(index 0)으로 시딩한다', () => {
    const noClass = rawV1()
    delete noClass.class
    const result = backfillCharacterV2(noClass)
    expect(result.hpCurrent).toBe(computeHpMax(ctx(0, 1)))
    expect(result.mpCurrent).toBe(computeMpMax(ctx(0, 1)))
  })
})

describe('seedVitals', () => {
  it('class·level로 computeHpMax·computeMpMax를 계산한다', () => {
    expect(seedVitals(2, 1)).toEqual({
      hpCurrent: computeHpMax(ctx(2, 1)),
      mpCurrent: computeMpMax(ctx(2, 1)),
    })
  })
})

/** experience 없는 v2 raw 문서(vitals·level 있음, schemaVersion:2). V3 승격 입력 형태. */
function rawV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'v2',
    name: '중간캐릭',
    class: 3,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 54,
    mpCurrent: 50,
    level: 1,
    schemaVersion: 2,
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

describe('backfillCharacterV3', () => {
  it('schemaVersion<3 문서를 experience·schemaVersion=3으로 승격한다 (level=1 → exp 0)', () => {
    const result = backfillCharacterV3(rawV2())
    expect(result.experience).toBe(0)
    expect(result.schemaVersion).toBe(3)
    expect(result.level).toBe(1)
  })

  it('★판별: level=50 v2 문서를 승격해도 level·vitals를 보존하고 exp를 정합 계산한다', () => {
    // 가드/스탬프가 CURRENT에 매이면 이 v2 문서가 V2로 흘러 level=1 클로버·vitals 재시딩된다.
    // level=50이라야 1→1 불가시 클로버가 드러난다(실데이터는 전부 level 1).
    const v2 = rawV2({ level: 50, hpCurrent: 777, mpCurrent: 333 })
    const result = backfillCharacterV3(v2)
    expect(result.level).toBe(50) // 보존 — 1로 클로버 금지
    expect(result.experience).toBe(neededExp(49)) // level L 도달 최소 누적 = neededExp(L-1)
    expect(result.hpCurrent).toBe(777) // vitals 재시딩 금지
    expect(result.mpCurrent).toBe(333)
    expect(result.schemaVersion).toBe(3)
  })

  it('schemaVersion>=3 문서는 그대로 반환한다 (passthrough, experience 재계산 없음)', () => {
    const v3 = rawV2({ schemaVersion: 3, level: 50, experience: 123456 })
    const result = backfillCharacterV3(v3)
    expect(result).toBe(v3)
    expect(result.experience).toBe(123456) // neededExp(49)로 덮어쓰지 않음
  })

  it('원본을 변형하지 않고 새 객체를 반환한다 (immutability)', () => {
    const raw = rawV2()
    const result = backfillCharacterV3(raw)
    expect(result).not.toBe(raw)
    expect('experience' in raw).toBe(false)
  })
})

/** experience 있는 v3 raw 문서(vitals·level·experience 있음, schemaVersion:3). V4 승격 입력 형태. */
function rawV3(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'v3',
    name: '최신캐릭',
    class: 3,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 54,
    mpCurrent: 50,
    level: 1,
    experience: 0,
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

describe('backfillCharacterV4', () => {
  it('CURRENT_CHARACTER_SCHEMA_VERSION은 4이다', () => {
    expect(CURRENT_CHARACTER_SCHEMA_VERSION).toBe(4)
  })

  it('schemaVersion<4 문서를 schemaVersion=4로 승격한다 (버전 스탬프만, statusEffects 미시딩)', () => {
    const result = backfillCharacterV4(rawV3())
    expect(result.schemaVersion).toBe(4)
    // statusEffects는 선택 필드라 시딩하지 않는다 — 버전만 3→4로 올린다.
    expect('statusEffects' in result).toBe(false)
  })

  it('승격 시 기존 필드(vitals·level·experience)를 보존한다', () => {
    const result = backfillCharacterV4(rawV3({ level: 50, hpCurrent: 777, mpCurrent: 333, experience: 12345 }))
    expect(result.level).toBe(50)
    expect(result.hpCurrent).toBe(777)
    expect(result.mpCurrent).toBe(333)
    expect(result.experience).toBe(12345)
    expect(result.schemaVersion).toBe(4)
  })

  it('schemaVersion>=4 문서는 그대로 반환한다 (passthrough, 재스탬프 없음)', () => {
    const v4 = rawV3({ schemaVersion: 4, statusEffects: { poison: { until: 60, interval: 6 } } })
    const result = backfillCharacterV4(v4)
    expect(result).toBe(v4)
    expect(result.statusEffects).toEqual({ poison: { until: 60, interval: 6 } })
  })

  it('schemaVersion이 없는 문서도 v0으로 취급해 승격한다 (누락 버전 방어)', () => {
    const noVersion = rawV3()
    delete noVersion.schemaVersion
    const result = backfillCharacterV4(noVersion)
    expect(result.schemaVersion).toBe(4)
  })

  it('원본을 변형하지 않고 새 객체를 반환한다 (immutability)', () => {
    const raw = rawV3()
    const result = backfillCharacterV4(raw)
    expect(result).not.toBe(raw)
    expect(raw.schemaVersion).toBe(3)
  })
})

describe('backfill 합성 체인 (V4 ∘ V3 ∘ V2)', () => {
  it('v1 raw → V2가 vitals(level=1), V3가 experience=0, V4가 schemaVersion=4, parse 통과', () => {
    const result = backfillCharacterV4(backfillCharacterV3(backfillCharacterV2(rawV1())))
    expect(result.level).toBe(1)
    expect(result.hpCurrent).toBe(computeHpMax(ctx(3, 1)))
    expect(result.experience).toBe(0)
    expect(result.schemaVersion).toBe(4)
    expect(characterSchema.safeParse(result).success).toBe(true)
  })

  it('v4 문서는 세 스텝 모두 passthrough (재계산 없음)', () => {
    const v4 = rawV3({ schemaVersion: 4, level: 7, experience: 999 })
    const result = backfillCharacterV4(backfillCharacterV3(backfillCharacterV2(v4)))
    expect(result).toBe(v4)
    expect(result.level).toBe(7)
    expect(result.experience).toBe(999)
  })
})
