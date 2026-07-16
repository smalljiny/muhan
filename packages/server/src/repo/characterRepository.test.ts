import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db, Filter } from 'mongodb'
import type { Character, ObjectInstance } from 'shared'
import { CharacterRepository } from './characterRepository.js'
import { ObjectRepository } from './objectRepository.js'
import { DocumentNotFoundError } from './types.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

/** 테스트용 유효 Character 팩토리 — 스키마 shape를 정확히 만족한다. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    schemaVersion: 1,
    // 계정 링크 FK(Story 1로 필수화)와 soft-delete 상태 기본값.
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

/** 테스트용 유효 ObjectInstance 팩토리. */
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

describe('CharacterRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let objects: ObjectRepository
  let repo: CharacterRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_character_repo_test')
    db = harness.db
    // unique 인덱스는 mongod 수명 동안 1회만 만들면 된다(deleteMany는 인덱스를 지우지 않는다).
    objects = new ObjectRepository(db)
    repo = new CharacterRepository(db, objects)
    await objects.init()
    await repo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('characters').deleteMany({})
    await db.collection('objects').deleteMany({})
  })

  it('insert 후 findById로 동일한 Character를 되돌려준다(roundtrip)', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found).toEqual(doc)
  })

  it('존재하지 않는 id에 대해 findById는 null을 반환한다', async () => {
    const found = await repo.findById('does-not-exist')
    expect(found).toBeNull()
  })

  it('updateById는 저장된 문서를 갱신한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await repo.updateById(doc._id, { gold: 250, currentRoom: 5 })

    const found = await repo.findById(doc._id)
    expect(found?.gold).toBe(250)
    expect(found?.currentRoom).toBe(5)
  })

  it('updateById는 유효하지 않은 부분 패치(gold 음수)를 경계 검증으로 거부한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await expect(repo.updateById(doc._id, { gold: -1 })).rejects.toThrow()
  })

  it('deleteById는 문서를 제거한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await repo.deleteById(doc._id)

    const found = await repo.findById(doc._id)
    expect(found).toBeNull()
  })

  it('잘못된 문서(name 빈 문자열)는 경계 검증으로 거부한다', async () => {
    const invalid = makeCharacter({ name: '' })
    await expect(repo.insert(invalid)).rejects.toThrow()
  })

  it('hydrateInventory는 캐릭터가 소유한 오브젝트만 반환한다', async () => {
    const char = makeCharacter({ _id: 'char-A' })
    await repo.insert(char)

    const owned1 = makeObject({ _id: 'o1', owner: { type: 'character', id: 'char-A' } })
    const owned2 = makeObject({ _id: 'o2', owner: { type: 'character', id: 'char-A' } })
    const other = makeObject({ _id: 'o3', owner: { type: 'character', id: 'char-B' } })
    const banked = makeObject({ _id: 'o4', owner: { type: 'bank', id: 'char-A' } })
    await objects.insert(owned1)
    await objects.insert(owned2)
    await objects.insert(other)
    await objects.insert(banked)

    const inventory = await repo.hydrateInventory('char-A')
    expect(inventory.map((o) => o._id).sort()).toEqual(['o1', 'o2'])
  })

  it('캐릭터 문서에는 권한 인벤토리 배열이 저장되지 않는다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    const raw = await db.collection<Character>('characters').findOne({ _id: doc._id } as Filter<Character>)
    expect(raw).not.toBeNull()
    expect(raw).not.toHaveProperty('inventory')
    expect(raw).not.toHaveProperty('items')
  })

  it('name unique 인덱스: 같은 name의 두 번째 캐릭터 insert는 거부된다', async () => {
    // _id는 다르게, name만 동일하게 — 실패가 name 인덱스에서 나야 한다(_id 충돌 아님).
    await repo.insert(makeCharacter({ _id: 'char-x', name: '중복이름' }))
    await expect(repo.insert(makeCharacter({ _id: 'char-y', name: '중복이름' }))).rejects.toThrow()
  })

  it('accountId는 insert→findById 왕복에서 보존된다', async () => {
    const doc = makeCharacter({ _id: 'char-acc', accountId: 'acc-42' })
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found?.accountId).toBe('acc-42')
  })

  it('findByAccount는 해당 계정의 삭제되지 않은 캐릭터만 반환한다', async () => {
    await repo.insert(makeCharacter({ _id: 'c1', name: '가', accountId: 'acc-1' }))
    await repo.insert(makeCharacter({ _id: 'c2', name: '나', accountId: 'acc-1' }))
    await repo.insert(makeCharacter({ _id: 'c3', name: '다', accountId: 'acc-2' }))

    const result = await repo.findByAccount('acc-1')
    expect(result.map((c) => c._id).sort()).toEqual(['c1', 'c2'])
  })

  it("findByAccount는 status='deleted' 캐릭터(무덤)를 제외한다", async () => {
    await repo.insert(makeCharacter({ _id: 'live', name: '살아있음', accountId: 'acc-9' }))
    await repo.insert(
      makeCharacter({
        _id: 'dead',
        name: '무덤',
        accountId: 'acc-9',
        status: 'deleted',
        deletedAt: new Date(),
      }),
    )

    const result = await repo.findByAccount('acc-9')
    expect(result.map((c) => c._id)).toEqual(['live'])
  })

  it('findByAccount는 캐릭터가 없는 계정에 대해 빈 배열을 반환한다', async () => {
    const result = await repo.findByAccount('acc-empty')
    expect(result).toEqual([])
  })

  it('init()은 name unique 인덱스와 accountId 인덱스를 모두 보장한다', async () => {
    const indexes = await db.collection('characters').indexes()
    const keys = indexes.map((idx) => JSON.stringify(idx.key))
    expect(keys).toContain(JSON.stringify({ name: 1 }))
    expect(keys).toContain(JSON.stringify({ accountId: 1 }))
    const nameIndex = indexes.find((idx) => JSON.stringify(idx.key) === JSON.stringify({ name: 1 }))
    expect(nameIndex?.unique).toBe(true)
  })

  it('존재하지 않는 id updateById는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.updateById('missing', { gold: 10 })).rejects.toThrow(DocumentNotFoundError)
  })

  it('존재하지 않는 id deleteById는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.deleteById('missing')).rejects.toThrow(DocumentNotFoundError)
  })
})
