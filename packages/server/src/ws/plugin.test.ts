import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Server as HttpsServer } from 'node:https'
import { buildApp } from '../app.js'
import { GAME_SOCKET_PATH, MAX_FRAME_BYTES } from './plugin.js'
import { resetConfigForTests } from '../config/env.js'
import { waitForMessage, waitForClose, waitFor } from './wsTestClient.testutil.js'

// T3.6 — transport 배선의 RED 스펙. injectWS로 실 upgrade를 태워 라우트 마운트·프레임 하드닝·
// per-connection 정리·https pass-through를 관찰한다. 인증·라우팅은 이 Story 범위 밖이라 검증하지 않는다.
describe('WS transport', () => {
  // 연결 핸들러가 getConfig()를 호출하므로(하트비트 튜닝값) 필수 env를 채워 fail-fast를 피한다.
  beforeAll(() => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    resetConfigForTests()
  })

  afterAll(() => {
    delete process.env.MONGODB_URI
    resetConfigForTests()
  })

  it('게임 소켓 연결을 수락한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitFor(() => app.wsConnections.size === 1)

    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('MAX_FRAME_BYTES 초과 프레임을 거부하고 연결을 닫는다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitFor(() => app.wsConnections.size === 1)

    // 프로토콜 레이어(maxPayload)가 버퍼 완성 전에 거부해야 한다 — 서버가 1009로 소켓을 닫는다.
    const closed = waitForClose(ws)
    ws.send('x'.repeat(MAX_FRAME_BYTES + 1))
    const code = await closed

    expect(code).toBe(1009)

    await app.close()
  })

  it('파싱 불가 JSON은 error{code:bad_payload} 이벤트로 응답하고 소켓은 생존한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitForMessage(ws) // 연결 직후 push되는 system:hello를 먼저 소비한다.

    // malformed JSON은 파싱이 핸드셰이크 게이트보다 먼저 실패하므로 pre-ready에서도 bad_payload다.
    const received = waitForMessage(ws)
    ws.send('{ this is not json')
    const event = await received

    expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
    expect(ws.readyState).toBe(ws.OPEN)
    expect(app.wsConnections.size).toBe(1)

    ws.terminate()
    await app.close()
  })

  it('연결 수락 시 하트비트 타이머를 시작해 ctx.heartbeat에 배선한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitFor(() => app.wsConnections.size === 1)

    // 하트비트 start()가 반환한 타이머 핸들이 ctx에 배선돼야 한다(cleanup·누수 방지 seam).
    const ctx = [...app.wsConnections.values()][0]
    expect(ctx?.heartbeat).not.toBeNull()

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    await app.close()
  })

  it('연결 종료 시 per-connection 컨텍스트를 정리한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitFor(() => app.wsConnections.size === 1)
    expect(app.wsConnections.size).toBe(1)

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    expect(app.wsConnections.size).toBe(0)

    await app.close()
  })

  it('연결 직후 system:hello{protocolVersion}를 push한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    const hello = await waitForMessage(ws)

    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    ws.terminate()
    await app.close()
  })

  it('ready 이전 non-ready 명령을 handshake_required로 거부하고 소켓은 생존한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitForMessage(ws) // system:hello 소비

    const rejected = waitForMessage(ws)
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑' }))
    const event = await rejected

    expect(event).toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('버전 일치 system:ready로 핸드셰이크를 완료한다 (ready=true)', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    const hello = await waitForMessage(ws)
    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await waitFor(() => [...app.wsConnections.values()][0]?.ready === true)

    expect([...app.wsConnections.values()][0]?.ready).toBe(true)
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('버전 불일치 system:ready는 system:reload push 후 소켓을 닫는다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitForMessage(ws) // system:hello 소비

    // reload 프레임이 close 전에 확실히 플러시되도록 두 리스너를 send 전에 건다.
    const reloadReceived = waitForMessage(ws)
    const closed = waitForClose(ws)
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 999 }))

    const reload = await reloadReceived
    expect(reload).toMatchObject({ type: 'system:reload' })

    const code = await closed
    expect(typeof code).toBe('number')

    await app.close()
  })

  it('핸드셰이크 완료 후 중복 system:ready를 error로 거부한다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    await waitForMessage(ws) // system:hello 소비

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await waitFor(() => [...app.wsConnections.values()][0]?.ready === true)

    const rejected = waitForMessage(ws)
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    const event = await rejected

    expect(event).toMatchObject({ type: 'error' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('핸드셰이크 완료 후 debug:echo를 debug:echo:result로 되돌린다', async () => {
    const app = buildApp()
    await app.ready()

    const ws = await app.injectWS(GAME_SOCKET_PATH)
    const hello = await waitForMessage(ws)
    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await waitFor(() => [...app.wsConnections.values()][0]?.ready === true)

    const result = waitForMessage(ws)
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))
    const event = await result

    expect(event).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('https 옵션을 Fastify 서버로 pass-through한다 (TLS-ready)', async () => {
    const secure = buildApp({ https: {} })
    expect(secure.server).toBeInstanceOf(HttpsServer)
    await secure.close()

    const plain = buildApp()
    expect(plain.server).not.toBeInstanceOf(HttpsServer)
    await plain.close()
  })
})
