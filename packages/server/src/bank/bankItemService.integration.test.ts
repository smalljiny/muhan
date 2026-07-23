import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db } from 'mongodb'
import type { BankAccount, ObjectInstance } from 'shared'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { BankRepository } from '../repo/bankRepository.js'
import { BankItemService, BankSlotFullError, BANK_SLOT_LIMIT } from './bankItemService.js'

/**
 * 은행 아이템 보관/인출 통합 테스트 — 실제 인메모리 Mongo + 실제 저장소로 owner 재지정
 * 왕복과 slot 경계(199 성공 / 200 거부)를 검증한다. holdings는 owner 역참조로 파생되므로
 * bankAccount 문서에 items[]를 쓰지 않음을 findByOwner 조회로 확인한다.
 */

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

describe('BankItemService (integration, real db)', () => {
  let harness: MongoTestDb
  let db: Db
  let objects: ObjectRepository
  let banks: BankRepository
  let service: BankItemService

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_bank_item_test')
    db = harness.db
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('objects').deleteMany({})
    await db.collection('bankAccounts').deleteMany({})
    objects = new ObjectRepository(db)
    banks = new BankRepository(db, objects)
    service = new BankItemService(objects, banks)
  })

  it('보관→인출 왕복: owner가 character→bank→character로 재지정된다', async () => {
    await objects.insert(makeObject({ owner: { type: 'character', id: 'char-1' } }))
    await banks.insert(makeBank())

    await service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false })
    const stored = await objects.findById('obj-1')
    expect(stored?.owner).toEqual({ type: 'bank', id: 'bank-1' })

    await service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1' })
    const withdrawn = await objects.findById('obj-1')
    expect(withdrawn?.owner).toEqual({ type: 'character', id: 'char-1' })
  })

  it('보관은 bankAccount 문서에 items[]를 쓰지 않고 owner 역참조로만 파생된다', async () => {
    await objects.insert(makeObject({ owner: { type: 'character', id: 'char-1' } }))
    await banks.insert(makeBank())

    await service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false })

    const holdings = await banks.hydrateHoldings('bank-1')
    expect(holdings.map((h) => h._id)).toEqual(['obj-1'])
    const bankDoc = await db.collection<BankAccount>('bankAccounts').findOne({ _id: 'bank-1' })
    expect(bankDoc).not.toHaveProperty('items')
  })

  it('slot 경계: 이미 199개 보관 상태면 200번째 보관은 성공한다', async () => {
    for (let i = 0; i < BANK_SLOT_LIMIT - 1; i++) {
      await objects.insert(makeObject({ _id: `held-${i}`, owner: { type: 'bank', id: 'bank-1' } }))
    }
    await objects.insert(makeObject({ _id: 'obj-1', owner: { type: 'character', id: 'char-1' } }))
    await banks.insert(makeBank())

    await service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false })

    const holdings = await banks.hydrateHoldings('bank-1')
    expect(holdings).toHaveLength(BANK_SLOT_LIMIT)
  })

  it('slot 경계: 이미 200개 보관 상태면 보관은 BankSlotFullError로 거부된다', async () => {
    for (let i = 0; i < BANK_SLOT_LIMIT; i++) {
      await objects.insert(makeObject({ _id: `held-${i}`, owner: { type: 'bank', id: 'bank-1' } }))
    }
    await objects.insert(makeObject({ _id: 'obj-1', owner: { type: 'character', id: 'char-1' } }))
    await banks.insert(makeBank())

    await expect(
      service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
    ).rejects.toThrow(BankSlotFullError)

    // 거부되었으므로 obj-1은 여전히 character 소유다.
    const stored = await objects.findById('obj-1')
    expect(stored?.owner).toEqual({ type: 'character', id: 'char-1' })
  })
})
