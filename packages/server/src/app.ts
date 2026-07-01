import Fastify, { type FastifyInstance } from 'fastify'
import type { HealthStatus } from 'shared'

/**
 * Fastify 앱 인스턴스를 구성한다 (listen 하지 않음).
 *
 * E1에서는 `/health` 하나만 노출해 툴체인이 end-to-end 동작함을 증명한다.
 * 게임 소켓(`@fastify/websocket`)·인증 REST는 후속 에픽에서 추가된다.
 */
export function buildApp(): FastifyInstance {
  // logger를 활성화해 부팅/에러 경로 진단(index.ts의 listen 실패 처리)이 실제로 출력되게 한다.
  const app = Fastify({ logger: true })

  app.get('/health', (): HealthStatus => {
    return { status: 'ok' }
  })

  return app
}
