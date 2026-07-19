import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Db } from 'mongodb'
import type { Character } from 'shared'
import { AccountRepository } from '../repo/accountRepository.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { FirebaseSessionAuthAdapter } from './firebaseSessionAuthAdapter.js'
import type { SessionCookieVerifier } from './sessionCookieVerifier.js'
import { OwnershipError } from './sessionAuthPort.js'

/** 테스트용 유효 Character 팩토리 — characterRepository 픽스처와 동일 shape. */
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
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

describe('FirebaseSessionAuthAdapter (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let accounts: AccountRepository
  let characters: CharacterRepository
  let adapter: FirebaseSessionAuthAdapter
  // 제어 가능한 fake verifier — 각 테스트가 동작을 갈아끼운다.
  let verifierImpl: SessionCookieVerifier
  const verifier: SessionCookieVerifier = (cookie) => verifierImpl(cookie)
  // upsert 호출 횟수를 세는 spy — dedup 비-공허 검증용.
  let upsertSpy: MockInstance<AccountRepository['upsert']>

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_firebase_session_auth_test')
    db = harness.db
    accounts = new AccountRepository(db)
    const objects = new ObjectRepository(db)
    characters = new CharacterRepository(db, objects)
    await accounts.init()
    await objects.init()
    await characters.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('accounts').deleteMany({})
    await db.collection('characters').deleteMany({})
    // 기본 verifier: 'good-cookie'만 유효.
    verifierImpl = (cookie) =>
      Promise.resolve(cookie === 'good-cookie' ? { uid: 'uid-1' } : null)
    upsertSpy = vi.spyOn(accounts, 'upsert')
    adapter = new FirebaseSessionAuthAdapter(verifier, accounts, characters)
  })

  afterEach(() => {
    upsertSpy.mockRestore()
  })

  describe('validateSessionCookie', () => {
    it('유효 쿠키 → uid를 accountId로 반환한다', async () => {
      const identity = await adapter.validateSessionCookie('good-cookie')
      expect(identity).toEqual({ accountId: 'uid-1' })
    })

    it('무효 쿠키(verifier null) → null을 반환한다', async () => {
      const identity = await adapter.validateSessionCookie('bad-cookie')
      expect(identity).toBeNull()
    })

    it('verifier가 throw하면 → null을 반환한다(throw를 삼킨다)', async () => {
      verifierImpl = () => Promise.reject(new Error('만료된 세션 쿠키'))
      const identity = await adapter.validateSessionCookie('good-cookie')
      expect(identity).toBeNull()
    })

    it('최초 validate는 accounts.upsert로 계정을 생성한다', async () => {
      await adapter.validateSessionCookie('good-cookie')
      const account = await accounts.findById('uid-1')
      expect(account).not.toBeNull()
      expect(account?._id).toBe('uid-1')
      expect(upsertSpy).toHaveBeenCalledTimes(1)
    })

    it('동일 accountId 재validate는 upsert를 반복하지 않는다(dedup)', async () => {
      await adapter.validateSessionCookie('good-cookie')
      await adapter.validateSessionCookie('good-cookie')
      expect(upsertSpy).toHaveBeenCalledTimes(1)
    })

    it('upsert가 실패하면 dedup 캐시에 남지 않고 다음 validate에서 재시도한다(캐시 오염 방지)', async () => {
      // 첫 upsert를 강제 실패시킨다 — 실패한 accountId가 "seen"으로 캐시되면 영영 재upsert 안 되므로,
      // 실패는 캐시에 남지 않아야 한다. 인프라 실패는 auth 실패(null)로 삼켜지지 않고 전파된다.
      upsertSpy.mockRejectedValueOnce(new Error('일시적 DB 오류'))
      await expect(adapter.validateSessionCookie('good-cookie')).rejects.toThrow('일시적 DB 오류')
      // 재시도: 이번엔 upsert가 성공해야 하고(캐시 미오염), 계정이 실제로 생성된다.
      const identity = await adapter.validateSessionCookie('good-cookie')
      expect(identity).toEqual({ accountId: 'uid-1' })
      expect(upsertSpy).toHaveBeenCalledTimes(2)
      expect(await accounts.findById('uid-1')).not.toBeNull()
    })
  })

  describe('listCharacters', () => {
    it('매핑된 요약(characterId=_id, level=1)을 반환하고 삭제된 캐릭터는 제외한다', async () => {
      await characters.insert(makeCharacter({ _id: 'c1', name: '가', accountId: 'uid-1', class: 3, race: 4 }))
      await characters.insert(makeCharacter({ _id: 'c2', name: '나', accountId: 'uid-1' }))
      await characters.insert(
        makeCharacter({
          _id: 'c3',
          name: '무덤',
          accountId: 'uid-1',
          status: 'deleted',
          deletedAt: new Date(),
        }),
      )
      await characters.insert(makeCharacter({ _id: 'c4', name: '남', accountId: 'other' }))

      const summaries = await adapter.listCharacters('uid-1')
      expect(summaries.map((s) => s.characterId).sort()).toEqual(['c1', 'c2'])
      const c1 = summaries.find((s) => s.characterId === 'c1')
      expect(c1).toEqual({ characterId: 'c1', name: '가', class: 3, race: 4, level: 1 })
    })

    it('캐릭터가 없으면 빈 배열을 반환한다', async () => {
      const summaries = await adapter.listCharacters('uid-empty')
      expect(summaries).toEqual([])
    })
  })

  describe('assertOwnership', () => {
    it('소유한 캐릭터는 resolve한다', async () => {
      await characters.insert(makeCharacter({ _id: 'own', name: '내캐릭', accountId: 'uid-1' }))
      await expect(adapter.assertOwnership('uid-1', 'own')).resolves.toBeUndefined()
    })

    it('타 계정 캐릭터는 OwnershipError를 던진다', async () => {
      await characters.insert(makeCharacter({ _id: 'other-c', name: '남캐릭', accountId: 'other' }))
      await expect(adapter.assertOwnership('uid-1', 'other-c')).rejects.toThrow(OwnershipError)
    })

    it('존재하지 않는 캐릭터는 OwnershipError를 던진다', async () => {
      await expect(adapter.assertOwnership('uid-1', 'nope')).rejects.toThrow(OwnershipError)
    })
  })

  describe('createCharacter', () => {
    /** 전체 create_ply DTO 팩토리 — 케이스별로 override한다. */
    function makeDto(overrides: Partial<Parameters<typeof adapter.createCharacter>[1]> = {}) {
      return {
        name: '새캐릭',
        gender: 1,
        class: 2,
        race: 5, // HUMAN [+0,+0,+1,+0,+0]
        stats: [10, 10, 10, 10, 10] as [number, number, number, number, number],
        weapon: 2,
        alignment: 1,
        ...overrides,
      }
    }

    it('Character를 삽입하고(accountId·gold=500·종족보정 스탯) CharacterSummary를 반환한다', async () => {
      const summary = await adapter.createCharacter('uid-1', makeDto())

      expect(summary.name).toBe('새캐릭')
      expect(summary.class).toBe(2)
      expect(summary.race).toBe(5)
      expect(summary.level).toBe(1)
      expect(summary.characterId).toMatch(/.+/)

      const persisted = await characters.findById(summary.characterId)
      expect(persisted).not.toBeNull()
      expect(persisted?.accountId).toBe('uid-1')
      expect(persisted?.gold).toBe(500)
      // HUMAN 보정 [+0,+0,+1,+0,+0]: 맷집만 +1.
      expect(persisted?.stats).toEqual([10, 10, 11, 10, 10])
      expect(persisted?.name).toBe('새캐릭')
      expect(persisted?.status).toBe('active')
    })

    it('gender·weapon·alignment를 선택 필드로 영속한다', async () => {
      const summary = await adapter.createCharacter('uid-1', makeDto({ gender: 2, weapon: 5, alignment: 2 }))
      const persisted = await characters.findById(summary.characterId)
      expect(persisted?.gender).toBe(2)
      expect(persisted?.weapon).toBe(5)
      expect(persisted?.alignment).toBe(2)
    })

    it('종족 보정을 포인트바이 스탯에 더하되 3~18을 벗어나도 재클램프하지 않는다 (no-clamp 양방향 증거)', async () => {
      // 포인트바이 [18,3,3,18,3](합 45 ≤54, 각 3~18) + HALFGIANT(7) [+2,0,0,-1,-1]
      //   → 저장 [20,3,3,17,2]: 힘 20(>18)·신앙 2(<3) 둘 다 미클램프.
      const summary = await adapter.createCharacter(
        'uid-1',
        makeDto({ race: 7, stats: [18, 3, 3, 18, 3] }),
      )
      const persisted = await characters.findById(summary.characterId)
      expect(persisted?.stats).toEqual([20, 3, 3, 17, 2])
    })
  })

  describe('deleteCharacter', () => {
    it('소유한 캐릭터를 소프트 삭제한다 (findById 보존·status=deleted, findByAccount 제외)', async () => {
      await characters.insert(makeCharacter({ _id: 'del', name: '삭제대상', accountId: 'uid-1' }))

      await adapter.deleteCharacter('uid-1', 'del')

      // 물리 보존 측: 문서는 남되 무덤 상태로 표시된다.
      const persisted = await characters.findById('del')
      expect(persisted?.status).toBe('deleted')
      expect(persisted?.deletedAt).toBeInstanceOf(Date)
      // 논리 부재 측: 목록에서 사라진다(재로그인 차단).
      expect(await adapter.listCharacters('uid-1')).toEqual([])
    })

    it('타 계정 캐릭터 삭제는 OwnershipError를 던지고 소프트 삭제하지 않는다 (내부 이중 assert)', async () => {
      await characters.insert(makeCharacter({ _id: 'other-del', name: '남캐릭', accountId: 'other' }))

      await expect(adapter.deleteCharacter('uid-1', 'other-del')).rejects.toThrow(OwnershipError)

      // 내부 assertOwnership이 막아 softDelete가 실행되지 않는다(여전히 active).
      const persisted = await characters.findById('other-del')
      expect(persisted?.status).toBe('active')
    })

    it('존재하지 않는 캐릭터 삭제는 OwnershipError를 던진다', async () => {
      await expect(adapter.deleteCharacter('uid-1', 'nope')).rejects.toThrow(OwnershipError)
    })
  })
})
