import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ObjectInstance } from 'shared'
import { ObjectRepository } from '../repo/objectRepository.js'
import { BankRepository } from '../repo/bankRepository.js'
import { DocumentNotFoundError } from '../repo/types.js'
import {
  BankItemService,
  BankSlotFullError,
  ContainerNotStorableError,
  InvalidOwnerError,
  BANK_SLOT_LIMIT,
} from './bankItemService.js'

/**
 * 은행 아이템 보관/인출 단위 테스트 — objectRepository·bankRepository를 mock으로 주입한다.
 * 오라클(bank.c input_bank) 거부 순서(slot FIRST → container SECOND)와 소유권 검증,
 * owner 재지정 write를 spy로 확인한다. 실제 DB 왕복은 integration 테스트가 담당한다.
 */

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

/** 길이 n의 더미 holdings 배열(내용은 무관, 길이만 slot 판정에 쓰인다). */
function holdingsOfLength(n: number): ObjectInstance[] {
  return Array.from({ length: n }, (_, i) => makeObject({ _id: `held-${i}`, owner: { type: 'bank', id: 'bank-1' } }))
}

type Mocks = {
  service: BankItemService
  findById: ReturnType<typeof vi.fn>
  updateById: ReturnType<typeof vi.fn>
  hydrateHoldings: ReturnType<typeof vi.fn>
}

function makeService(): Mocks {
  const findById = vi.fn()
  const updateById = vi.fn()
  const hydrateHoldings = vi.fn()
  const objects = { findById, updateById } as unknown as ObjectRepository
  const banks = { hydrateHoldings } as unknown as BankRepository
  return { service: new BankItemService(objects, banks), findById, updateById, hydrateHoldings }
}

const injectionIds = [
  ['빈 문자열', ''],
  ['객체($ne 주입)', { $ne: '' }],
  ['객체($gt 주입)', { $gt: '' }],
  ['null', null],
  ['number', 42],
] as const

describe('BankItemService (unit, mocked repos)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('bankStore 입력 가드', () => {
    it.each(injectionIds)('objectId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById, hydrateHoldings } = makeService()
      await expect(
        service.bankStore({ objectId: id as unknown as string, bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow('objectId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
      expect(hydrateHoldings).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('bankAccountId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById, hydrateHoldings } = makeService()
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: id as unknown as string, characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow('bankAccountId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
      expect(hydrateHoldings).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('characterId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById, hydrateHoldings } = makeService()
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: id as unknown as string, isContainer: false }),
      ).rejects.toThrow('characterId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
      expect(hydrateHoldings).not.toHaveBeenCalled()
    })
  })

  describe('bankStore slot 한도(오라클 shotsmax=200, slot FIRST)', () => {
    it('holdings 길이가 200이면 BankSlotFullError를 던진다', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(BANK_SLOT_LIMIT))
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow(BankSlotFullError)
      // slot 거부 시 아이템을 fetch·이동하지 않는다.
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
    })

    it('holdings 길이가 199이면 진행해 owner를 bank로 재지정한다(200번째 저장 성공)', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(BANK_SLOT_LIMIT - 1))
      findById.mockResolvedValue(makeObject({ owner: { type: 'character', id: 'char-1' } }))
      updateById.mockResolvedValue(undefined)

      await service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false })

      expect(updateById).toHaveBeenCalledWith('obj-1', { owner: { type: 'bank', id: 'bank-1' } })
    })
  })

  describe('bankStore OCONTN 컨테이너 거부(slot 다음 SECOND)', () => {
    it('isContainer=true면 ContainerNotStorableError를 던진다(slot은 통과)', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(0))
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: true }),
      ).rejects.toThrow(ContainerNotStorableError)
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
    })
  })

  describe('bankStore 소유권 검증', () => {
    it('findById가 null이면 DocumentNotFoundError를 던진다', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(0))
      findById.mockResolvedValue(null)
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow(DocumentNotFoundError)
      expect(updateById).not.toHaveBeenCalled()
    })

    it('이미 은행 소유(bank)인 아이템은 InvalidOwnerError를 던진다', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(0))
      findById.mockResolvedValue(makeObject({ owner: { type: 'bank', id: 'bank-1' } }))
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow(InvalidOwnerError)
      expect(updateById).not.toHaveBeenCalled()
    })

    it('다른 캐릭터 소유 아이템은 InvalidOwnerError를 던진다(actor↔item 바인딩, bankWithdraw와 대칭)', async () => {
      const { service, hydrateHoldings, findById, updateById } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(0))
      findById.mockResolvedValue(makeObject({ owner: { type: 'character', id: 'char-2' } }))
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: false }),
      ).rejects.toThrow(InvalidOwnerError)
      expect(updateById).not.toHaveBeenCalled()
    })
  })

  describe('bankStore 오라클 거부 순서(slot BEFORE container)', () => {
    it('holdings=200 AND isContainer=true면 BankSlotFullError가 이긴다(slot 우선)', async () => {
      const { service, hydrateHoldings } = makeService()
      hydrateHoldings.mockResolvedValue(holdingsOfLength(BANK_SLOT_LIMIT))
      await expect(
        service.bankStore({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1', isContainer: true }),
      ).rejects.toThrow(BankSlotFullError)
    })
  })

  describe('bankWithdraw 입력 가드', () => {
    it.each(injectionIds)('objectId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById } = makeService()
      await expect(
        service.bankWithdraw({ objectId: id as unknown as string, bankAccountId: 'bank-1', characterId: 'char-1' }),
      ).rejects.toThrow('objectId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('bankAccountId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById } = makeService()
      await expect(
        service.bankWithdraw({ objectId: 'obj-1', bankAccountId: id as unknown as string, characterId: 'char-1' }),
      ).rejects.toThrow('bankAccountId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
    })

    it.each(injectionIds)('characterId가 %s면 throw하고 어떤 repo도 호출하지 않는다', async (_label, id) => {
      const { service, findById, updateById } = makeService()
      await expect(
        service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: id as unknown as string }),
      ).rejects.toThrow('characterId')
      expect(findById).not.toHaveBeenCalled()
      expect(updateById).not.toHaveBeenCalled()
    })
  })

  describe('bankWithdraw 소유권 검증·재지정', () => {
    it('findById가 null이면 DocumentNotFoundError를 던진다', async () => {
      const { service, findById, updateById } = makeService()
      findById.mockResolvedValue(null)
      await expect(
        service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1' }),
      ).rejects.toThrow(DocumentNotFoundError)
      expect(updateById).not.toHaveBeenCalled()
    })

    it('이 은행 계좌 소유가 아니면 InvalidOwnerError를 던진다(character 소유)', async () => {
      const { service, findById, updateById } = makeService()
      findById.mockResolvedValue(makeObject({ owner: { type: 'character', id: 'char-1' } }))
      await expect(
        service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1' }),
      ).rejects.toThrow(InvalidOwnerError)
      expect(updateById).not.toHaveBeenCalled()
    })

    it('다른 은행 계좌 소유면 InvalidOwnerError를 던진다', async () => {
      const { service, findById, updateById } = makeService()
      findById.mockResolvedValue(makeObject({ owner: { type: 'bank', id: 'bank-OTHER' } }))
      await expect(
        service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1' }),
      ).rejects.toThrow(InvalidOwnerError)
      expect(updateById).not.toHaveBeenCalled()
    })

    it('이 은행 소유 아이템은 owner를 character로 재지정한다', async () => {
      const { service, findById, updateById } = makeService()
      findById.mockResolvedValue(makeObject({ owner: { type: 'bank', id: 'bank-1' } }))
      updateById.mockResolvedValue(undefined)

      await service.bankWithdraw({ objectId: 'obj-1', bankAccountId: 'bank-1', characterId: 'char-1' })

      expect(updateById).toHaveBeenCalledWith('obj-1', { owner: { type: 'character', id: 'char-1' } })
    })
  })
})
