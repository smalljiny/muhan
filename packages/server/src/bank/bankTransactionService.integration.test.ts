import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db } from 'mongodb'
import { MAX_BANK_GOLD, type BankAccount, type Character } from 'shared'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { DocumentNotFoundError } from '../repo/types.js'
import {
  BankTransactionService,
  InsufficientFundsError,
  BankCapExceededError,
} from './bankTransactionService.js'

/** 테스트용 유효 Character 팩토리. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    level: 1,
    hpCurrent: 55,
    mpCurrent: 40,
    schemaVersion: 2,
    accountId: 'acc-1',
    status: 'active',
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

describe('BankTransactionService (integration, real replset)', () => {
  let harness: MongoTestDb
  let db: Db
  let service: BankTransactionService

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_bank_tx_test')
    db = harness.db
    service = new BankTransactionService(harness.client, db)
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('characters').deleteMany({})
    await db.collection('bankAccounts').deleteMany({})
  })

  /** 두 문서를 원시 조회해 gold 값을 쌍으로 반환한다(원자성 단언용). */
  async function goldOf(characterId: string, bankId: string): Promise<{ char: number; bank: number }> {
    const char = await db.collection<Character>('characters').findOne({ _id: characterId })
    const bank = await db.collection<BankAccount>('bankAccounts').findOne({ _id: bankId })
    if (char === null || bank === null) throw new Error('시드 문서가 없습니다')
    return { char: char.gold, bank: bank.gold }
  }

  // === Completion Criterion 1: 입금 성공 — 한 트랜잭션에서 함께 커밋 ===
  it('입금 성공: character.gold −amt, bankAccount.gold +amt가 함께 커밋되고 총량이 보존된다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))
    const before = await goldOf('char-1', 'bank-1')

    await service.deposit('char-1', 'bank-1', 300)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(200)
    expect(after.bank).toBe(1300)
    // 총량 보존 — 한쪽만 바뀌면 원자성 위반.
    expect(after.char + after.bank).toBe(before.char + before.bank)
  })

  // === Completion Criterion 2: 잔액 부족 입금은 abort, 두 문서 불변 ===
  it('character 잔액 부족 입금은 abort하고 두 문서 모두 불변이다(all-or-nothing)', async () => {
    // 선행 guard(bank cap)는 통과하도록 bank는 여유. 실패는 character $gte에서 나야 한다.
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 50 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))

    await expect(service.deposit('char-1', 'bank-1', 300)).rejects.toThrow(InsufficientFundsError)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(50)
    expect(after.bank).toBe(1000)
  })

  // === Completion Criterion 3: bank 3억 초과 입금은 abort, 두 문서 불변(불변식 6) ===
  it('bankAccount.gold가 3억 초과가 되는 입금은 abort하고 두 문서 불변이다(불변식 6)', async () => {
    // character는 step1 $gte를 통과할 충분한 gold를 가진다 — 실패는 step2 cap guard에서 나야 한다.
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 1000 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: MAX_BANK_GOLD - 100 }))

    // value + amt = (3억-100) + 200 = 3억+100 > 3억 → step2 매칭0.
    await expect(service.deposit('char-1', 'bank-1', 200)).rejects.toThrow(BankCapExceededError)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(1000)
    expect(after.bank).toBe(MAX_BANK_GOLD - 100)
  })

  it('입금 경계값: bankAccount.gold가 정확히 3억이 되는 입금은 허용된다(value+amt=3억)', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 1000 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: MAX_BANK_GOLD - 100 }))

    await service.deposit('char-1', 'bank-1', 100)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.bank).toBe(MAX_BANK_GOLD)
    expect(after.char).toBe(900)
  })

  // === Completion Criterion 4: 출금 성공 — 함께 커밋 ===
  it('출금 성공: bankAccount.gold −amt, character.gold +amt가 함께 커밋되고 총량이 보존된다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))
    const before = await goldOf('char-1', 'bank-1')

    await service.withdraw('char-1', 'bank-1', 400)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.bank).toBe(600)
    expect(after.char).toBe(900)
    expect(after.char + after.bank).toBe(before.char + before.bank)
  })

  // === Completion Criterion 5: bank 잔고 부족 출금은 abort, 두 문서 불변 ===
  it('bankAccount 잔고 부족 출금은 abort하고 두 문서 불변이다(비음수 가드 대칭)', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 200 }))

    await expect(service.withdraw('char-1', 'bank-1', 400)).rejects.toThrow(InsufficientFundsError)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(500)
    expect(after.bank).toBe(200)
  })

  // === Completion Criterion 6: rejection이 swallow되지 않고 전파돼 abort ===
  it('트랜잭션 콜백 내 rejection은 swallow되지 않고 전파된다(부분 커밋 없음)', async () => {
    // 존재하지 않는 은행 계좌 → step2(deposit)가 매칭0 → 콜백 throw → withTransaction abort.
    // character는 step1을 통과하지만 트랜잭션 전체가 abort되어야 character도 불변이다.
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    // bank-1 문서 없음.

    await expect(service.deposit('char-1', 'bank-1', 100)).rejects.toThrow()

    const char = await db.collection<Character>('characters').findOne({ _id: 'char-1' })
    expect(char?.gold).toBe(500) // step1이 커밋되지 않았다 — 전체 abort.
  })

  // === Completion Criterion 7: character.gold 상한 미부과 (schema min0-only, Open Q 3 seam) ===
  it('출금은 character.gold에 상한을 부과하지 않는다(schema min0-only, Open Q 3 미해결 seam)', async () => {
    // character가 이미 3억을 초과해도 출금 크레딧이 성공해야 한다(character 상한 미부과).
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: MAX_BANK_GOLD }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))

    await service.withdraw('char-1', 'bank-1', 500)

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(MAX_BANK_GOLD + 500) // 3억 상한 미부과.
    expect(after.bank).toBe(500)
  })

  // === 입력 검증: amount 양의 정수 (both methods) ===
  it('deposit: amount가 0 이하이면 트랜잭션 시작 전 거부한다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))

    await expect(service.deposit('char-1', 'bank-1', 0)).rejects.toThrow()
    await expect(service.deposit('char-1', 'bank-1', -5)).rejects.toThrow()
    await expect(service.deposit('char-1', 'bank-1', 1.5)).rejects.toThrow()

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(500)
    expect(after.bank).toBe(1000)
  })

  it('withdraw: amount가 0 이하이거나 정수가 아니면 트랜잭션 시작 전 거부한다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))

    await expect(service.withdraw('char-1', 'bank-1', 0)).rejects.toThrow()
    await expect(service.withdraw('char-1', 'bank-1', -5)).rejects.toThrow()
    await expect(service.withdraw('char-1', 'bank-1', 2.5)).rejects.toThrow()

    const after = await goldOf('char-1', 'bank-1')
    expect(after.char).toBe(500)
    expect(after.bank).toBe(1000)
  })

  // === 존재 확인 null 분기 (guarded 필터가 아닌 순수 부재) ===
  it('deposit: 은행 계좌가 존재하지 않으면 abort하고 character도 불변이다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    // bank 없음 → step2 매칭0.

    await expect(service.deposit('char-1', 'bank-1', 100)).rejects.toThrow()

    const char = await db.collection<Character>('characters').findOne({ _id: 'char-1' })
    expect(char?.gold).toBe(500)
  })

  it('deposit: 캐릭터가 존재하지 않으면 abort한다', async () => {
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))
    // character 없음 → step1 매칭0.

    await expect(service.deposit('char-1', 'bank-1', 100)).rejects.toThrow(InsufficientFundsError)

    const bank = await db.collection<BankAccount>('bankAccounts').findOne({ _id: 'bank-1' })
    expect(bank?.gold).toBe(1000)
  })

  it('withdraw: 캐릭터가 존재하지 않으면 DocumentNotFoundError로 abort하고 bank도 불변이다', async () => {
    // bank는 잔고 충분(step1 통과) — character credit(step2)에서 부재로 실패해야 한다.
    await db.collection<BankAccount>('bankAccounts').insertOne(makeBank({ gold: 1000 }))
    // character 없음.

    await expect(service.withdraw('char-1', 'bank-1', 100)).rejects.toThrow(DocumentNotFoundError)

    const bank = await db.collection<BankAccount>('bankAccounts').findOne({ _id: 'bank-1' })
    expect(bank?.gold).toBe(1000) // step1이 커밋되지 않았다 — 전체 abort.
  })

  it('withdraw: 은행 계좌가 존재하지 않으면 InsufficientFundsError로 abort한다', async () => {
    await db.collection<Character>('characters').insertOne(makeCharacter({ gold: 500 }))
    // bank 없음 → step1 매칭0.

    await expect(service.withdraw('char-1', 'bank-1', 100)).rejects.toThrow(InsufficientFundsError)

    const char = await db.collection<Character>('characters').findOne({ _id: 'char-1' })
    expect(char?.gold).toBe(500)
  })
})
