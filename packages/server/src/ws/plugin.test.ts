import { describe, it, expect } from 'vitest'
import { Server as HttpsServer } from 'node:https'
import { buildApp } from '../app.js'
import { GAME_SOCKET_PATH, MAX_FRAME_BYTES } from './plugin.js'
import { waitForMessage, waitForClose, waitFor } from './wsTestClient.testutil.js'

// T3.6 — transport 배선의 RED 스펙. injectWS로 실 upgrade를 태워 라우트 마운트·프레임 하드닝·
// per-connection 정리·https pass-through를 관찰한다. 인증·라우팅은 이 Story 범위 밖이라 검증하지 않는다.
describe('WS transport', () => {
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
    await waitFor(() => app.wsConnections.size === 1)

    const received = waitForMessage(ws)
    ws.send('{ this is not json')
    const event = await received

    expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
    expect(ws.readyState).toBe(ws.OPEN)
    expect(app.wsConnections.size).toBe(1)

    ws.terminate()
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

  it('https 옵션을 Fastify 서버로 pass-through한다 (TLS-ready)', async () => {
    const secure = buildApp({ https: {} })
    expect(secure.server).toBeInstanceOf(HttpsServer)
    await secure.close()

    const plain = buildApp()
    expect(plain.server).not.toBeInstanceOf(HttpsServer)
    await plain.close()
  })
})
