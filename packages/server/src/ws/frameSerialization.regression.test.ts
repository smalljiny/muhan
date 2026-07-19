import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { PROTOCOL_VERSION, type CharacterSummary } from 'shared'
import { resetConfigForTests } from '../config/env.js'
import type { SessionAuthPort } from '../auth/sessionAuthPort.js'
import { gameAuthPreValidation } from './plugin.js'
import { createConnectionQuota } from './connectionQuota.js'
import {
  SEED_VALID_COOKIE,
  SEED_ACCOUNT_ID,
  SEED_CHARACTER_ID,
} from '../auth/seedSessionAuth.testutil.js'
import {
  buildSeededApp,
  injectAuthedWS,
  createMessageReader,
  waitFor,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'

/**
 * Story 4 회귀 스펙 — SessionAuthPort async 마이그레이션이 도입한 위험 3종을 고정한다.
 *
 *  (1) *프레임* 재진입 직렬화: message 핸들러가 async가 되면 ws는 리스너를 await하지 않으므로, 프레임 2의
 *      'message'가 프레임 1의 포트 await 도중 시작돼 공유 상태를 동시 변이할 수 있다. per-connection 큐가
 *      프레임 N+1을 프레임 N 완결 뒤로 미뤄 이 *프레임 대 프레임* 재진입을 막는다 — emit 순서·차단으로 검증한다.
 *  (2) 프레임 대 close 레이스: 'close'는 frameTail 큐와 별개 리스너라 프레임 직렬화로 못 막는다 — FSM이 포트
 *      await로 멈춘 사이 소켓이 닫히면 재개 후 죽은 연결을 월드에 등록(좀비 바인딩·형제 evict)하려 한다.
 *      ctx.closed 플래그 + FSM isClosed 가드가 command 진입 전에 bail시킨다.
 *  (3) async-gap liveness: validateSessionCookie가 async라 그 await 도중 소켓이 파괴될 수 있다. reserve~:245
 *      destroyed 체크 구간이 여전히 완전 동기라, await 도중 파괴된 소켓의 정원 슬롯도 :245가 직접 반납한다.
 */

/** 다음 매크로태스크까지 양보해, 큐에 실린 마이크로태스크(processFrame)가 진행하게 한다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('Story 4 회귀: 프레임 직렬화 + async-gap liveness', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
  })

  afterEach(() => {
    process.env = savedEnv
    resetConfigForTests()
  })

  // ── (1) 프레임 재진입 직렬화 ─────────────────────────────────────────────────
  it('프레임 1의 포트 await 도중 도착한 프레임 2는 프레임 1 완결 전까지 처리되지 않는다', async () => {
    // listCharacters를 수동 resolve 가능한 deferred로 둔다 — accept(프레임 1) 경로가 이 포트를 await하며
    // characterSelect.onEnter에서 멈춘다. 그 사이 프레임 2(malformed JSON → bad_payload)를 투입한다.
    let resolveList: ((chars: CharacterSummary[]) => void) | undefined
    const listGate = new Promise<CharacterSummary[]>((resolve) => {
      resolveList = resolve
    })
    const fakeAuth: SessionAuthPort = {
      validateSessionCookie: (cookie) =>
        Promise.resolve(cookie === SEED_VALID_COOKIE ? { accountId: 'acc-1' } : null),
      listCharacters: () => listGate,
      createCharacter: () => Promise.reject(new Error('이 테스트에서 미사용')),
      assertOwnership: () => Promise.resolve(),
      deleteCharacter: () => Promise.resolve(),
    }

    const app = buildSeededApp({ sessionAuth: fakeAuth })
    await app.ready()

    const ws = await injectAuthedWS(app)
    // 도착 프레임을 순서대로 누적하는 수동 컬렉터(타임아웃 후 잔존 waiter가 다음 프레임을 삼키는 reader 대신 사용).
    const received: Array<{ type: string; code?: string }> = []
    ws.on('message', (data: unknown) => {
      received.push(JSON.parse(String(data)) as { type: string; code?: string })
    })
    await waitFor(() => received.some((e) => e.type === 'system:hello'))
    const base = received.length // system:hello까지 소비한 기준선.

    // 프레임 1: system:ready → accept → enterInitialState → listCharacters(deferred)에서 멈춘다.
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    // 프레임 2: malformed JSON → processFrame 파싱 실패 → bad_payload. 큐가 없으면 프레임 1이 await로 멈춘 사이
    // 이 프레임이 즉시 처리돼 bad_payload가 characterList보다 먼저 나간다(재진입).
    ws.send('{ not json 2')

    // 프레임 1이 listCharacters await에서 멈추도록 한 매크로태스크 양보한다.
    await tick()

    // 차단 단언: listCharacters를 아직 resolve하지 않아 프레임 1은 어떤 emit도 하지 않았고, 큐가 프레임 2를 프레임
    // 1 뒤로 미뤄 bad_payload도 나오지 않는다 — 이 구간에 새 프레임이 하나도 도착하지 않아야 한다(큐 제거 시 실패).
    expect(received.length).toBe(base)

    // 프레임 1을 완결시킨다 → characterList + prompt emit → 그제서야 큐가 프레임 2(bad_payload)를 처리한다.
    resolveList?.([])
    await waitFor(() => received.length >= base + 3)

    // emit 순서 단언: 프레임 1의 두 emit이 프레임 2의 emit보다 앞선다(재진입이면 bad_payload가 앞섰다).
    expect(received.slice(base, base + 2).map((e) => e.type)).toEqual([
      'session:characterList',
      'session:prompt',
    ])
    expect(received[base + 2]).toMatchObject({ type: 'error', code: 'bad_payload' })

    // 공유 상태 무결성: 재진입이 없었으므로 상태는 characterSelect, createProgress는 null로 온전하다.
    const ctx = [...app.wsConnections.values()][0]
    expect(ctx?.state).toBe('characterSelect')
    expect(ctx?.createProgress).toBeNull()

    ws.terminate()
    await app.close()
  })

  // ── (1b) 큐 격리 — 한 프레임의 오류가 큐를 정지시키지 않는다(trap #1) ────────────
  it('한 프레임의 내부 오류(포트 reject)가 큐를 멈추지 않고 다음 프레임이 계속 처리된다', async () => {
    // assertOwnership이 OwnershipError가 아닌 일반 오류로 reject한다 → FSM handleInput이 이를 전파 →
    // processFrame의 방어 try/catch가 error{internal}로 격리하고 resolve한다(큐 유지). 이어진 프레임이 처리돼야 한다.
    const fakeAuth: SessionAuthPort = {
      validateSessionCookie: (cookie) =>
        Promise.resolve(cookie === SEED_VALID_COOKIE ? { accountId: 'acc-1' } : null),
      listCharacters: () =>
        Promise.resolve([
          { characterId: SEED_CHARACTER_ID, name: '무한전사', class: 1, race: 1, level: 5 },
        ]),
      createCharacter: () => Promise.reject(new Error('이 테스트에서 미사용')),
      assertOwnership: () => Promise.reject(new Error('어댑터 내부 오류(비-Ownership)')),
      deleteCharacter: () => Promise.resolve(),
    }

    const app = buildSeededApp({ sessionAuth: fakeAuth })
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // session:characterList
    await reader.next() // session:prompt

    // 프레임 A: 소유 캐릭터 선택 → assertOwnership이 일반 오류로 reject → internal 오류로 격리.
    ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    // 프레임 B: malformed → bad_payload. 큐가 프레임 A의 reject로 정지했다면 이 응답이 오지 않는다.
    ws.send('{ not json B')

    expect(await reader.next()).toMatchObject({ type: 'error', code: 'internal' })
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'bad_payload' })

    // 큐가 살아 있어 연결이 계속 프레임을 받는다(정지 없음).
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  // ── (1c) 드롭 응답 대 지연 accept 응답 순서 보존 ─────────────────────────────
  it('앞 프레임(accept)의 지연 응답이 뒤 프레임(rate drop-warn)의 응답보다 먼저 나간다', async () => {
    // 연결 버킷 capacity 1 → 프레임 1만 통과. 프레임 1을 deferred listCharacters로 붙잡아둔 사이 프레임 2가
    // drop-warn(rate_limited)이 된다. 드롭 응답을 큐에 싣지 않고 동기로 보내면 rate_limited가 characterList를
    // 추월한다 — 큐 삽입으로 send 순서를 보존함을 고정한다.
    process.env.WS_MSG_RATE_CAPACITY = '1'
    process.env.WS_MSG_RATE_REFILL_PER_SEC = '1'
    process.env.WS_MSG_RATE_ACCOUNT_CAPACITY = '100'
    process.env.WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC = '100'
    resetConfigForTests()

    let resolveList: ((chars: CharacterSummary[]) => void) | undefined
    const listGate = new Promise<CharacterSummary[]>((resolve) => {
      resolveList = resolve
    })
    const fakeAuth: SessionAuthPort = {
      validateSessionCookie: (cookie) =>
        Promise.resolve(cookie === SEED_VALID_COOKIE ? { accountId: 'acc-1' } : null),
      listCharacters: () => listGate,
      createCharacter: () => Promise.reject(new Error('이 테스트에서 미사용')),
      assertOwnership: () => Promise.resolve(),
      deleteCharacter: () => Promise.resolve(),
    }

    const app = buildSeededApp({ sessionAuth: fakeAuth })
    await app.ready()

    const ws = await injectAuthedWS(app)
    const received: Array<{ type: string; code?: string }> = []
    ws.on('message', (data: unknown) => {
      received.push(JSON.parse(String(data)) as { type: string; code?: string })
    })
    await waitFor(() => received.some((e) => e.type === 'system:hello'))
    const base = received.length

    // 프레임 1(accept): system:ready → listCharacters(deferred)에서 멈춘다.
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    // 프레임 2(capacity 1 초과 → drop-warn): rate_limited 응답이 큐에 실린다(프레임 1 뒤).
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await tick()

    // 프레임 1이 아직 안 끝나 아무 응답도 없다(드롭 응답도 큐에서 대기).
    expect(received.length).toBe(base)

    resolveList?.([])
    await waitFor(() => received.length >= base + 3)

    // 순서: 프레임 1의 characterList·prompt가 프레임 2의 rate_limited보다 앞선다.
    expect(received.slice(base).map((e) => e.type)).toEqual([
      'session:characterList',
      'session:prompt',
      'error',
    ])
    expect(received[base + 2]).toMatchObject({ type: 'error', code: 'rate_limited' })

    ws.terminate()
    await app.close()
  })

  // ── (2) 프레임 대 close 레이스 ───────────────────────────────────────────────
  it('assertOwnership await 도중 소켓이 닫히면 월드 등록을 건너뛴다(좀비 바인딩·형제 evict 방지)', async () => {
    // assertOwnership을 수동 resolve 가능한 deferred로 둔다 — 캐릭터 선택 프레임이 이 await에서 멈춘 사이 소켓을
    // 닫는다. 재개 후 close-race 가드가 enterWorld(register)·command 전이를 건너뛰어야 한다.
    let resolveOwnership: (() => void) | undefined
    const ownershipGate = new Promise<void>((resolve) => {
      resolveOwnership = resolve
    })
    const fakeAuth: SessionAuthPort = {
      validateSessionCookie: (cookie) =>
        Promise.resolve(cookie === SEED_VALID_COOKIE ? { accountId: SEED_ACCOUNT_ID } : null),
      listCharacters: () =>
        Promise.resolve([
          { characterId: SEED_CHARACTER_ID, name: '무한전사', class: 1, race: 1, level: 5 },
        ]),
      createCharacter: () => Promise.reject(new Error('이 테스트에서 미사용')),
      assertOwnership: () => ownershipGate,
      deleteCharacter: () => Promise.resolve(),
    }

    const app = buildSeededApp({ sessionAuth: fakeAuth })
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // session:characterList
    await reader.next() // session:prompt(selectCharacter)

    // 캐릭터 선택 → assertOwnership(deferred) await에서 멈춘다.
    ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    await tick()
    // 아직 월드 미진입 — registry에 바인딩이 없다.
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)).toBeUndefined()

    // await 도중 소켓을 abrupt 종료한다 → 서버 'close' 핸들러가 ctx.closed=true를 세우고 connections에서 제거한다.
    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)

    // 포트를 resolve해 프레임을 재개시킨다 → close-race 가드가 enterWorld·command 전이를 bail해야 한다.
    resolveOwnership?.()
    await tick()
    await tick()

    // 가드가 동작했다면 죽은 연결에 대한 좀비 바인딩이 생기지 않는다(가드 제거 시 여기서 바인딩이 생겨 실패).
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)).toBeUndefined()
    expect(app.wsSessionRegistry.listBindings()).toHaveLength(0)

    await app.close()
  })

  // ── (3) async-gap liveness ──────────────────────────────────────────────────
  it('validateSessionCookie await 도중 소켓이 파괴돼도 정원 슬롯을 반납한다(:245 destroyed 경로)', async () => {
    // maxGlobal 1: await 도중 파괴된 소켓의 예약이 반납되지 않으면 유일한 슬롯이 잠겨 다음 reserve가 503난다.
    const quota = createConnectionQuota(() => ({ maxGlobal: 1, maxPerAccount: 100 }))

    // validateSessionCookie를 수동 resolve 가능한 deferred로 둔다 — hook이 이 await에서 멈춘 사이 소켓을 파괴한다.
    let resolveValidate: ((identity: { accountId: string }) => void) | undefined
    const validateGate = new Promise<{ accountId: string }>((resolve) => {
      resolveValidate = resolve
    })
    const fakeSessionAuth = {
      validateSessionCookie: () => validateGate,
    } as unknown as SessionAuthPort

    // 소켓은 hook 진입 시엔 살아 있고(destroyed=false), await 도중 파괴된다. once는 no-op이라 'close' 리스너는
    // 절대 발화하지 않는다 — 슬롯 반납의 유일한 경로를 :245 destroyed 체크로 국한해 그 경로만 검증한다.
    const socketObj = { destroyed: false, once: vi.fn() }
    const fakeReq = {
      headers: { origin: DEFAULT_TEST_ORIGIN, cookie: '__session=any-token' },
      raw: { socket: socketObj },
      account: null,
      releaseQuota: null,
    } as unknown as FastifyRequest
    // code 스파이를 변수로 잡아둔다 — fakeReply.code를 직접 참조하면 unbound-method 린트에 걸린다.
    const codeSpy = vi.fn().mockReturnThis()
    const fakeReply = {
      code: codeSpy,
      send: vi.fn(),
    } as unknown as FastifyReply

    // hook을 호출하되 아직 await하지 않는다 — validateSessionCookie await에서 멈춘다.
    const hookPromise = gameAuthPreValidation(fakeSessionAuth, quota)(fakeReq, fakeReply)
    await tick()

    // await 도중 소켓 파괴를 시뮬레이션한 뒤, 유효 신원으로 resolve한다 → hook이 reserve → 배선 → :245로 진행한다.
    socketObj.destroyed = true
    resolveValidate?.({ accountId: 'acc-1' })
    await hookPromise

    // reserve~:245 구간이 완전 동기라, :245의 destroyed 체크가 방금 점유한 슬롯을 직접 반납한다.
    // 슬롯이 반납됐다면 maxGlobal 1이 다시 비어 다른 예약이 성공한다(누수됐다면 503).
    expect(quota.reserve('other')).toEqual({ ok: true })
    // 인증 자체는 통과했다(신원이 유효했으므로 401/403/503 거부가 아니다).
    expect(codeSpy).not.toHaveBeenCalled()
  })
})
