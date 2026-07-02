import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from 'shared'

/**
 * Fastify 앱 인스턴스를 구성한다 (listen 하지 않음).
 *
 * `/health`만 노출해 툴체인이 end-to-end 동작함을 증명한다. 게임 소켓(`@fastify/websocket`)·
 * 인증 REST는 후속 에픽에서 추가된다.
 *
 * `deps.pingDb`로 DB ping 능력을 주입해 실제 DB 없이 `/health`를 테스트할 수 있다.
 * ping이 `/health` 상태의 진실의 원천이다(감시 플래그가 아님). 미주입 시 DB 상태 미상=degraded.
 */
export function buildApp(deps?: { pingDb?: () => Promise<boolean> }): FastifyInstance {
  // logger를 활성화해 부팅/에러 경로 진단(index.ts의 listen 실패 처리)이 실제로 출력되게 한다.
  const app = Fastify({ logger: true })
  const pingDb = deps?.pingDb

  app.get('/health', async (): Promise<HealthStatus> => {
    if (!pingDb) return { status: 'degraded', db: 'down' }
    const up = await pingDb()
    return up ? { status: 'ok', db: 'up' } : { status: 'degraded', db: 'down' }
  })

  return app
}
