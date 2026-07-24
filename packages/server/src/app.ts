import Fastify, { type FastifyInstance } from 'fastify'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import type { HealthStatus } from 'shared'
import { registerWebsocket } from './ws/plugin.js'
import type { SessionAuthPort } from './auth/sessionAuthPort.js'
import { InMemorySessionAuthAdapter } from './auth/inMemorySessionAuthAdapter.js'
import { registerDevLoginRoute } from './auth/devLoginRoute.js'
import type { SessionLifecyclePort } from './ws/sessionLifecyclePort.js'
import type { LiveWorldBinding } from './ws/liveWorldBinding.js'

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
 *
 * `deps.sessionAuth`는 게임 소켓 preValidation 게이트가 쓰는 세션 인증 포트다. 미주입 시 빈
 * 인메모리 어댑터(유효 쿠키 0개)를 기본값으로 조립한다 — 프로덕션 실 firebase 어댑터는 E5에서
 * 이 자리에 주입한다. 테스트는 `createSeededAuthAdapter()`로 시드 어댑터를 주입한다(DIP seam).
 *
 * `deps.lifecyclePort`는 세션 종결 후처리(영속화 seam) 포트다. 미주입 시 registerWebsocket이 no-op
 * 로깅 어댑터를 세운다 — 실 저장 어댑터는 E4/E5가 주입한다. 테스트는 스파이 포트를 주입해 종결 호출을
 * 관측한다(sessionAuth 관례 미러).
 *
 * `deps.devLoginSeedCookie`는 dev 전용 로그인 라우트(`GET /dev/login`)의 게이트다. 값이 주어질 때만
 * 라우트를 마운트해 `__session=<값>` 쿠키를 발급한다(Story 4, G1 서버측). 미주입(프로덕션)이면 라우트가
 * 존재하지 않아 dev 쿠키 발급 표면이 없다. 부팅(index.ts)이 DEV_LOGIN_ENABLED가 true일 때만 주입한다.
 *
 * `deps.liveWorld`는 월드 진입 seam(Story 4)의 라이브 의존(진입 코어+월드 그래프)이다. 주입 시 세션이
 * 캐릭터를 로드해 저장된 방에 배치하고 world:room을 발화한다. 미주입이면 registerWebsocket이 undefined를
 * 그대로 넘겨 진입 seam을 통째로 건너뛴다(T4.5, 기존 동작 보존) — lifecyclePort 관례 미러.
 */
export function buildApp(deps?: {
  pingDb?: () => Promise<boolean>
  https?: HttpsServerOptions
  sessionAuth?: SessionAuthPort
  lifecyclePort?: SessionLifecyclePort
  devLoginSeedCookie?: string
  liveWorld?: LiveWorldBinding
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

  // 세션 인증 포트를 조립한다. 미주입 시 빈 인메모리 어댑터(유효 쿠키 없음)를 기본으로 세운다.
  const sessionAuth = deps?.sessionAuth ?? new InMemorySessionAuthAdapter()

  // dev 로그인 라우트는 시드 쿠키가 주입될 때만 마운트한다(프로덕션은 미주입 → 라우트 부재).
  if (deps?.devLoginSeedCookie !== undefined) {
    registerDevLoginRoute(app, deps.devLoginSeedCookie)
  }

  // 게임 소켓 transport를 무조건 등록한다. injectWS·실 upgrade가 완성된 app에서만 동작하고,
  // 라우트가 안 쓰이면 기존 /health 경로엔 영향이 없다.
  //
  // 등록 순서: @fastify/websocket "라우트보다 먼저 등록" 관례는 WS 라우트에 대한 것이다. 유일한 WS 라우트
  // `/game`은 registerWebsocket 내부에서 플러그인 등록 뒤에 마운트되므로 관례를 충족한다. 앞선 `/health`는
  // 평문 GET이라 upgrade 대상이 아니고, 이 앱에 `/game` 외 WS upgrade 대상이 없어 순서로 인한 영향이 없다.
  // lifecyclePort는 미주입 시 registerWebsocket이 no-op 어댑터를 기본으로 세운다(3-arg 기본값). undefined를
  // 그대로 넘겨도 기본 파라미터가 발동하므로 분기 없이 sessionAuth와 같은 패턴으로 전달한다.
  // liveWorld는 미주입 시 undefined를 그대로 넘긴다 — registerWebsocket이 진입 seam을 건너뛴다(T4.5).
  // channelPort·permissionPort는 registerWebsocket 기본값에 위임하므로 undefined로 통과시킨다.
  registerWebsocket(app, sessionAuth, deps?.lifecyclePort, undefined, undefined, deps?.liveWorld)

  return app
}
