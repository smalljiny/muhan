import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { resetConfigForTests } from '../config/env.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import { WorldClock } from '../world/worldClock.js'
import { defaultClock } from '../util/clock.js'
import {
  buildSeededApp,
  startTestServer,
  newAuthedClient,
  waitFor,
  enterCommandState,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'
import { SEED_ACCOUNT_ID, SEED_CHARACTER_ID } from '../auth/seedSessionAuth.testutil.js'

// Story 6 — shutdown 수렴 integration. 실 소켓 리슨 + WorldClock(실 1Hz interval)을 함께 세우고,
// markShuttingDown → worldClock.stop → converge → app.close 종료 시퀀스가 (a) 등록 바인딩(link-dead 포함)을
// reason 'shutdown'으로 종결하고 (b) SessionRegistry를 비우며 (c) 월드 틱·grace referenced 타이머를 0으로
// 되돌리는지(테스트가 실타이머 30s grace 대기 없이 완료) 관측한다. injectWS 단위(plugin.test.ts T6.3)와
// 구별되는 실 TCP + 실 setInterval 흐름이다.
//
// seed 캐릭터가 1개(SEED_CHARACTER_ID)뿐이라 live+link-dead 동시 구성은 불가하다. 문서화된 최소 시나리오대로
// link-dead 바인딩 1건 + armed WorldClock으로 수렴·타이머 0을 검증한다(live 종결은 plugin.test.ts T6.3이 담당).
describe('WS shutdown 수렴 integration (실 소켓 + WorldClock)', () => {
  let savedEnv: NodeJS.ProcessEnv
  // suite-level 추적 — 각 테스트가 만든 실 서버·클라이언트를 등록해 afterEach가 실패 경로에서도 정리한다
  // (리스닝 소켓 + 하트비트 인터벌 누수 방지). plugin.e2e.test.ts의 정리 규약을 미러한다.
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  /** onSessionEnd를 스파이하는 lifecyclePort. buildSeededApp({ lifecyclePort })로 주입해 종결을 관측한다. */
  function spyPort(): SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } {
    return { onSessionEnd: vi.fn() }
  }

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

  it('link-dead 바인딩 + armed WorldClock을 종료 시퀀스가 수렴하고 타이머를 0으로 되돌린다', async () => {
    const port = spyPort()
    const app = buildSeededApp({ lifecyclePort: port })
    apps.push(app)
    const url = await startTestServer(app)

    // 클라1: command 진입 → live 바인딩. 종료 플래그 off 상태에서 drop해 link-dead(grace armed)를 만든다.
    const client = newAuthedClient(url)
    clients.push(client)
    await enterCommandState(client)
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link).toBe('live')

    client.close()
    await waitFor(() => app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link === 'link-dead')
    // 클라 주도 drop은 grace 창일 뿐 종결이 아니다 — 아직 포트 미호출.
    expect(port.onSessionEnd).not.toHaveBeenCalled()

    // 실 1Hz 월드 틱 interval을 arm한다(referenced setInterval).
    const worldClock = new WorldClock({ clock: defaultClock })
    try {
      worldClock.start()
      expect(worldClock.running).toBe(true)

      // 종료 시퀀스: 플래그 set → 월드 틱 정지 → 등록 바인딩 일괄 수렴 → 서버 종료.
      app.wsShutdown.markShuttingDown()
      worldClock.stop()
      app.wsShutdown.converge()
      await app.close()

      // (a) 레지스트리가 빈다 — link-dead 바인딩이 30s grace 만료를 기다리지 않고 즉시 종결됐다.
      expect(app.wsSessionRegistry.listBindings()).toHaveLength(0)
      // (b) 월드 틱 interval이 해제된다(referenced setInterval 0).
      expect(worldClock.running).toBe(false)
      // (c) 등록됐던 link-dead 바인딩이 reason 'shutdown'으로 정확히 1회 종결된다(포트 no-op 스파이 유지).
      expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
      expect(port.onSessionEnd).toHaveBeenCalledWith({
        accountId: SEED_ACCOUNT_ID,
        characterId: SEED_CHARACTER_ID,
        reason: 'shutdown',
      })
    } finally {
      // WorldClock은 defaultClock(실 setInterval)이라 stop() 없이는 vitest가 열린 핸들로 행한다 — 예외 경로에서도
      // 반드시 정지한다(afterEach는 worldClock을 추적하지 않는다). grace 타이머는 converge의 resolveDisconnect가
      // clear하므로 이 시점 남는 referenced 타이머가 없어 테스트가 30s 대기 없이 완료된다.
      worldClock.stop()
    }
  })
})
