import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Collection } from 'mongodb'
import { buildDevSeedCharacterDoc, seedDevCharacter } from './devSeedCharacter.js'
import { DEV_SEED_CHARACTER } from './devSeedSessionAuth.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'

/** raw 문서 직접 주입·조회용 컬렉션 스키마 — 문자열 _id를 강제하고 임의 필드를 허용한다. */
type RawCharacterDoc = { _id: string } & Record<string, unknown>

const SEED_ACCOUNT = 'dev-account-1'
const OTHER_ACCOUNT = 'other-account-9'
const SEED_ID = DEV_SEED_CHARACTER.characterId

/** reject된 Promise의 오류 메시지를 돌려준다. resolve되면 실패시킨다. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  return error instanceof Error ? error.message : ''
}

describe('seedDevCharacter (integration)', () => {
  let harness: MongoTestDb
  let raw: Collection<RawCharacterDoc>
  let repo: CharacterRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_dev_seed_character_test')
    raw = harness.db.collection<RawCharacterDoc>('characters')
    const objects = new ObjectRepository(harness.db)
    repo = new CharacterRepository(harness.db, objects)
    await objects.init()
    // name unique 인덱스를 보장해 이름 충돌(E11000) 케이스가 실제 인덱스로 검증되게 한다.
    await repo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await raw.deleteMany({})
  })

  it('빈 컬렉션이면 삽입하고 inserted를 돌려준다(accountId는 인자)', async () => {
    await expect(seedDevCharacter(repo, SEED_ACCOUNT)).resolves.toBe('inserted')

    const stored = await raw.findOne({ _id: SEED_ID })
    expect(stored).not.toBeNull()
    expect(stored?.accountId).toBe(SEED_ACCOUNT)
  })

  it('정합 기존 문서면 kept를 돌려주고 raw 문서(진행 상태)를 바꾸지 않는다', async () => {
    await raw.insertOne({
      ...buildDevSeedCharacterDoc(SEED_ACCOUNT),
      level: 7,
      currentRoom: 5,
    })
    const before = await raw.findOne({ _id: SEED_ID })

    await expect(seedDevCharacter(repo, SEED_ACCOUNT)).resolves.toBe('kept')

    const after = await raw.findOne({ _id: SEED_ID })
    expect(after).toEqual(before)
    expect(after).toMatchObject({ level: 7, currentRoom: 5 })
  })

  it('status 필드가 저장되지 않은 정합 문서도 kept를 돌려준다', async () => {
    const { status: _omitted, ...withoutStatus } = buildDevSeedCharacterDoc(SEED_ACCOUNT)
    await raw.insertOne(withoutStatus)
    const before = await raw.findOne({ _id: SEED_ID })

    await expect(seedDevCharacter(repo, SEED_ACCOUNT)).resolves.toBe('kept')

    const after = await raw.findOne({ _id: SEED_ID })
    expect(after).toEqual(before)
    expect(Object.hasOwn(after ?? {}, 'status')).toBe(false)
  })

  it('accountId가 다른 기존 문서면 해결 방법을 담은 오류로 reject하고 문서를 바꾸지 않는다', async () => {
    await raw.insertOne(buildDevSeedCharacterDoc(OTHER_ACCOUNT))
    const before = await raw.findOne({ _id: SEED_ID })

    const message = await rejectionMessage(seedDevCharacter(repo, SEED_ACCOUNT))
    expect(message).toContain(SEED_ID)
    expect(message).toContain(SEED_ACCOUNT)
    expect(message).toContain(OTHER_ACCOUNT)
    expect(message).toContain('삭제')
    expect(message).toContain('DEV_SEED_ACCOUNT_ID')
    expect(await raw.findOne({ _id: SEED_ID })).toEqual(before)
  })

  it('status가 deleted인 기존 문서면 해결 방법을 담은 오류로 reject하고 되살리지 않는다', async () => {
    await raw.insertOne({ ...buildDevSeedCharacterDoc(SEED_ACCOUNT), status: 'deleted' })
    const before = await raw.findOne({ _id: SEED_ID })

    const message = await rejectionMessage(seedDevCharacter(repo, SEED_ACCOUNT))
    expect(message).toContain(SEED_ID)
    expect(message).toContain('삭제')
    expect(await raw.findOne({ _id: SEED_ID })).toEqual(before)
  })

  it('다른 _id가 시드 이름을 가지면 E11000으로 reject한다', async () => {
    await raw.insertOne({
      ...buildDevSeedCharacterDoc(OTHER_ACCOUNT),
      _id: 'someone-else',
    })

    await expect(seedDevCharacter(repo, SEED_ACCOUNT)).rejects.toThrow(/E11000/)
    expect(await raw.findOne({ _id: SEED_ID })).toBeNull()
  })
})
