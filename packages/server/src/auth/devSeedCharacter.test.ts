import { describe, it, expect } from 'vitest'
import { characterSchema } from 'shared'
import { buildDevSeedCharacterDoc } from './devSeedCharacter.js'
import { DEV_SEED_CHARACTER } from './devSeedSessionAuth.js'
import { START_ROOM, STARTING_GOLD } from './characterStartDefaults.js'
import {
  CURRENT_CHARACTER_SCHEMA_VERSION,
  seedSpellStore,
  seedVitals,
} from '../repo/characterBackfill.js'

const ACCOUNT_ID = 'dev-account-1'

describe('buildDevSeedCharacterDoc', () => {
  it('strict characterSchema를 통과하고 parse 결과가 원본 문서와 같다', () => {
    const doc = buildDevSeedCharacterDoc(ACCOUNT_ID)

    expect(characterSchema.parse(doc)).toEqual(doc)
  })

  it('공유 출처 필드는 DEV_SEED_CHARACTER와 생성 경로의 함수·상수를 따른다', () => {
    expect(buildDevSeedCharacterDoc(ACCOUNT_ID)).toMatchObject({
      _id: DEV_SEED_CHARACTER.characterId,
      name: DEV_SEED_CHARACTER.name,
      class: DEV_SEED_CHARACTER.class,
      race: DEV_SEED_CHARACTER.race,
      level: DEV_SEED_CHARACTER.level,
      ...seedVitals(DEV_SEED_CHARACTER.class, DEV_SEED_CHARACTER.level),
      ...seedSpellStore(),
      schemaVersion: CURRENT_CHARACTER_SCHEMA_VERSION,
      currentRoom: START_ROOM,
      gold: STARTING_GOLD,
    })
  })

  it('공유 출처 필드의 값이 스펙 §3.2 표의 값과 같다', () => {
    expect(buildDevSeedCharacterDoc(ACCOUNT_ID)).toMatchObject({
      _id: 'dev-char-1',
      name: '개발전사',
      class: 1,
      race: 1,
      level: 1,
      currentRoom: 1,
      gold: 500,
    })
  })

  it('accountId는 인자 값을 그대로 쓴다', () => {
    expect(buildDevSeedCharacterDoc(ACCOUNT_ID).accountId).toBe(ACCOUNT_ID)
    expect(buildDevSeedCharacterDoc('other-account').accountId).toBe('other-account')
  })

  it('시드 고정값(experience·status·stats·alignment)은 스펙 §3.2 값이다', () => {
    expect(buildDevSeedCharacterDoc(ACCOUNT_ID)).toMatchObject({
      experience: 0,
      status: 'active',
      stats: [16, 18, 12, 10, 14],
      alignment: 1,
    })
  })

  it.each(['gender', 'weapon', 'deletedAt', 'buffs', 'statusEffects'])(
    '선택 필드 %s는 두지 않는다',
    (key) => {
      expect(Object.hasOwn(buildDevSeedCharacterDoc(ACCOUNT_ID), key)).toBe(false)
    },
  )

  it('호출마다 새 객체를 반환한다(공유 참조 없음)', () => {
    const a = buildDevSeedCharacterDoc(ACCOUNT_ID)
    const b = buildDevSeedCharacterDoc(ACCOUNT_ID)

    expect(a).not.toBe(b)
    expect(a.stats).not.toBe(b.stats)
    expect(a.spells).not.toBe(b.spells)
    expect(a).toEqual(b)
  })
})
