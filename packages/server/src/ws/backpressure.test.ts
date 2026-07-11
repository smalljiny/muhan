import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { getConfig, resetConfigForTests } from '../config/env.js'
import {
  buildSeededApp,
  startTestServer,
  newAuthedClient,
  enterCommandState,
  waitForClose,
  waitFor,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'

// T4.3 — backpressure 재진입 흡수 스펙. 실 TCP 클라이언트로 연결을 command 상태로 몰아넣은 뒤 서버
// 소켓의 bufferedAmount를 상한 위로 그림자 처리하고 emit을 유발한다. safeSend가 초과 버퍼를 보고
// serverSocket.close(1013)을 부르면, 그 close가 발화하는 'close' 핸들러(binding.connection===ctx 가드 +
// cleanupConnection)가 재진입 close를 정확히 한 번 흡수해 connections를 비워야 한다.
//
// 실 클라이언트를 쓰는 이유: 서버 주도 graceful close(1013)의 close 핸드셰이크가 완결돼 서버측 'close'
// 이벤트가 확실히 발화한다(injectWS는 코드는 전달하나 서버측 teardown이 완결되지 않아 size drop을
// 관측할 수 없다). getConfig()는 연결 핸들러에서 호출되므로 MONGODB_URI를 채워 fail-fast를 피한다.
describe('WS backpressure (실 소켓)', () => {
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
    apps = []
    clients = []
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  it('bufferedAmount 초과 소켓의 emit은 1013 close로 잘라내고 연결을 정확히 한 번 정리한다', async () => {
    const app = buildSeededApp()
    apps.push(app)
    const url = await startTestServer(app)

    const client = newAuthedClient(url)
    clients.push(client)
    await enterCommandState(client)

    const serverSocket = [...app.wsConnections.keys()][0]
    expect(serverSocket).toBeDefined()

    // 서버 소켓의 bufferedAmount를 상한 위로 그림자 처리한다 — 다음 emit이 backpressure 분기를 탄다.
    Object.defineProperty(serverSocket, 'bufferedAmount', {
      get: () => getConfig().WS_MAX_BUFFERED_BYTES + 1,
      configurable: true,
    })

    // close 리스너를 send 전에 걸어 1013을 놓치지 않는다.
    const closed = waitForClose(client, 2000)

    // debug:echo 응답이 emit→safeSend를 타면서 초과 버퍼를 만나 serverSocket.close(1013)을 호출한다.
    client.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))

    const code = await closed
    expect(code).toBe(1013)

    // 재진입 close는 idempotent teardown이 정확히 한 번 흡수해 connections를 비운다(비동기라 폴링).
    await waitFor(() => app.wsConnections.size === 0, 2000)
    expect(app.wsConnections.size).toBe(0)
  })
})
