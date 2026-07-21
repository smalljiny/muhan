import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { Db } from 'mongodb'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { Character } from 'shared'
import { PROTOCOL_VERSION } from 'shared'
import { buildApp } from '../app.js'
import { resetConfigForTests } from '../config/env.js'
import { AccountRepository } from '../repo/accountRepository.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { FirebaseSessionAuthAdapter } from '../auth/firebaseSessionAuthAdapter.js'
import type { SessionCookieVerifier } from '../auth/sessionCookieVerifier.js'
import { SEED_CHARACTER_ID } from '../auth/seedSessionAuth.testutil.js'
import {
  injectAuthedWS,
  createMessageReader,
  enterCommandState,
  waitFor,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'

// Story 7 T7.3 — account-character seam 통합 테스트.
//
// 실 firebase-admin을 쓰지 않는다(제약: 어댑터는 firebase-agnostic, 검증은 verifier seam으로 주입).
// FAKE verifier + 인메모리-Mongo AccountRepository·CharacterRepository로 조립한 FirebaseSessionAuthAdapter를
// buildApp에 주입해, 실제 WS 세션 흐름(select/enter/resume)이 account-character seam을 관통하는지 관찰한다.
//
// 대상 컴포넌트(FirebaseSessionAuthAdapter·buildApp)는 Story 5·기존 배선으로 이미 존재하므로 이 테스트는
// 첫 실행에 통과한다(RED을 만들지 않는다) — 가치는 seam을 실 WS 흐름으로 관통하는 신규 통합 커버리지다.
// 방 배치 내부(#74)는 범위 밖 — entered/resumed 결과만 단언하고 room-graph 배치는 검증하지 않는다.

/** FAKE verifier가 유효로 인정하는 쿠키. 실 firebase 쿠키가 아니라 테스트 결정 상수다. */
const FAKE_VALID_COOKIE = 'fake-valid-cookie'
/** 유효 쿠키가 매핑되는 인증 계정 uid(fake verifier 반환값 = 소유 캐릭터 accountId). */
const ACCT_A = 'acct-A'
/** 소유 불일치 케이스용 타 계정 uid. */
const ACCT_B = 'acct-B'
/** ACCT_B가 소유한 캐릭터 id(ACCT_A 세션이 선택하면 unauthorized). */
const OTHER_CHARACTER_ID = 'char-B'

/**
 * FAKE SessionCookieVerifier — FAKE_VALID_COOKIE만 인정하고 그 외는 null.
 * 실 firebase-admin verifySessionCookie 대체(어댑터는 이 seam에만 의존).
 */
const fakeVerifier: SessionCookieVerifier = (cookie) =>
  Promise.resolve(cookie === FAKE_VALID_COOKIE ? { uid: ACCT_A } : null)

/** 테스트용 유효 Character 팩토리 — 스키마 shape를 정확히 만족한다. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: SEED_CHARACTER_ID,
    name: '무한전사',
    class: 1,
    race: 1,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    level: 1,
    hpCurrent: 55,
    mpCurrent: 40,
    schemaVersion: 2,
    accountId: ACCT_A,
    status: 'active',
    ...overrides,
  }
}

describe('account-character seam 통합 (select/enter/resume)', () => {
  let harness: MongoTestDb
  let db: Db
  let objects: ObjectRepository
  let characters: CharacterRepository
  let accounts: AccountRepository
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_session_auth_flow_test')
    db = harness.db
    objects = new ObjectRepository(db)
    characters = new CharacterRepository(db, objects)
    accounts = new AccountRepository(db)
    await objects.init()
    await characters.init()
    await accounts.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    // getConfig()가 연결 핸들러에서 호출되므로 필수 env를 채워 fail-fast(process.exit)를 피한다.
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
    apps = []
    clients = []

    // 계정별 캐릭터 격리 후 시드 — ACCT_A 소유 1개(SEED_CHARACTER_ID), ACCT_B 소유 1개(OTHER_CHARACTER_ID).
    await db.collection('characters').deleteMany({})
    await db.collection('accounts').deleteMany({})
    await characters.insert(makeCharacter())
    await characters.insert(
      makeCharacter({ _id: OTHER_CHARACTER_ID, name: '타계정전사', accountId: ACCT_B }),
    )
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  /** FAKE verifier + Mongo 저장소로 조립한 실 어댑터를 buildApp에 주입한 app을 세운다. */
  async function buildAdapterApp(): Promise<FastifyInstance> {
    const adapter = new FirebaseSessionAuthAdapter(fakeVerifier, accounts, characters)
    const app = buildApp({ sessionAuth: adapter })
    apps.push(app)
    await app.ready()
    return app
  }

  /** 유효 쿠키로 게이트를 통과한 injectWS 클라이언트를 만들어 정리 목록에 등록한다. */
  async function authedClient(app: FastifyInstance): Promise<WebSocket> {
    const ws = await injectAuthedWS(app, { cookie: FAKE_VALID_COOKIE })
    clients.push(ws)
    return ws
  }

  it('소유 캐릭터 선택 → assertOwnership 통과 → session:entered + command 상태 진입', async () => {
    const app = await buildAdapterApp()
    const ws = await authedClient(app)

    // 인라인 walk — enterCommandState는 entered를 내부에서 삼켜 프레임 타입을 단언하지 못하므로 직접 왕복한다.
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    const characterList = await reader.next() // session:characterList
    await reader.next() // session:prompt(selectCharacter)

    // DB-backed listCharacters seam 증명 — 계정 소유 캐릭터가 목록에 실려 온다.
    expect(characterList.type).toBe('session:characterList')
    if (characterList.type === 'session:characterList') {
      expect(characterList.characters).toContainEqual(
        expect.objectContaining({ characterId: SEED_CHARACTER_ID, name: '무한전사' }),
      )
    }

    // 소유 캐릭터 선택 → assertOwnership 통과 → entered로 월드 진입(재연결이 아니므로 resumed가 아니라 entered).
    ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    const entered = await reader.next()
    expect(entered).toMatchObject({ type: 'session:entered', characterId: SEED_CHARACTER_ID })

    // command 도달 증명 — echo가 라우터 dispatch까지 관통해 되돌아온다.
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'a1' }))
    const echo = await reader.next()
    expect(echo).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'a1' })
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link).toBe('live')
  })

  it('타 계정 소유 캐릭터 선택 → OwnershipError → unauthorized 에러, command 미전이', async () => {
    const app = await buildAdapterApp()
    const ws = await authedClient(app)

    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // session:characterList
    await reader.next() // session:prompt(selectCharacter)

    // ACCT_A 세션이 ACCT_B 소유 캐릭터를 선택 → assertOwnership이 OwnershipError → unauthorized error.
    ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: OTHER_CHARACTER_ID }))
    const err = await reader.next()
    expect(err).toMatchObject({ type: 'error', code: 'unauthorized' })

    // command 미전이 증명 — 월드 진입도 없고(레지스트리 미등록), echo가 라우터에 도달하지 못한다.
    expect(app.wsSessionRegistry.get(OTHER_CHARACTER_ID)).toBeUndefined()
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)).toBeUndefined()
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'a2' }))
    const next = await reader.next()
    // echo:result가 아니라 error 거부가 온다(characterSelect 상태 유지 증거 — command 라우터 미도달).
    expect(next).toMatchObject({ type: 'error' })
  })

  it('link-dead 재접속 → 같은 캐릭터 select → session:resumed (재연결 seam 관통)', async () => {
    const app = await buildAdapterApp()

    // 첫 소켓으로 월드 진입 후 drop → link-dead(기본 grace 30s 창).
    const ws1 = await authedClient(app)
    await enterCommandState(ws1)
    const deadBinding = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    ws1.terminate()
    await waitFor(() => app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link === 'link-dead')

    // grace 내 새 소켓으로 재접속해 같은 캐릭터를 select → rebind되어 entered가 아니라 resumed가 발화된다.
    const ws2 = await authedClient(app)
    const reader = createMessageReader(ws2)
    await reader.next() // system:hello
    ws2.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // session:characterList
    await reader.next() // session:prompt(selectCharacter)
    ws2.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    const resumed = await reader.next()

    expect(resumed).toMatchObject({ type: 'session:resumed', characterId: SEED_CHARACTER_ID })
    const rebound = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(rebound?.link).toBe('live')
    expect(rebound).not.toBe(deadBinding)
    // command 상태가 복원돼 echo가 라우터에 도달한다.
    ws2.send(JSON.stringify({ type: 'debug:echo', text: '퐁', id: 'r1' }))
    const echo = await reader.next()
    expect(echo).toMatchObject({ type: 'debug:echo:result', text: '퐁', correlationId: 'r1' })
  })
})
