import { describe, it, expect } from 'vitest'
import { characterSummarySchema } from 'shared'
import { InMemorySessionAuthAdapter } from './inMemorySessionAuthAdapter.js'
import {
  createSeededAuthAdapter,
  SEED_VALID_COOKIE,
  SEED_ACCOUNT_ID,
  SEED_CHARACTER_ID,
} from './seedSessionAuth.testutil.js'
import type { CreateCharacterInput } from './sessionAuthPort.js'
import { OwnershipError } from './sessionAuthPort.js'

/** 전체 create_ply DTO 팩토리 — 인메모리 어댑터 테스트가 name/class/race만 관찰하므로 나머지는 기본값. */
function makeCreateDto(overrides: Partial<CreateCharacterInput> = {}): CreateCharacterInput {
  return {
    name: '신규영웅',
    gender: 1,
    class: 2,
    race: 3,
    stats: [10, 10, 10, 10, 10],
    weapon: 2,
    alignment: 1,
    ...overrides,
  }
}

/**
 * InMemorySessionAuthAdapter 계약 단위 테스트 — firebase 없이 결정적으로 포트 4개 메서드를
 * 검증한다. 유효 쿠키는 시드 어댑터에서만 존재하므로 validateSessionCookie 성공 경로는
 * createSeededAuthAdapter로 구성한 어댑터에서 실행한다. 포트는 async(Promise 반환)라 모든 호출을 await한다.
 */
describe('InMemorySessionAuthAdapter', () => {
  describe('validateSessionCookie', () => {
    it('시드된 유효 쿠키에 대해 AccountIdentity를 반환한다', async () => {
      const adapter = createSeededAuthAdapter()
      const identity = await adapter.validateSessionCookie(SEED_VALID_COOKIE)
      expect(identity).toEqual({ accountId: SEED_ACCOUNT_ID })
    })

    it('등록되지 않은 쿠키에 대해 null을 반환한다', async () => {
      const adapter = createSeededAuthAdapter()
      expect(await adapter.validateSessionCookie('unknown-cookie')).toBeNull()
    })

    it('빈 쿠키에 대해 null을 반환한다', async () => {
      const adapter = createSeededAuthAdapter()
      expect(await adapter.validateSessionCookie('')).toBeNull()
    })

    it('시드 없이 생성한 어댑터는 어떤 쿠키에도 null을 반환한다', async () => {
      const adapter = new InMemorySessionAuthAdapter()
      expect(await adapter.validateSessionCookie(SEED_VALID_COOKIE)).toBeNull()
    })
  })

  describe('listCharacters', () => {
    it('시드 account의 캐릭터 목록을 반환한다(1개 이상)', async () => {
      const adapter = createSeededAuthAdapter()
      const list = await adapter.listCharacters(SEED_ACCOUNT_ID)
      expect(list.length).toBeGreaterThanOrEqual(1)
    })

    it('알 수 없는 account는 빈 배열을 반환한다', async () => {
      const adapter = createSeededAuthAdapter()
      expect(await adapter.listCharacters('nobody')).toEqual([])
    })

    it('반환된 배열·원소를 변형해도 내부 저장소에 영향을 주지 않는다', async () => {
      const adapter = createSeededAuthAdapter()
      const first = await adapter.listCharacters(SEED_ACCOUNT_ID)
      first.push({ characterId: 'x', name: 'x', class: 0, race: 0, level: 1 })
      const originalName = first[0]!.name
      first[0]!.name = '변조됨'
      const second = await adapter.listCharacters(SEED_ACCOUNT_ID)
      expect(second.length).toBe(1)
      expect(second[0]!.name).toBe(originalName)
    })
  })

  describe('createCharacter', () => {
    it('생성한 캐릭터가 목록에 반영된다', async () => {
      const adapter = createSeededAuthAdapter()
      const before = (await adapter.listCharacters(SEED_ACCOUNT_ID)).length
      const created = await adapter.createCharacter(SEED_ACCOUNT_ID, makeCreateDto())
      const after = await adapter.listCharacters(SEED_ACCOUNT_ID)
      expect(after.length).toBe(before + 1)
      expect(after.some((c) => c.characterId === created.characterId)).toBe(true)
    })

    it('알 수 없는 account에 생성하면 그 account 목록에 추가된다', async () => {
      const adapter = new InMemorySessionAuthAdapter()
      const created = await adapter.createCharacter('newacct', makeCreateDto({ name: '탐험가', class: 1, race: 1 }))
      const list = await adapter.listCharacters('newacct')
      expect(list).toHaveLength(1)
      expect(list[0]!.characterId).toBe(created.characterId)
    })

    it('반환된 요약은 shared characterSummarySchema를 만족한다', async () => {
      const adapter = createSeededAuthAdapter()
      const created = await adapter.createCharacter(
        SEED_ACCOUNT_ID,
        makeCreateDto({ name: '검증대상', class: 4, race: 5 }),
      )
      expect(() => characterSummarySchema.parse(created)).not.toThrow()
      expect(created.characterId.length).toBeGreaterThan(0)
      expect(created.name).toBe('검증대상')
      expect(created.class).toBe(4)
      expect(created.race).toBe(5)
    })

    it('생성마다 고유한 characterId를 부여한다', async () => {
      const adapter = new InMemorySessionAuthAdapter()
      const a = await adapter.createCharacter('acct', makeCreateDto({ name: 'A', class: 0, race: 0 }))
      const b = await adapter.createCharacter('acct', makeCreateDto({ name: 'B', class: 0, race: 0 }))
      expect(a.characterId).not.toBe(b.characterId)
    })

    it('반환한 요약을 변형해도 내부 저장소에 영향을 주지 않는다', async () => {
      const adapter = new InMemorySessionAuthAdapter()
      const created = await adapter.createCharacter('acct', makeCreateDto({ name: '원본', class: 0, race: 0 }))
      created.name = '변조됨'
      const stored = (await adapter.listCharacters('acct'))[0]!
      expect(stored.name).toBe('원본')
    })
  })

  describe('assertOwnership', () => {
    it('소유한 캐릭터면 reject하지 않는다', async () => {
      const adapter = createSeededAuthAdapter()
      await expect(adapter.assertOwnership(SEED_ACCOUNT_ID, SEED_CHARACTER_ID)).resolves.toBeUndefined()
    })

    it('다른 account의 캐릭터면 OwnershipError로 reject한다', async () => {
      const adapter = createSeededAuthAdapter()
      await expect(adapter.assertOwnership('other-account', SEED_CHARACTER_ID)).rejects.toThrow(
        OwnershipError,
      )
    })

    it('존재하지 않는 캐릭터면 OwnershipError로 reject한다', async () => {
      const adapter = createSeededAuthAdapter()
      await expect(adapter.assertOwnership(SEED_ACCOUNT_ID, 'ghost')).rejects.toThrow(OwnershipError)
    })
  })

  describe('deleteCharacter', () => {
    it('소유한 캐릭터를 삭제하면 이후 목록에서 사라진다 (소프트 삭제)', async () => {
      const adapter = createSeededAuthAdapter()
      await adapter.deleteCharacter(SEED_ACCOUNT_ID, SEED_CHARACTER_ID)
      const list = await adapter.listCharacters(SEED_ACCOUNT_ID)
      expect(list.some((c) => c.characterId === SEED_CHARACTER_ID)).toBe(false)
    })

    it('타 계정 캐릭터 삭제는 OwnershipError로 reject하고 아무것도 지우지 않는다 (내부 이중 assert)', async () => {
      const adapter = createSeededAuthAdapter()
      await expect(adapter.deleteCharacter('other-account', SEED_CHARACTER_ID)).rejects.toThrow(
        OwnershipError,
      )
      // 정당 소유자의 목록엔 여전히 존재한다(삭제되지 않음).
      const list = await adapter.listCharacters(SEED_ACCOUNT_ID)
      expect(list.some((c) => c.characterId === SEED_CHARACTER_ID)).toBe(true)
    })

    it('존재하지 않는 캐릭터 삭제는 OwnershipError로 reject한다', async () => {
      const adapter = createSeededAuthAdapter()
      await expect(adapter.deleteCharacter(SEED_ACCOUNT_ID, 'ghost')).rejects.toThrow(OwnershipError)
    })
  })

  describe('createSeededAuthAdapter', () => {
    it('알려진 유효 쿠키가 시드 account로 매핑되고 캐릭터를 보유한다', async () => {
      const adapter = createSeededAuthAdapter()
      const identity = await adapter.validateSessionCookie(SEED_VALID_COOKIE)
      expect(identity).not.toBeNull()
      expect(identity?.accountId).toBe(SEED_ACCOUNT_ID)
      expect((await adapter.listCharacters(SEED_ACCOUNT_ID)).length).toBeGreaterThanOrEqual(1)
    })
  })
})
