import { describe, it, expect, vi } from 'vitest'
import type { Db, MongoClient } from 'mongodb'
import { BankTransactionService } from './bankTransactionService.js'

/**
 * 입력 가드 단위 테스트 — amount·id 검증은 트랜잭션(startSession) 시작 전에 throw하므로 Mongo가
 * 필요 없다. client.startSession을 절대 호출하면 안 됨을 spy로 확인해, 가드가 money 경로 진입점에서
 * 먼저 작동함을 검증한다. CAS 트랜잭션 동작 자체는 integration 테스트가 담당한다.
 */
describe('BankTransactionService 입력 가드 (unit)', () => {
  function makeService(): { service: BankTransactionService; startSession: ReturnType<typeof vi.fn> } {
    const startSession = vi.fn(() => {
      throw new Error('startSession이 호출되면 안 된다 — 가드가 먼저 throw해야 한다')
    })
    const client = { startSession } as unknown as MongoClient
    const db = {} as unknown as Db
    return { service: new BankTransactionService(client, db), startSession }
  }

  const badAmounts: Array<[string, number]> = [
    ['0', 0],
    ['음수', -5],
    ['소수', 1.5],
    ['NaN', Number.NaN],
  ]

  const injectionIds = [
    ['빈 문자열', ''],
    ['객체($ne 주입)', { $ne: '' }],
    ['객체($gt 주입)', { $gt: '' }],
    ['null', null],
    ['number', 42],
  ] as const

  describe('deposit', () => {
    it.each(badAmounts)('amount가 %s면 throw하고 트랜잭션을 시작하지 않는다', async (_label, amount) => {
      const { service, startSession } = makeService()
      await expect(service.deposit('c1', 'b1', amount)).rejects.toThrow('양의 정수')
      expect(startSession).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('characterId가 %s면 throw한다(연산자 주입 차단)', async (_label, id) => {
      const { service, startSession } = makeService()
      await expect(service.deposit(id as unknown as string, 'b1', 100)).rejects.toThrow('characterId')
      expect(startSession).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('bankAccountId가 %s면 throw한다(연산자 주입 차단)', async (_label, id) => {
      const { service, startSession } = makeService()
      await expect(service.deposit('c1', id as unknown as string, 100)).rejects.toThrow('bankAccountId')
      expect(startSession).not.toHaveBeenCalled()
    })
  })

  describe('withdraw', () => {
    it.each(badAmounts)('amount가 %s면 throw하고 트랜잭션을 시작하지 않는다', async (_label, amount) => {
      const { service, startSession } = makeService()
      await expect(service.withdraw('c1', 'b1', amount)).rejects.toThrow('양의 정수')
      expect(startSession).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('characterId가 %s면 throw한다(연산자 주입 차단)', async (_label, id) => {
      const { service, startSession } = makeService()
      await expect(service.withdraw(id as unknown as string, 'b1', 100)).rejects.toThrow('characterId')
      expect(startSession).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('bankAccountId가 %s면 throw한다(연산자 주입 차단)', async (_label, id) => {
      const { service, startSession } = makeService()
      await expect(service.withdraw('c1', id as unknown as string, 100)).rejects.toThrow('bankAccountId')
      expect(startSession).not.toHaveBeenCalled()
    })
  })
})
