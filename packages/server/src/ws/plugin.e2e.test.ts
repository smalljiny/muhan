import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { resetConfigForTests } from '../config/env.js'
import type { ServerEvent } from 'shared'
import {
  buildSeededApp,
  startTestServer,
  newAuthedClient,
  waitForOpen,
  waitForMessage,
  waitForClose,
  DEFAULT_TEST_ORIGIN,
  type AuthHeaderOptions,
  type RealClientOptions,
} from './wsTestClient.testutil.js'

// Story 7 — 실 네트워크 소켓 E2E. injectWS in-process 단위 테스트(plugin.test.ts)와 구별되는
// 실 TCP 흐름을 증명한다: app을 포트 0(127.0.0.1)로 리슨시키고 실 `ws` 클라이언트로 연결해
// 핸드셰이크→echo 왕복·버전 거부·하트비트 종료 전체 파이프라인을 관찰한다.
//
// getConfig()는 연결 핸들러에서 호출되므로 MONGODB_URI를 더미로 채워 fail-fast를 피한다.
// env를 조작하는 테스트(T7.4)는 process.env 세팅 후 buildApp 전에 resetConfigForTests()로
// 싱글턴을 초기화한다(env.test.ts 격리 패턴 미러).
describe('WS transport E2E (실 소켓)', () => {
  let savedEnv: NodeJS.ProcessEnv
  // suite-level 추적 — 각 테스트가 만든 실 서버·클라이언트를 등록해 afterEach가 실패 경로에서도
  // 정리한다(리스닝 소켓 + 비-unref 하트비트 인터벌 누수 방지). 실 listen이라 누수 표면이 크다.
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
    // 클라이언트를 먼저 닫고 서버 close를 await한다 — preClose가 소켓을 닫고 heartbeat.stop()이
    // per-connection 인터벌을 clear해야 vitest가 열린 핸들로 행하지 않는다. close()는 idempotent라
    // 정상 종료한 테스트에서 재호출돼도 무해하다.
    for (const client of clients) client.close()
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  /** 실 서버를 포트 0으로 리슨시키고 소켓 URL을 돌려준다. app을 정리 목록에 등록한다. */
  async function startTracked(app: FastifyInstance): Promise<string> {
    // app.ready()는 생략한다 — startTestServer의 app.listen()이 내부적으로 ready를 await한다.
    // apps.push는 어떤 await보다 먼저 실행해 listen 실패 시에도 afterEach가 정리하게 한다.
    apps.push(app)
    return startTestServer(app)
  }

  /** 유효 쿠키+허용 Origin 실 클라이언트를 만들어 정리 목록에 등록한다(게이트 통과). */
  function trackedClient(url: string, options?: AuthHeaderOptions & RealClientOptions): WebSocket {
    const client = newAuthedClient(url, options)
    clients.push(client)
    return client
  }

  /**
   * 실 클라이언트로 연결 직후 서버가 push하는 `system:hello`를 소비해 돌려준다.
   *
   * hello는 서버가 `setImmediate`로 push하므로, message 리스너를 open **전에** 걸어야 유실되지 않는다.
   * 이 순서 불변식(listener-before-open)을 한 곳에 고정해, 각 테스트가 재현하며 실수로 뒤집는 것을 막는다.
   */
  async function consumeHello(client: WebSocket): Promise<ServerEvent> {
    const helloReceived = waitForMessage(client)
    await waitForOpen(client)
    return helloReceived
  }

  it('실 클라이언트가 hello→ready→echo→echo:result 전체 왕복을 통과한다', async () => {
    // 기본 하트비트 간격(25s)이라 테스트 중 ping이 발화해 간섭하지 않는다.
    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    const hello = await consumeHello(client)
    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    // 버전 일치 ready는 ack 이벤트를 만들지 않는다(ready=true) — 응답을 기다리지 않고 바로 echo.
    client.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    const result = waitForMessage(client)
    client.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))
    const event = await result

    expect(event).toMatchObject({
      type: 'debug:echo:result',
      text: '핑',
      correlationId: 'c1',
    })
    expect(client.readyState).toBe(client.OPEN)
    // 서버·클라이언트 정리는 afterEach가 소유한다(실패 경로 포함).
  })

  it('버전 불일치 시 실 클라이언트가 system:reload를 수신하고 소켓이 닫힌다', async () => {
    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    await consumeHello(client)

    // reload 프레임 수신과 close를 send 전에 모두 건다 — 서버는 reload를 먼저 보내고 다음 tick에
    // close한다. 실 TCP는 단일 연결 in-order 전달이라 reload가 close 앞에 확실히 도착한다.
    const reloadReceived = waitForMessage(client)
    const closed = waitForClose(client)
    client.send(JSON.stringify({ type: 'system:ready', protocolVersion: 999 }))

    const reload = await reloadReceived
    expect(reload).toMatchObject({ type: 'system:reload' })

    const code = await closed
    expect(typeof code).toBe('number')
    // 정리는 afterEach가 소유한다.
  })

  it('pong 미응답 시 서버가 실 소켓을 terminate한다 (단일 하트비트-miss)', async () => {
    // 짧은 ping 간격 + MAX_MISSED=1로 종료를 bounded 시간 안에 강제한다. env 세팅 후 buildApp
    // 전에 싱글턴을 초기화해 이 테스트만의 하트비트 튜닝이 적용되게 한다.
    process.env.WS_HEARTBEAT_PING_INTERVAL_MS = '50'
    process.env.WS_HEARTBEAT_MAX_MISSED = '1'
    resetConfigForTests()

    const url = await startTracked(buildSeededApp())

    // autoPong:false가 없으면 클라이언트가 프로토콜 레벨에서 ping에 자동 pong해 절대 terminate되지
    // 않는다 — 자동 pong을 억제해 미응답을 강제한다.
    const client = trackedClient(url, { autoPong: false })
    await consumeHello(client)

    // 약 2 인터벌(≈100ms) 뒤 서버가 terminate → 클라이언트 close 이벤트 발화. bounded 2s 대기.
    const closed = waitForClose(client, 2000)
    const code = await closed
    expect(typeof code).toBe('number')
    // 정리는 afterEach가 소유한다.
  })
})
