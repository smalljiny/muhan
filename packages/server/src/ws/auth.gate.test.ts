import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from 'shared'
import { resetConfigForTests } from '../config/env.js'
import { SEED_ACCOUNT_ID } from '../auth/seedSessionAuth.testutil.js'
import {
  buildSeededApp,
  injectAuthedWS,
  newAuthedClient,
  startTestServer,
  waitForMessage,
  waitForUnexpectedResponse,
  waitForOpen,
  waitFor,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'

// T3.7 — preValidation 인증 게이트. Origin allowlist(403)·세션 쿠키(401)를 upgrade 전에 검증한다.
// 거부 케이스는 status code뿐 아니라 "소켓 미개방"(wsConnections 미증가 + hello 미발화)을 구조로 단언한다.
describe('WS 인증 게이트 (preValidation)', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeAll(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
  })

  afterAll(() => {
    process.env = savedEnv
    resetConfigForTests()
  })

  // ── injectWS(단위): 거부는 promise reject(Unexpected server response: NNN) + wsConnections 미증가 ──
  describe('injectWS 단위 관찰', () => {
    it('유효 쿠키+허용 Origin은 upgrade에 성공하고 ctx.account에 신원을 배선한다', async () => {
      const app = buildSeededApp()
      await app.ready()

      const ws = await injectAuthedWS(app)
      await waitFor(() => app.wsConnections.size === 1)

      expect(ws.readyState).toBe(ws.OPEN)
      const ctx = [...app.wsConnections.values()][0]
      expect(ctx?.account).toEqual({ accountId: SEED_ACCOUNT_ID })

      ws.terminate()
      await app.close()
    })

    it('무효 쿠키는 401로 거부하고 소켓을 열지 않는다', async () => {
      const app = buildSeededApp()
      await app.ready()

      // 허용 Origin으로 Origin 게이트를 통과시켜 쿠키 게이트(401)를 실제로 태운다(다층 guard 원칙).
      await expect(injectAuthedWS(app, { cookie: 'wrong-token' })).rejects.toThrow('401')
      expect(app.wsConnections.size).toBe(0)

      await app.close()
    })

    it('쿠키 부재는 401로 거부하고 소켓을 열지 않는다', async () => {
      const app = buildSeededApp()
      await app.ready()

      await expect(injectAuthedWS(app, { cookie: null })).rejects.toThrow('401')
      expect(app.wsConnections.size).toBe(0)

      await app.close()
    })

    it('비허용 Origin은 403으로 거부하고 소켓을 열지 않는다', async () => {
      const app = buildSeededApp()
      await app.ready()

      // 유효 쿠키를 실어 실패가 Origin 게이트(403)에서 나게 한다(다층 guard 원칙).
      await expect(injectAuthedWS(app, { origin: 'http://evil.example' })).rejects.toThrow('403')
      expect(app.wsConnections.size).toBe(0)

      await app.close()
    })

    it('Origin 부재는 403으로 거부하고 소켓을 열지 않는다 (fail-closed)', async () => {
      const app = buildSeededApp()
      await app.ready()

      await expect(injectAuthedWS(app, { origin: null })).rejects.toThrow('403')
      expect(app.wsConnections.size).toBe(0)

      await app.close()
    })
  })

  // ── 실 ws(E2E): 거부는 unexpected-response 이벤트 + open 미발화(hello를 받을 소켓이 없음) ──
  describe('실 소켓 관찰 (unexpected-response)', () => {
    let apps: FastifyInstance[]
    let clients: WebSocket[]

    beforeEach(() => {
      apps = []
      clients = []
    })

    afterEach(async () => {
      // 거부된 클라이언트는 미성립(CONNECTING) 상태라 terminate가 abortHandshake로 'error'를 비동기
      // 발화한다 — 리스너가 없으면 uncaught가 된다. no-op error 리스너를 붙여 삼킨 뒤 파기한다.
      for (const client of clients) {
        client.on('error', () => {})
        client.terminate()
      }
      await Promise.all(apps.map((app) => app.close()))
    })

    async function startTracked(app: FastifyInstance): Promise<string> {
      apps.push(app)
      return startTestServer(app)
    }

    function trackedClient(ws: WebSocket): WebSocket {
      clients.push(ws)
      return ws
    }

    it('유효 쿠키+허용 Origin이면 실 클라이언트가 open되고 hello를 받는다', async () => {
      const url = await startTracked(buildSeededApp())
      const client = trackedClient(newAuthedClient(url))

      const helloReceived = waitForMessage(client)
      await waitForOpen(client)
      const hello = await helloReceived

      expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
    })

    it('무효 쿠키면 실 클라이언트가 401 unexpected-response를 받고 열리지 않는다', async () => {
      const url = await startTracked(buildSeededApp())
      const client = trackedClient(newAuthedClient(url, { cookie: 'wrong-token' }))

      const status = await waitForUnexpectedResponse(client)
      expect(status).toBe(401)
    })

    it('비허용 Origin이면 실 클라이언트가 403 unexpected-response를 받고 열리지 않는다', async () => {
      const url = await startTracked(buildSeededApp())
      const client = trackedClient(newAuthedClient(url, { origin: 'http://evil.example' }))

      const status = await waitForUnexpectedResponse(client)
      expect(status).toBe(403)
    })
  })
})
