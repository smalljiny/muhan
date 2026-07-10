import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { resetConfigForTests } from '../config/env.js'
import {
  buildSeededApp,
  injectAuthedWS,
  waitFor,
  DEFAULT_TEST_ORIGIN,
  startTestServer,
  newAuthedClient,
  waitForOpen,
  waitForUnexpectedResponse,
} from './wsTestClient.testutil.js'

// T3.4 — 동시 접속 정원(quota) upgrade 게이트. Origin 403 → 쿠키 401 → 정원(전역 503·계정별 429) 순서로
// 배선됐음을 통합 경로로 단언한다. getConfig()는 캐시 싱글턴이라 상한을 실제로 태우려면 env를 설정하고
// resetConfigForTests()를 buildSeededApp/app.ready 이전에 호출해야 한다(안 하면 기본 1000/5로 상한에 못 닿아
// 테스트가 무의미하게 통과한다). env는 테스트마다 저장·복원한다.
//
// 모든 injectAuthedWS는 하나의 시드 계정(SEED_ACCOUNT_ID)+DEFAULT_TEST_ORIGIN을 공유하므로, 전역 상한과
// 계정별 상한은 다른 한쪽을 넉넉히 두어 검증 대상 상한이 먼저 발화하게 만든다.
describe('WS 정원 게이트 (preValidation quota)', () => {
  let savedEnv: NodeJS.ProcessEnv
  let apps: FastifyInstance[]
  let sockets: WebSocket[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    apps = []
    sockets = []
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
  })

  afterEach(async () => {
    // 거부된 실 클라이언트는 미성립(CONNECTING) 상태라 terminate가 abortHandshake로 'error'를 비동기
    // 발화한다 — 리스너가 없으면 uncaught가 된다. no-op error 리스너를 붙여 삼킨 뒤 파기한다.
    for (const socket of sockets) {
      socket.on('error', () => {})
      socket.terminate()
    }
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  /**
   * 상한 env를 설정하고 resetConfigForTests() 후 시드 app을 만든다 — reset이 반드시 buildSeededApp보다
   * 앞서야 buildApp이 startup에 캐시하는 getConfig가 이 상한을 읽는다(그렇지 않으면 기본 1000/5로 캐시된다).
   */
  function buildCappedApp(maxGlobal: number, maxPerAccount: number): FastifyInstance {
    process.env.WS_MAX_CONNECTIONS = String(maxGlobal)
    process.env.WS_MAX_CONNECTIONS_PER_ACCOUNT = String(maxPerAccount)
    resetConfigForTests()
    const app = buildSeededApp()
    apps.push(app)
    return app
  }

  async function openTracked(app: FastifyInstance): Promise<WebSocket> {
    const ws = await injectAuthedWS(app)
    sockets.push(ws)
    return ws
  }

  it('전역 정원 초과 시 3번째 upgrade를 503으로 거부한다(슬롯 미소비)', async () => {
    // 전역 상한 2, 계정별 상한 100 → 전역이 먼저 발화한다(단일 시드 계정 공유).
    const app = buildCappedApp(2, 100)
    await app.ready()

    await openTracked(app)
    await openTracked(app)
    await waitFor(() => app.wsConnections.size === 2)

    await expect(injectAuthedWS(app)).rejects.toThrow('503')
    // 거부는 슬롯을 소비하지 않는다 — 여전히 2개(3이 되지 않는다).
    expect(app.wsConnections.size).toBe(2)
  })

  it('계정별 정원 초과 시 3번째 upgrade를 429로 거부한다', async () => {
    // 전역 상한 100(넉넉), 계정별 상한 2 → 계정별이 먼저 발화한다.
    const app = buildCappedApp(100, 2)
    await app.ready()

    await openTracked(app)
    await openTracked(app)
    await waitFor(() => app.wsConnections.size === 2)

    await expect(injectAuthedWS(app)).rejects.toThrow('429')
    expect(app.wsConnections.size).toBe(2)
  })

  it('연결 종료 시 슬롯이 반납돼 새 upgrade가 성공한다(정상 close 경로)', async () => {
    // 전역 상한 2에서 2개 점유 후 하나를 닫으면 슬롯이 열려 새 연결이 성공해야 한다.
    // size===1 도달만으로는 부족하다 — size는 기존 cleanupConnection 리스너로 줄지만, 정원 반납(release)은
    // 별도 'close' 리스너다. 새 연결의 성공만이 release가 실제로 발화했음을 증명한다(발화 안 했으면 정원 내부
    // 카운터가 2로 남아 size===1이어도 새 연결이 503난다).
    const app = buildCappedApp(2, 100)
    await app.ready()

    const first = await openTracked(app)
    await openTracked(app)
    await waitFor(() => app.wsConnections.size === 2)

    first.terminate()
    await waitFor(() => app.wsConnections.size === 1)

    const revived = await openTracked(app)
    expect(revived.readyState).toBe(revived.OPEN)
    await waitFor(() => app.wsConnections.size === 2)
  })

  it('거부된 게이트(Origin 403·쿠키 401)는 슬롯을 소비하지 않는다(reserve가 게이트 뒤에 위치)', async () => {
    // 전역 상한 1: Origin·쿠키 거부가 유일한 슬롯을 소비했다면 이후 유효 연결이 503난다. reserve가 두 게이트
    // 뒤에 있으므로 거부는 슬롯을 건드리지 않고, 유효 연결이 성공해야 한다.
    const app = buildCappedApp(1, 100)
    await app.ready()

    await expect(injectAuthedWS(app, { origin: 'http://evil.example' })).rejects.toThrow('403')
    await expect(injectAuthedWS(app, { cookie: 'wrong-token' })).rejects.toThrow('401')
    expect(app.wsConnections.size).toBe(0)

    const ws = await openTracked(app)
    expect(ws.readyState).toBe(ws.OPEN)
    await waitFor(() => app.wsConnections.size === 1)
  })

  // 실 소켓 이중 발화 회귀 방어(released 가드). 위 injectWS 테스트로는 이 가드를 태울 수 없다 — injectWS는
  // req.raw.socket 'close'를 발화하지 않아 release 클로저가 한 번만(ws 'close'만) 돈다. 실 TCP 소켓에서만
  // raw-close+ws-close가 함께 발화해 클로저가 두 번 불린다. 이때 released 가드가 없으면 conn1의 이중 release가
  // 같은 계정의 살아 있는 conn2 슬롯까지 반납해(전역 2→1→0) cap이 우회된다. Story 2의 release-idempotency
  // 단위 테스트는 '0/부재 계정 중복 release'라는 다른 메커니즘을 고정할 뿐, 2연결 상태의 이중 발화는 커버하지
  // 않으므로 이 통합 테스트가 유일한 가드 커버리지다.
  it('실 소켓 close 이중 발화가 같은 계정의 다른 연결 슬롯을 반납하지 않는다(released 가드)', async () => {
    // 전역 상한 2·계정별 100. 같은 시드 계정으로 실 소켓 2개를 연다. conn1을 닫으면 raw-close+ws-close가
    // 함께 발화하지만 released 가드로 실제 release는 1회 → 전역 2→1. 이어 실 소켓 하나를 더 열면 전역 1→2로
    // 성공하고, 그 다음 실 소켓은 전역 상한 2에 막혀 503으로 거부돼야 한다. 가드가 없으면 conn1 이중 release가
    // 전역을 2→0으로 떨궈 두 개가 더 열려버린다(둘째가 503나지 않음 = cap 우회).
    const app = buildCappedApp(2, 100)
    const url = await startTestServer(app)

    const c1 = newAuthedClient(url)
    sockets.push(c1)
    await waitForOpen(c1)
    const c2 = newAuthedClient(url)
    sockets.push(c2)
    await waitForOpen(c2)
    await waitFor(() => app.wsConnections.size === 2)

    c1.close()
    await waitFor(() => app.wsConnections.size === 1)

    const c3 = newAuthedClient(url)
    sockets.push(c3)
    await waitForOpen(c3)
    await waitFor(() => app.wsConnections.size === 2)

    // 전역 상한 2 재도달 — 이중 발화가 conn2 슬롯을 잘못 반납했다면 여기서 여유가 생겨 open된다.
    const c4 = newAuthedClient(url)
    sockets.push(c4)
    await expect(waitForUnexpectedResponse(c4)).resolves.toBe(503)
  })
})
