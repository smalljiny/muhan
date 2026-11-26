import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest'
import type { Collection } from 'mongodb'
import { assembleSessionAuth } from './sessionAuthAssembly.js'
import { buildDevSeedCharacterDoc } from './devSeedCharacter.js'
import { DEV_SEED_CHARACTER } from './devSeedSessionAuth.js'
import { FirebaseSessionAuthAdapter } from './firebaseSessionAuthAdapter.js'
import type { SessionCookieVerifier } from './sessionCookieVerifier.js'
import { EnvSchema } from '../config/env.js'
import { AccountRepository } from '../repo/accountRepository.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'

/** raw 문서 직접 주입·조회용 컬렉션 스키마 — 문자열 _id를 강제하고 임의 필드를 허용한다. */
type RawCharacterDoc = { _id: string } & Record<string, unknown>

const SEED_COOKIE = 'dev-seed-cookie-assembly'
const SEED_ACCOUNT = 'dev-account-1'
const OTHER_ACCOUNT = 'other-account-9'
const SEED_ID = DEV_SEED_CHARACTER.characterId

/** EnvSchema 필수 항목(MONGODB_URI·WS_ALLOWED_ORIGINS)을 채운 뒤 실제 env 파싱을 거쳐 config를 만든다. */
function parseConfig(overrides: Record<string, string>) {
  return EnvSchema.parse({
    MONGODB_URI: 'mongodb://localhost:27017',
    WS_ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  })
}

const DEV_ENV = {
  NODE_ENV: 'development',
  DEV_LOGIN_ENABLED: 'true',
  DEV_SEED_COOKIE: SEED_COOKIE,
  DEV_SEED_ACCOUNT_ID: SEED_ACCOUNT,
}

/** fake Firebase verifier 팩토리 — firebase-admin 없이 호출 여부·인자만 관측한다. */
function fakeCreateVerifier() {
  const verifier: SessionCookieVerifier = () => Promise.resolve(null)
  return vi.fn((_projectId: string) => verifier)
}

describe('assembleSessionAuth (integration)', () => {
  let harness: MongoTestDb
  let raw: Collection<RawCharacterDoc>
  let characters: CharacterRepository
  let accounts: AccountRepository
  let insertSpy: MockInstance<CharacterRepository['insertIfAbsent']>

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_session_auth_assembly_test')
    raw = harness.db.collection<RawCharacterDoc>('characters')
    const objects = new ObjectRepository(harness.db)
    characters = new CharacterRepository(harness.db, objects)
    accounts = new AccountRepository(harness.db)
    await Promise.all([objects.init(), characters.init(), accounts.init()])
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await raw.deleteMany({})
    insertSpy = vi.spyOn(characters, 'insertIfAbsent')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dev 설정이면 시드를 삽입하고 dev 어댑터·쿠키를 돌려주며, 재호출 시 kept다', async () => {
    const createVerifier = fakeCreateVerifier()
    const config = parseConfig(DEV_ENV)

    const result = await assembleSessionAuth(config, { accounts, characters, createVerifier })

    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(result.devSeedResult).toBe('inserted')
    expect(result.devLoginSeedCookie).toBe(SEED_COOKIE)
    expect(createVerifier).not.toHaveBeenCalled()
    const stored = await raw.findOne({ _id: SEED_ID })
    expect(stored?.accountId).toBe(SEED_ACCOUNT)
    const listed = await result.sessionAuth.listCharacters(SEED_ACCOUNT)
    expect(listed.map((c) => c.characterId)).toContain(SEED_ID)

    const again = await assembleSessionAuth(config, { accounts, characters, createVerifier })
    expect(again.devSeedResult).toBe('kept')
  })

  it('플래그 off면 Firebase 어댑터를 조립하고 시드 쓰기는 0회다', async () => {
    const createVerifier = fakeCreateVerifier()
    const config = parseConfig({ DEV_LOGIN_ENABLED: 'false', FIREBASE_PROJECT_ID: 'test-project' })

    const result = await assembleSessionAuth(config, { accounts, characters, createVerifier })

    expect(result.sessionAuth).toBeInstanceOf(FirebaseSessionAuthAdapter)
    expect(createVerifier).toHaveBeenCalledTimes(1)
    expect(createVerifier).toHaveBeenCalledWith('test-project')
    expect(result.devSeedResult).toBeUndefined()
    expect(result.devLoginSeedCookie).toBeUndefined()
    expect(insertSpy).not.toHaveBeenCalled()
    expect(await raw.countDocuments()).toBe(0)
  })

  it.each([
    ['미설정', {}],
    ['빈 문자열', { FIREBASE_PROJECT_ID: '' }],
  ])(
    '플래그 off이고 FIREBASE_PROJECT_ID가 %s이면 기존 메시지로 reject한다',
    async (_label, env) => {
      const createVerifier = fakeCreateVerifier()
      const config = parseConfig({ DEV_LOGIN_ENABLED: 'false', ...env })

      await expect(
        assembleSessionAuth(config, { accounts, characters, createVerifier }),
      ).rejects.toThrow('FIREBASE_PROJECT_ID가 필요하다')
      expect(createVerifier).not.toHaveBeenCalled()
      expect(insertSpy).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['production', { NODE_ENV: 'production' }],
    ['미설정', {}],
  ])(
    '플래그 on인데 NODE_ENV가 %s이면 dev 경로를 조립하지 않고 시드를 쓰지 않는다',
    async (_label, nodeEnv) => {
      const { NODE_ENV: _dropped, ...devWithoutNodeEnv } = DEV_ENV
      const config = parseConfig({ ...devWithoutNodeEnv, ...nodeEnv })

      await expect(
        assembleSessionAuth(config, {
          accounts,
          characters,
          createVerifier: fakeCreateVerifier(),
        }),
      ).rejects.toThrow('DEV_LOGIN_ENABLED requires NODE_ENV=development or test')
      expect(insertSpy).not.toHaveBeenCalled()
      expect(await raw.countDocuments()).toBe(0)
    },
  )

  it('플래그 on인데 시드 쿠키가 비면 dev 어댑터 검증으로 reject하고 시드를 쓰지 않는다', async () => {
    const config = parseConfig({ ...DEV_ENV, DEV_SEED_COOKIE: '' })

    await expect(
      assembleSessionAuth(config, {
        accounts,
        characters,
        createVerifier: fakeCreateVerifier(),
      }),
    ).rejects.toThrow('dev 시드 인증 조립 실패')
    expect(insertSpy).not.toHaveBeenCalled()
    expect(await raw.countDocuments()).toBe(0)
  })

  it('플래그 on이고 다른 계정 소유 시드 문서가 있으면 reject가 호출자로 전파된다', async () => {
    await raw.insertOne(buildDevSeedCharacterDoc(OTHER_ACCOUNT))
    const before = await raw.findOne({ _id: SEED_ID })
    const config = parseConfig(DEV_ENV)

    await expect(
      assembleSessionAuth(config, {
        accounts,
        characters,
        createVerifier: fakeCreateVerifier(),
      }),
    ).rejects.toThrow('dev 시드 캐릭터 정합 실패')
    expect(await raw.findOne({ _id: SEED_ID })).toEqual(before)
  })
})
