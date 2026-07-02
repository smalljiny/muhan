import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db, Filter } from 'mongodb'
import type { BankAccount, ObjectInstance } from 'shared'
import { BankRepository } from './bankRepository.js'
import { ObjectRepository } from './objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

/** 테스트용 유효 BankAccount 팩토리. */
function makeBank(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    _id: 'bank-1',
    owner: 'char-1',
    gold: 1000,
    schemaVersion: 1,
    ...overrides,
  }
}

/** 테스트용 유효 ObjectInstance 팩토리. */
function makeObject(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: 3,
    owner: { type: 'bank', id: 'bank-1' },
    slot: null,
    equipped: false,
    value: 50,
    shotscur: 0,
    schemaVersion: 1,
    ...overrides,
  }
}

describe('BankRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let objects: ObjectRepository
  let repo: BankRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_bank_repo_test')
    db = harness.db
    objects = new ObjectRepository(db)
    repo = new BankRepository(db, objects)
    await objects.init()
    await repo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('bankAccounts').deleteMany({})
    await db.collection('objects').deleteMany({})
  })

  it('insert 후 findById로 동일한 BankAccount를 되돌려준다(roundtrip)', async () => {
    const doc = makeBank()
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found).toEqual(doc)
  })

  it('존재하지 않는 id에 대해 findById는 null을 반환한다', async () => {
    const found = await repo.findById('does-not-exist')
    expect(found).toBeNull()
  })

  it('updateById는 저장된 문서를 갱신한다', async () => {
    const doc = makeBank()
    await repo.insert(doc)

    await repo.updateById(doc._id, { gold: 2000 })

    const found = await repo.findById(doc._id)
    expect(found?.gold).toBe(2000)
  })

  it('deleteById는 문서를 제거한다', async () => {
    const doc = makeBank()
    await repo.insert(doc)

    await repo.deleteById(doc._id)

    const found = await repo.findById(doc._id)
    expect(found).toBeNull()
  })

  it('hydrateHoldings는 은행 계좌가 보관한 오브젝트만 반환한다', async () => {
    const bank = makeBank({ _id: 'bank-A', owner: 'char-A' })
    await repo.insert(bank)

    // 은행 보관 오브젝트의 owner.id 관례: 은행 계좌의 _id(bankAccountId).
    const held1 = makeObject({ _id: 'o1', owner: { type: 'bank', id: 'bank-A' } })
    const held2 = makeObject({ _id: 'o2', owner: { type: 'bank', id: 'bank-A' } })
    const otherBank = makeObject({ _id: 'o3', owner: { type: 'bank', id: 'bank-B' } })
    const charOwned = makeObject({ _id: 'o4', owner: { type: 'character', id: 'char-A' } })
    await objects.insert(held1)
    await objects.insert(held2)
    await objects.insert(otherBank)
    await objects.insert(charOwned)

    const holdings = await repo.hydrateHoldings('bank-A')
    expect(holdings.map((o) => o._id).sort()).toEqual(['o1', 'o2'])
  })

  it('은행 계좌 문서에는 권한 holdings 배열이 저장되지 않는다', async () => {
    const doc = makeBank()
    await repo.insert(doc)

    const raw = await db.collection<BankAccount>('bankAccounts').findOne({ _id: doc._id } as Filter<BankAccount>)
    expect(raw).not.toBeNull()
    expect(raw).not.toHaveProperty('holdings')
    expect(raw).not.toHaveProperty('items')
  })

  it('owner unique 인덱스: 같은 owner의 두 번째 계좌 insert는 거부된다', async () => {
    // _id는 다르게, owner만 동일하게 — 실패가 owner 인덱스에서 나야 한다.
    await repo.insert(makeBank({ _id: 'bank-x', owner: 'char-dup' }))
    await expect(repo.insert(makeBank({ _id: 'bank-y', owner: 'char-dup' }))).rejects.toThrow()
  })

  // === Gold-integrity guard (불변식 6) — 스키마 경계(gold: int 0..300_000_000) ===

  it('insert: gold 음수는 거부된다', async () => {
    await expect(repo.insert(makeBank({ _id: 'bank-neg', gold: -1 }))).rejects.toThrow()
  })

  it('insert: gold 상한 초과(300_000_001)는 거부된다', async () => {
    await expect(repo.insert(makeBank({ _id: 'bank-over', gold: 300_000_001 }))).rejects.toThrow()
  })

  it('updateById: gold 음수(-1)는 거부된다', async () => {
    await repo.insert(makeBank())
    await expect(repo.updateById('bank-1', { gold: -1 })).rejects.toThrow()
  })

  it('updateById: gold 상한 초과(300_000_001)는 거부된다', async () => {
    await repo.insert(makeBank())
    await expect(repo.updateById('bank-1', { gold: 300_000_001 })).rejects.toThrow()
  })

  it('경계값 gold 0과 300_000_000은 허용된다', async () => {
    await repo.insert(makeBank({ _id: 'bank-lo', owner: 'c-lo', gold: 0 }))
    await repo.insert(makeBank({ _id: 'bank-hi', owner: 'c-hi', gold: 300_000_000 }))

    expect((await repo.findById('bank-lo'))?.gold).toBe(0)
    expect((await repo.findById('bank-hi'))?.gold).toBe(300_000_000)
  })
})
