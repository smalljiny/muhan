import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db } from 'mongodb'
import type { ObjectInstance } from 'shared'
import { ObjectRepository } from './objectRepository.js'
import { DocumentNotFoundError } from './types.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

/** 테스트용 유효 ObjectInstance 팩토리 — 스키마 shape를 정확히 만족한다. */
function makeObject(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: 3,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 50,
    shotscur: 0,
    schemaVersion: 1,
    ...overrides,
  }
}

describe('ObjectRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let repo: ObjectRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_object_repo_test')
    db = harness.db
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('objects').deleteMany({})
    repo = new ObjectRepository(db)
  })

  it('insert 후 findById로 동일한 ObjectInstance를 되돌려준다(roundtrip)', async () => {
    const doc = makeObject()
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found).toEqual(doc)
  })

  it('존재하지 않는 id에 대해 findById는 null을 반환한다', async () => {
    const found = await repo.findById('does-not-exist')
    expect(found).toBeNull()
  })

  it('findByOwner는 소유자별로 오브젝트 집합을 분할한다', async () => {
    const charA1 = makeObject({ _id: 'a1', owner: { type: 'character', id: 'char-A' } })
    const charA2 = makeObject({ _id: 'a2', owner: { type: 'character', id: 'char-A' } })
    const charB = makeObject({ _id: 'b1', owner: { type: 'character', id: 'char-B' } })
    const bank = makeObject({ _id: 'k1', owner: { type: 'bank', id: 'bank-A' } })
    await repo.insert(charA1)
    await repo.insert(charA2)
    await repo.insert(charB)
    await repo.insert(bank)

    const ownedByCharA = await repo.findByOwner({ type: 'character', id: 'char-A' })
    expect(ownedByCharA.map((o) => o._id).sort()).toEqual(['a1', 'a2'])

    const ownedByBank = await repo.findByOwner({ type: 'bank', id: 'bank-A' })
    expect(ownedByBank.map((o) => o._id)).toEqual(['k1'])
  })

  it('init() 후 owner.type + owner.id를 덮는 인덱스가 존재한다', async () => {
    await repo.init()
    const indexes = await db.collection('objects').indexes()
    const hasOwnerIndex = indexes.some(
      (idx) => idx.key['owner.type'] !== undefined && idx.key['owner.id'] !== undefined,
    )
    expect(hasOwnerIndex).toBe(true)
  })

  it('잘못된 문서(type 범위 밖)는 경계 검증으로 거부한다', async () => {
    const invalid = makeObject({ type: 99 })
    await expect(repo.insert(invalid)).rejects.toThrow()
  })

  it('필수 필드 누락 문서는 경계 검증으로 거부한다', async () => {
    const { schemaVersion, ...partial } = makeObject()
    void schemaVersion
    await expect(repo.insert(partial as ObjectInstance)).rejects.toThrow()
  })

  it('updateById는 저장된 문서를 갱신한다', async () => {
    const doc = makeObject()
    await repo.insert(doc)

    await repo.updateById(doc._id, { equipped: true, shotscur: 5 })

    const found = await repo.findById(doc._id)
    expect(found?.equipped).toBe(true)
    expect(found?.shotscur).toBe(5)
  })

  it('updateById는 유효하지 않은 부분 패치(type 범위 밖)를 경계 검증으로 거부한다', async () => {
    const doc = makeObject()
    await repo.insert(doc)

    await expect(repo.updateById(doc._id, { type: 99 })).rejects.toThrow()
  })

  it('deleteById는 문서를 제거한다', async () => {
    const doc = makeObject()
    await repo.insert(doc)

    await repo.deleteById(doc._id)

    const found = await repo.findById(doc._id)
    expect(found).toBeNull()
  })

  it('존재하지 않는 id updateById는 DocumentNotFoundError를 던진다(silent lost write 방지)', async () => {
    await expect(repo.updateById('missing', { equipped: true })).rejects.toThrow(
      DocumentNotFoundError,
    )
  })

  it('빈 패치로 기존 문서를 updateById하면 던지지 않는다(멱등, matched=1)', async () => {
    const doc = makeObject()
    await repo.insert(doc)
    // 빈 $set은 matched=1, modified=0 — 성공으로 취급해야 한다(modifiedCount 함정 방어).
    await expect(repo.updateById(doc._id, {})).resolves.toBeUndefined()
  })

  it('존재하지 않는 id deleteById는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.deleteById('missing')).rejects.toThrow(DocumentNotFoundError)
  })
})
