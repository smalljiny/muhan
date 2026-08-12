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
    // .sort()를 걸지 않는다 — findByOwner가 이미 _id 오름차순을 계약으로 보장하므로,
    // 여기서 재정렬하면 계약이 깨져도 이 테스트가 통과해 버린다.
    expect(ownedByCharA.map((o) => o._id)).toEqual(['a1', 'a2'])

    const ownedByBank = await repo.findByOwner({ type: 'bank', id: 'bank-A' })
    expect(ownedByBank.map((o) => o._id)).toEqual(['k1'])
  })

  /**
   * OQ2 결정성 — 서수는 플레이어가 관측하는 동작이므로 조회 순서가 계약이어야 한다.
   * Mongo 자연 순서는 계약이 아니라(문서 이동·재사용 공간에 따라 바뀔 수 있다) `_id` 오름차순으로
   * 고정한다. 오라클 이름 사전순과의 divergence는 `world/liveCharacterEntry.ts` 헤더가 소유한다.
   */
  it('findByOwner는 _id 오름차순으로 정렬된 결정적 순서를 반환한다', async () => {
    // 삽입 순서를 역순으로 둬 자연 순서와 정렬 결과가 갈리게 만든다(비-vacuous).
    await repo.insert(makeObject({ _id: 'c', owner: { type: 'character', id: 'char-A' } }))
    await repo.insert(makeObject({ _id: 'a', owner: { type: 'character', id: 'char-A' } }))
    await repo.insert(makeObject({ _id: 'b', owner: { type: 'character', id: 'char-A' } }))

    const found = await repo.findByOwner({ type: 'character', id: 'char-A' })

    expect(found.map((o) => o._id)).toEqual(['a', 'b', 'c'])
  })

  it('같은 소유자를 2회 조회하면 동일한 순서를 반환한다(OQ2 결정성)', async () => {
    await repo.insert(makeObject({ _id: 'z', owner: { type: 'character', id: 'char-A' } }))
    await repo.insert(makeObject({ _id: 'm', owner: { type: 'character', id: 'char-A' } }))
    await repo.insert(makeObject({ _id: 'k', owner: { type: 'character', id: 'char-A' } }))

    const first = await repo.findByOwner({ type: 'character', id: 'char-A' })
    const second = await repo.findByOwner({ type: 'character', id: 'char-A' })

    expect(second.map((o) => o._id)).toEqual(first.map((o) => o._id))
    expect(first.map((o) => o._id)).toEqual(['k', 'm', 'z'])
  })

  it('init() 후 owner.type + owner.id + _id를 덮는 인덱스가 존재한다', async () => {
    await repo.init()
    const indexes = await db.collection('objects').indexes()
    const hasOwnerIndex = indexes.some(
      (idx) =>
        idx.key['owner.type'] !== undefined &&
        idx.key['owner.id'] !== undefined &&
        idx.key['_id'] !== undefined,
    )
    expect(hasOwnerIndex).toBe(true)
  })

  it('init()은 신 인덱스의 prefix인 구 owner 인덱스를 남기지 않는다(잉여 유지비용 차단)', async () => {
    // 구 형상을 먼저 만들어 두고 init()이 정리하는지 본다 — 이미 init()을 돌린 DB의 상황이다.
    await db.collection('objects').createIndex({ 'owner.type': 1, 'owner.id': 1 })

    await repo.init()

    const names = (await db.collection('objects').indexes()).map((idx) => idx.name)
    expect(names).not.toContain('owner.type_1_owner.id_1')
  })

  it('init()은 멱등하다 — 구 인덱스가 없어도 IndexNotFound를 삼킨다', async () => {
    await repo.init()
    await expect(repo.init()).resolves.toBeUndefined()
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
