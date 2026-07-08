import Fastify, { type FastifyInstance } from 'fastify'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import type { HealthStatus } from 'shared'
import { registerWebsocket } from './ws/plugin.js'

/**
 * Fastify 앱 인스턴스를 구성한다 (listen 하지 않음).
 *
 * `/health` REST와 게임 소켓(`@fastify/websocket`) transport를 노출한다. 인증·핸드셰이크·라우팅은
 * 후속 Story에서 추가된다.
 *
 * `deps.pingDb`로 DB ping 능력을 주입해 실제 DB 없이 `/health`를 테스트할 수 있다.
 * ping이 `/health` 상태의 진실의 원천이다(감시 플래그가 아님). 미주입 시 DB 상태 미상=degraded.
 *
 * `deps.https`는 Fastify로 그대로 pass-through한다(TLS-ready seam). 값을 넘기면 https 서버가 뜬다.
 * dev는 평문 loopback을 쓰므로 미주입이 기본이다.
 */
export function buildApp(deps?: {
  pingDb?: () => Promise<boolean>
  https?: HttpsServerOptions
}): FastifyInstance {
  // logger를 활성화해 부팅/에러 경로 진단(index.ts의 listen 실패 처리)이 실제로 출력되게 한다.
  // https를 넘기면 Fastify가 https.Server를 만든다(TLS-ready pass-through). Fastify 타입 오버로드가
  // http 경로에 https 키를 거부하므로 분기가 필요하다. dev는 평문 loopback이라 미주입이 기본.
  const app: FastifyInstance = deps?.https
    ? Fastify({ logger: true, https: deps.https })
    : Fastify({ logger: true })
  const pingDb = deps?.pingDb

  app.get('/health', async (): Promise<HealthStatus> => {
    if (!pingDb) return { status: 'degraded', db: 'down' }
    const up = await pingDb()
    return up ? { status: 'ok', db: 'up' } : { status: 'degraded', db: 'down' }
  })

  // 게임 소켓 transport를 무조건 등록한다. injectWS·실 upgrade가 완성된 app에서만 동작하고,
  // 라우트가 안 쓰이면 기존 /health 경로엔 영향이 없다.
  //
  // 등록 순서: @fastify/websocket "라우트보다 먼저 등록" 관례는 WS 라우트에 대한 것이다. 유일한 WS 라우트
  // `/game`은 registerWebsocket 내부에서 플러그인 등록 뒤에 마운트되므로 관례를 충족한다. 앞선 `/health`는
  // 평문 GET이라 upgrade 대상이 아니고, 이 앱에 `/game` 외 WS upgrade 대상이 없어 순서로 인한 영향이 없다.
  registerWebsocket(app)

  return app
}
