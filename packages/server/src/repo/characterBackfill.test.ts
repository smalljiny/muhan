import { describe, it, expect } from 'vitest'
import { characterSchema, computeHpMax, computeMpMax, type EffectiveStatContext } from 'shared'
import { backfillCharacterV2, seedVitals } from './characterBackfill.js'

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

  it('승격 결과는 characterSchema.parse를 통과한다 (누락 v1 → 유효 v2)', () => {
    const result = backfillCharacterV2(rawV1())
    expect(characterSchema.safeParse(result).success).toBe(true)
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
