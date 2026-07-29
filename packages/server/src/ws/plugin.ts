import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { RawData, WebSocket } from 'ws'
import type { ServerEvent } from 'shared'
import { cleanupConnection, createConnectionContext, type ConnectionContext } from './connection.js'
import { handleHandshakeFrame } from './handshake.js'
import { createHeartbeat } from './heartbeat.js'
import { createDeadline, type Deadline } from './deadline.js'
import { createCommandRegistry, dispatch } from './router.js'
import { buildActorContext } from './actorContext.js'
import {
  ConnectionState,
  enterInitialState,
  handleSessionFrame,
  type SessionContext,
} from './fsm/sessionFsm.js'
import { getConfig } from '../config/env.js'
import type { AccountIdentity, SessionAuthPort } from '../auth/sessionAuthPort.js'
import { extractSessionCookie } from './cookies.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import { createNoopSessionLifecycleAdapter } from './noopSessionLifecycleAdapter.js'
import type { ChannelPort } from './channelPort.js'
import { createNoopChannelAdapter } from './noopChannelAdapter.js'
import type { PermissionPort } from './permissionPort.js'
import { createPermissivePermissionAdapter } from './permissivePermissionAdapter.js'
import { buildSessionLiveWorld, type LiveWorldBinding } from './liveWorldBinding.js'
import {
  createLiveWorldWiring,
  assembleRoomChannelPort,
  type LiveWorldWiringBundle,
} from './liveWorldWiring.js'
import { createSessionRegistry, type SessionRegistry } from './sessionRegistry.js'
import { createResolveDisconnect } from './resolveDisconnect.js'
import { createSessionLifecycle, type SessionLifecycle } from './sessionLifecycle.js'
import { createConnectionQuota, type ConnectionQuota } from './connectionQuota.js'
import { createShutdownConverger, type ShutdownConverger } from './shutdownConvergence.js'
import {
  createMessageRateLimiterFactory,
  type MessageRateLimiterFactory,
  type MessageRateLimits,
} from './messageRateLimiter.js'

/** switch 완전성 컴파일 강제 — 도달하면 union에 미처리 variant가 생긴 것이다. */
function assertNever(value: never): never {
  throw new Error(`처리되지 않은 HandshakeResult: ${JSON.stringify(value)}`)
}

/**
 * 게임 소켓 경로. transport 위에 upgrade 전 인증 게이트(preValidation: Origin 403·세션 쿠키 401),
 * 버전 협상 핸드셰이크(Story 4), 명령 라우팅(Story 6)이 배선돼 있다.
 */
export const GAME_SOCKET_PATH = '/game'

/**
 * 단일 프레임 최대 바이트. 프로토콜 레이어(`options.maxPayload`)로 강제해 버퍼 완성 전에 초과
 * 프레임을 거부한다(1009 close) — 메모리 소진 방어의 핵심. 핸들러 안에서 크기를 재는 방식은
 * 이미 버퍼링된 뒤라 방어가 되지 않는다.
 */
export const MAX_FRAME_BYTES = 64 * 1024

// app에 per-connection 레지스트리를 노출한다. 진단·하트비트 스윕(Story 5-6)·테스트 관찰의 단일 출처.
// `account`는 preValidation 게이트가 확정한 계정 신원을 담는 per-request 데코레이션이다 —
// decorateRequest로 null 기본값을 심고 훅에서 요청별로 대입한다(객체 리터럴 데코레이트 금지: 요청 간
// 공유 참조가 되어 신원이 교차 오염된다).
declare module 'fastify' {
  interface FastifyInstance {
    wsConnections: Map<WebSocket, ConnectionContext>
    wsLifecyclePort: SessionLifecyclePort
    // characterId → SessionBinding 색인. 진단·재연결·테스트 관찰의 단일 출처(wsConnections 관례 미러).
    wsSessionRegistry: SessionRegistry
    // 서버 주도 종료 수렴 핸들. index.ts 신호 핸들러가 markShuttingDown→converge로 등록 바인딩을 일괄 종결하고,
    // 소켓 close 핸들러가 isShuttingDown()으로 link-dead 진입을 우회한다(wsSessionRegistry 관례 미러).
    wsShutdown: ShutdownConverger
    // 인바운드 유량 제한기 factory. 연결 간 공유되는 계정 버킷 레지스트리를 소유하며, 소켓 open 시 연결 핸들을
    // 발급하고 close 시 계정 참조를 반납한다. 진단·테스트 관찰의 단일 출처로 노출한다(wsSessionRegistry 관례 미러).
    wsMessageRateLimiter: MessageRateLimiterFactory
  }
  interface FastifyRequest {
    account: AccountIdentity | null
    // 이 요청의 정원 슬롯을 반납하는 idempotent 클로저. reserve 성공 직후 preValidation이 요청별로 대입해
    // 소켓 핸들러가 'close'에 배선한다. account 데코레이션 관례 미러(null 기본값, 요청별 대입).
    releaseQuota: (() => void) | null
  }
}

/**
 * ctx로 소켓을 역참조한다 — connections는 WebSocket→ctx 방향이라 종결 대상 바인딩의 ctx로부터 소켓을
 * 찾으려면 역방향 스캔이 필요하다. 소켓이 이미 정리됐으면(drop 후 grace 경로) undefined를 돌려준다.
 * 종결(teardown)은 세션당 드물어 O(n) 스캔이 허용된다(별도 역색인 유지의 동기화 부담을 피한다).
 */
function socketForContext(
  connections: Map<WebSocket, ConnectionContext>,
  ctx: ConnectionContext,
): WebSocket | undefined {
  for (const [socket, c] of connections) {
    if (c === ctx) return socket
  }
  return undefined
}

/** ws 프레임(RawData)을 UTF-8 문자열로 정규화한다. 기본 binaryType(nodebuffer)에선 Buffer 경로를 탄다. */
function frameToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * 이벤트를 소켓으로 안전하게 직렬화·전송하는 함수를 만든다(팩토리 클로저 — 로거를 1회 캡처해
 * 호출부 churn을 없앤다). 반환 함수는 3층 경계를 지킨다(소켓은 셸에만 있다).
 *
 * 순서: (1) OPEN 가드 — 닫힌 소켓엔 전송·close 모두 스킵한다. (2) backpressure 가드 — 이번 payload를 미리
 * 직렬화해 그 바이트 수를 bufferedAmount에 더한 값(`bufferedAmount + payloadBytes`)이 상한을 넘으면 느린
 * 소비자로 판정해 1013(Try Again Later)로 close하고 전송하지 않는다. enqueue 직전에 대기 중인 payload 크기까지
 * 회계에 넣는 hard cap이라, 단일 이벤트가 큐를 상한 너머로 밀어넣고도 살아남는 one-message overshoot가 없다.
 * 권위적 이벤트 push 서버라 프레임을 드롭·유예하면 상태가 어긋나므로 close가 유일하게 안전한 응답이다. 상한은
 * getConfig()로 호출 시점에 조회해 테스트가 env를 덮어쓸 수 있게 한다(팩토리 생성 시점 캡처 금지). payload는
 * 여기서 한 번만 직렬화해 send에 재사용한다(이중 직렬화 없음). (3) 콜백형 send — 비동기 전송 오류는 콜백으로
 * 받아 로깅하고 codeless close로 잘라낸다(backpressure의 1013과 달리 transport 실패이므로 코드 없이 닫는다,
 * deadline 관례 미러). 콜백형에서 not-OPEN send는 동기 throw 대신 콜백 err로 오지만(OPEN 가드가 이미 선차단),
 * 잔여 동기 throw를 방어하기 위해 try/catch를 defense-in-depth로 유지한다. Story 4-6의 응답 경로가 이 가드를 재사용한다.
 */
export function createSafeSend(log: FastifyBaseLogger): (socket: WebSocket, event: ServerEvent) => void {
  return (socket, event) => {
    if (socket.readyState !== socket.OPEN) return
    const payload = JSON.stringify(event)
    if (socket.bufferedAmount + Buffer.byteLength(payload) > getConfig().WS_MAX_BUFFERED_BYTES) {
      socket.close(1013)
      return
    }
    try {
      socket.send(payload, (err) => {
        if (err) {
          log.error({ err }, 'ws send failed')
          if (socket.readyState === socket.OPEN) socket.close()
        }
      })
    } catch {
      // 전송 직전 소켓이 닫힌 경우. 곧 'close'가 발화해 cleanup이 돌므로 무시한다.
    }
  }
}

/**
 * 세션 컨텍스트를 조립한다 — FSM 핸들러가 포트 호출·이벤트 발화에 쓸 컨텍스트(Lock E).
 *
 * `ctx.account`를 여기서 1회 narrow한다: preValidation 게이트가 non-null을 보장하므로 null이면 배선
 * 불변식 위반이라 throw한다(message 핸들러의 방어 try가 error{internal}로 격리). 이후 FSM 호출에
 * `account?.`를 스레드하지 않는다. `emit`은 주입 콜백으로 `safeSend`를 감싸 — 핸들러는 소켓을 직접
 * 만지지 않고 이 콜백으로만 이벤트를 내보낸다(3층 경계: 소켓은 셸에만 있다). `rearmDeadline`/`clearDeadline`도
 * 같은 방식으로 진행 데드라인 핸들(deadline)의 rearm/clear를 감싼 주입 콜백이다(Story 6, emit 미러).
 * `enterWorld`도 같은 방식으로 `lifecycle.enterWorld`를 이 ctx·account에 바인딩한 주입 콜백이다 — FSM은
 * characterId만 넘겨 등록/재연결하고, 셸이 registry 조작을 감춘다(3층 경계). account는 위에서 1회 narrow한
 * 값을 캡처해 재확인 없이 쓴다.
 *
 * `liveWorld`(Story 4)는 라이브 월드 진입 seam이다 — 주입된 `LiveWorldBinding`(진입 코어+월드 그래프)이
 * 있을 때만 조립하고, 미주입이면 undefined로 둬 FSM이 hydrate/place/world:room을 통째로 건너뛰게 한다(T4.5,
 * 기존 동작 보존). lifecyclePort·channelPort 관례처럼 배선 시점에 주입되며, 실 boot 결선은 tryMove 프로덕션
 * 결선(movement/command 에픽)과 같은 dormant 경계를 따른다.
 */
function buildSession(
  ctx: ConnectionContext,
  sessionAuth: SessionAuthPort,
  socket: WebSocket,
  deadline: Deadline,
  lifecycle: SessionLifecycle,
  send: (socket: WebSocket, event: ServerEvent) => void,
  liveWorld?: LiveWorldBinding,
): SessionContext {
  if (ctx.account === null) {
    throw new Error('세션 불변식 위반: 인증 게이트를 통과했으나 account가 없다')
  }
  const account = ctx.account
  return {
    account,
    sessionAuth,
    emit: (event) => send(socket, event),
    rearmDeadline: () => deadline.rearm(),
    clearDeadline: () => deadline.clear(),
    enterWorld: (characterId) => lifecycle.enterWorld(ctx, account.accountId, characterId),
    // close-race 가드 seam — FSM이 포트 await 재개 후 이 콜백으로 죽은 연결을 감지해 등록·상태 대입을 건너뛴다.
    // 'close' 핸들러가 ctx.closed를 세운다(frameTail 큐와 별개 리스너라 프레임 직렬화로는 못 막는 경로).
    isClosed: () => ctx.closed,
    // 주입된 라이브 월드 의존이 있을 때만 진입 seam을 조립한다. 미주입이면 undefined(T4.5).
    liveWorld: liveWorld === undefined ? undefined : buildSessionLiveWorld(liveWorld),
  }
}

/**
 * `/game` upgrade 게이트 팩토리 — Origin allowlist·세션 쿠키를 검증하는 preValidation 훅을 만든다.
 *
 * 순서(다층 guard): (1) Origin 헤더를 config.WS_ALLOWED_ORIGINS와 대조해 부재·불일치면 403(fail-closed —
 * 브라우저는 upgrade에 항상 Origin을 싣지만 부재도 명시 거부); (2) `__session` 쿠키를 추출해
 * sessionAuth.validateSessionCookie로 검증, 부재·무효면 401. 통과하면 확정된 AccountIdentity를
 * req.account에 대입해 소켓 핸들러가 재사용하게 한다.
 *
 * (3) 정원 게이트 — 계정 신원이 확정된 뒤 quota.reserve로 슬롯 1개를 점유한다. 전역 초과는 503, 계정별
 * 초과는 429. reserve는 두 선행 게이트 뒤에 위치해 거부된 Origin·쿠키가 슬롯을 소비하지 않는다(check-then-
 * increment가 같은 동기 스택에서 끝나 overshoot 없음). 성공하면 이 요청 전용 idempotent 반납 클로저를 만들어
 * raw upgrade 소켓의 'close'(abort 포함)와 요청 데코레이션(소켓 핸들러가 ws 'close'에 배선)에 연결한다.
 *
 * async 훅에서 `return reply.code().send()`는 라이프사이클을 단락시켜 upgrade를 완료하지 않는다(거부).
 * 통과 시 undefined를 반환해 라이프사이클을 계속 진행시킨다.
 *
 * 불변식(정원 누수 방어): `reserve`(정원 점유)부터 `releaseOnce` 배선(raw 소켓 'close' + req.releaseQuota 대입)
 * 그리고 그 직후의 `req.raw.socket?.destroyed` 체크까지의 구간은 `await` 없이 완전 동기로 실행되어야 한다.
 * hook 진입 시점(또는 아래 async-gap 참조)에 raw 소켓이 이미 파괴됐으면 Node의 once-only 'close'가 과거에
 * 발화하고 끝나 배선한 리스너가 영영 안 돌므로, 그 already-destroyed 경우를 위한 liveness 체크
 * (`req.raw.socket?.destroyed`)를 release 배선 직후에 두어 놓친 반납을 직접 수행한다(released 플래그가 이중
 * 반납을 차단하므로 살아 있는 소켓에는 무해).
 *
 * async-gap 커버리지: `validateSessionCookie`가 이제 async(`Promise` 반환)라 그 await 도중에 소켓이 파괴될 수
 * 있다. 하지만 그 await는 `reserve` **이전**에 있고, reserve~destroyed-체크 구간은 여전히 완전 동기다. 따라서
 * await 도중 파괴된 소켓은 reserve 시점에는 이미 destroyed=true이므로 :destroyed 체크가 그 슬롯을 직접 반납한다
 * (배선한 'close' 리스너가 안 돌아도). 이 async-gap 경로는 회귀 테스트로 고정한다(reserve와 배선 사이에 새 await를
 * 절대 넣지 않는 것이 이 커버리지의 전제다).
 */
export function gameAuthPreValidation(
  sessionAuth: SessionAuthPort,
  quota: ConnectionQuota,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    const config = getConfig()

    // (1) Origin 게이트 — fail-closed.
    const origin = req.headers.origin
    if (origin === undefined || !config.WS_ALLOWED_ORIGINS.includes(origin)) {
      return reply.code(403).send({ error: 'forbidden_origin' })
    }

    // (2) 세션 쿠키 게이트 — __session 부재·무효 모두 401. validateSessionCookie는 이제 async라 await한다.
    // 이 await 도중 소켓이 파괴될 수 있으나, reserve~:245 destroyed 체크 구간은 아래에서 여전히 완전 동기라
    // 그 체크가 await-도중-파괴 경우까지 커버한다(reserve와 배선 사이에 새 await를 넣지 않는다 — 불변식).
    const cookie = extractSessionCookie(req.headers.cookie)
    const identity = cookie === undefined ? null : await sessionAuth.validateSessionCookie(cookie)
    if (identity === null) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }

    req.account = identity

    // (3) 정원 게이트 — 신원이 확정된(accountId를 아는) 지금 슬롯을 점유한다. 거부는 슬롯을 올리지 않으므로
    // (Path 1) 반납할 것이 없다.
    const reservation = quota.reserve(identity.accountId)
    if (!reservation.ok) {
      if (reservation.code === 503) return reply.code(503).send({ error: 'server_busy' })
      return reply.code(429).send({ error: 'too_many_connections' })
    }

    // reserve 성공 직후 이 요청 전용 반납 클로저를 정확히 하나 만든다. released 플래그가 load-bearing이다:
    // 같은 연결의 release가 두 번(raw-close + ws-close) 발화해도 실제 quota.release는 한 번만 돌게 해, 다른
    // 살아 있는 연결의 슬롯을 잘못 반납하는 cap 우회를 막는다(정원 레벨 가드로는 이 per-connection 이중 발화를
    // 구별할 수 없다). 예약한 바로 그 accountId를 캡처한다.
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      quota.release(identity.accountId)
    }
    // (Path 3, abort) raw TCP 소켓의 'close'는 handleUpgrade abort(악성 핸드셰이크)에서도 발화한다 — 소켓
    // 핸들러에 도달하지 못하는 누수 경로를 이 배선이 커버한다.
    req.raw.socket?.once('close', releaseOnce)
    // 소켓 핸들러가 ws 'close'에 배선하도록 같은 참조를 요청 데코레이션에 실어 넘긴다.
    req.releaseQuota = releaseOnce
    // 이미 파괴된 소켓이면 'close'는 과거에 한 번 발화하고 끝났으므로 위 리스너가 영영 안 돈다 —
    // 놓친 반납을 여기서 직접 수행한다. releaseOnce의 released 플래그가 이중 반납을 막으므로,
    // 소켓이 실제로 살아 있으면 리스너가 발화하고 이 직접 호출은 무해하게 중복 차단된다.
    if (req.raw.socket?.destroyed) releaseOnce()
    return undefined
  }
}

/**
 * `@fastify/websocket`을 transport-only로 등록하고 게임 소켓 라우트를 마운트한다.
 *
 * `verifyClient`은 쓰지 않는다(transport-only). 인증은 라우트 옵션 레벨 preValidation 훅으로 upgrade 전에
 * 게이트한다(Origin 403·세션 쿠키 401). 플러그인을 먼저 등록해 `onRoute` 훅이 자리잡은 뒤 별도 encapsulated
 * 플러그인에서 라우트를 마운트한다(등록 순서 의존을 top-level await 없이 만족). per-connection 정리는 소켓
 * `'close'` 이벤트가, 서버 종료 시 소켓 닫기는 플러그인 기본 preClose가 맡는다.
 *
 * `lifecyclePort`는 세션 종결 후처리(영속화 seam)를 담는 포트다. 미주입 시 app.log에 로깅만 하는 no-op
 * 어댑터를 기본으로 세운다 — 실 저장 어댑터는 E4/E5에서 이 자리에 주입한다(sessionAuth 관례 미러).
 * 종결 경로 배선(resolveDisconnect 호출)은 후속 Story가 붙이며, 여기서는 포트를 wsLifecyclePort로 노출해
 * 후속 Story·테스트 관찰의 단일 출처로 둔다(wsConnections 데코레이션 관례 미러).
 *
 * `channelPort`는 자유채팅 발화를 채널 전파 계층으로 핸드오프하는 포트다. 미주입 시 전달 사실만 로깅하는
 * no-op 어댑터를 기본으로 세운다 — 실 브로드캐스트 어댑터는 E4/E7에서 이 자리에 주입한다(lifecyclePort
 * 관례 미러). 명령 레지스트리는 이 포트를 클로저 주입해 registerWebsocket 스코프에서 1회 조립한다
 * (무상태 Map이라 스코프 이동 비용 zero).
 *
 * `permissionPort`는 검증된 명령을 어느 actor가 실행할 자격이 있는지 판정하는 포트다. 미주입 시 항상
 * allow하는 permissive 어댑터를 기본으로 세운다 — 실 RBAC 어댑터는 E5에서 이 자리에 주입한다(channelPort
 * 관례 미러). dispatch가 payload 검증 성공 후·핸들러 전에 이 포트로 권한을 검사한다.
 *
 * `liveWorldDeps`(Story 7)는 라이브 월드 의존 묶음이다 — 주입 시 `createLiveWorldWiring`이 진입 seam·이동
 * seam·세션 수명 어댑터·방 해소자를 파생한다. 파생 결과로 (a) `channelPort`를 실 방 채널 어댑터로,
 * (b) `lifecyclePort`를 라이브 세션 수명 어댑터로, (c) `liveWorld`(진입 바인딩)를, (d) `world:move` 배선을
 * 세운다. 포트 우선순위는 **explicit-param > bundle-derived > default-noop**이다 — 명시 인자(테스트 스파이 등)가
 * 주어지면 묶음 파생이 덮지 않는다. transport 결합(sendTo)은 `assembleRoomChannelPort`에 격리하고, registry·
 * connections·safeSend를 그 조립 지점에서만 캡처한다(순수 팩토리는 transport 미접촉).
 */
export function registerWebsocket(
  app: FastifyInstance,
  sessionAuth: SessionAuthPort,
  lifecyclePort?: SessionLifecyclePort,
  channelPort?: ChannelPort,
  permissionPort: PermissionPort = createPermissivePermissionAdapter(),
  liveWorld?: LiveWorldBinding,
  liveWorldDeps?: LiveWorldWiringBundle,
): void {
  const connections = new Map<WebSocket, ConnectionContext>()

  // 안전 전송 함수를 앱 로거로 1회 조립한다(팩토리 클로저). 모든 응답 경로가 이 단일 병목을 통과해
  // OPEN 가드·backpressure(1013)·전송오류(codeless close) 처리를 공유한다.
  const safeSend = createSafeSend(app.log)

  // 세션 레지스트리를 명령 레지스트리 조립 위로 hoist한다(Story 7) — 방 채널 어댑터의 sendTo가 이 색인을
  // 캡처해 멤버 소켓을 역참조하므로, createCommandRegistry가 채널 포트를 받기 전에 존재해야 한다. per-connection이
  // 아니라 registerWebsocket 1회 인스턴스다(재연결이 이전 소켓의 바인딩을 찾으려면 하나의 색인이어야 한다).
  const registry = createSessionRegistry()

  // 라이브 월드 의존 묶음이 주입되면 순수 팩토리로 진입·이동·수명 seam과 방 해소자를 파생한다(미주입이면 undefined).
  const wiring = liveWorldDeps === undefined ? undefined : createLiveWorldWiring(liveWorldDeps)

  // 채널 포트 우선순위(explicit > bundle-derived > noop). 묶음 파생 채널은 transport 결합 sendTo가 필요하므로
  // assembleRoomChannelPort에 registry·connections·safeSend를 넘겨 이 지점에서만 조립한다(순수 팩토리 밖 격리).
  const effectiveChannelPort =
    channelPort ??
    (wiring === undefined
      ? createNoopChannelAdapter(app.log)
      : assembleRoomChannelPort<WebSocket>({
          resolveRoom: wiring.resolveRoom,
          registry,
          resolveSocket: (connection) => socketForContext(connections, connection),
          safeSend,
        }))

  // 수명 포트 우선순위(explicit > bundle-derived > noop). 명시 포트(테스트 스파이)가 묶음 파생 라이브 어댑터를 덮지 않는다.
  const effectiveLifecyclePort =
    lifecyclePort ?? wiring?.lifecyclePort ?? createNoopSessionLifecycleAdapter(app.log)

  // 진입 seam 우선순위(explicit binding > bundle-derived binding). 명시 liveWorld(T4.5 seam)가 있으면 그대로 쓴다.
  const effectiveLiveWorld = liveWorld ?? wiring?.liveWorldBinding

  // 명령 레지스트리는 무상태 핸들러의 배선표라 연결 간 공유 안전하다 — 채널 포트·(묶음 파생) 명령 deps 번들을
  // 클로저 주입해 1회 조립한다. 번들의 move 필드가 있으면 world:move가 등록되고, 없으면 미등록(unknown_type)이다.
  const commandRegistry = createCommandRegistry(
    effectiveChannelPort,
    wiring === undefined ? undefined : { move: wiring.moveDeps },
  )
  app.decorate('wsConnections', connections)
  app.decorate('wsLifecyclePort', effectiveLifecyclePort)

  // 종결 seam·수명주기 조율기는 위에서 hoist한 registry를 공유한다.
  app.decorate('wsSessionRegistry', registry)

  // 등록된 바인딩의 단일 종결 함수. teardown은 종결 대상 바인딩의 ctx로 소켓을 역참조해 transport를 정리하고
  // 소켓을 닫는다 — 소켓은 registry가 아니라 셸의 connections(WebSocket→ctx)에만 있으므로 역방향으로 찾는다.
  // 소켓을 못 찾으면(이미 drop된 grace 경로) no-op으로 스킵한다(포트 호출은 resolveDisconnect가 이미 완료).
  const resolveDisconnect = createResolveDisconnect({
    registry,
    port: effectiveLifecyclePort,
    teardown: (binding) => {
      const sock = socketForContext(connections, binding.connection)
      if (sock === undefined) return
      cleanupConnection(connections, sock)
      sock.close()
    },
    logPortFailure: (err) => app.log.error({ err }, 'session lifecycle port onSessionEnd failed'),
  })

  // 서버 주도 종료 수렴 조율기. registry.listBindings 스냅샷을 resolveDisconnect(reason:'shutdown')로 일괄
  // 종결한다. registerWebsocket 1회에 조립해 app.wsShutdown으로 노출한다 — index.ts 신호 핸들러가 종료 시퀀스
  // (markShuttingDown → converge)에 쓰고, 아래 소켓 close 핸들러가 isShuttingDown()으로 link-dead 진입을 우회한다.
  const converger = createShutdownConverger({
    registry,
    resolveDisconnect,
    logConvergeFailure: (binding, err) =>
      app.log.error({ err, characterId: binding.characterId }, 'shutdown converge failed for binding'),
  })
  app.decorate('wsShutdown', converger)

  // 월드 진입 등록·close 판정·grace 재연결 조율기. grace는 env WS_RECONNECT_GRACE_MS로 스케줄한다(하드코딩 금지).
  // graceMs는 thunk로 넘겨 스케줄 시점(연결 close)에 지연 조회한다 — 미설정 env로 buildApp을 막지 않는다.
  // idleMs도 thunk로 넘겨 월드 진입 시점에 지연 조회한다(graceMs 관례 미러, 하드코딩 금지).
  const lifecycle = createSessionLifecycle({
    registry,
    resolveDisconnect,
    graceMs: () => getConfig().WS_RECONNECT_GRACE_MS,
    idleMs: () => getConfig().WS_IDLE_TIMEOUT_MS,
  })

  // 동시 접속 정원. lifecycle/registry 관례처럼 registerWebsocket 1회에 인스턴스화해 연결 간 공유한다
  // (전역·계정별 카운터가 하나의 회계여야 상한을 정확히 관할한다). 상한은 thunk로 넘겨 reserve 시점에 지연
  // 조회한다(graceMs/idleMs 관례 미러) — 팩토리 생성 시점에 getConfig를 읽지 않아 미설정 env가 빌드를 막지 않고,
  // 각 reserve가 최신 상한값을 반영한다.
  const quota = createConnectionQuota(() => ({
    maxGlobal: getConfig().WS_MAX_CONNECTIONS,
    maxPerAccount: getConfig().WS_MAX_CONNECTIONS_PER_ACCOUNT,
  }))

  // 인바운드 유량 제한기 factory를 registerWebsocket 1회에 인스턴스화한다(quota/registry 관례 미러 — per-connection이
  // 아니다: 계정 버킷이 연결 간 공유되는 하나의 레지스트리여야 계정 차원 flood를 정확히 관할한다). 상한은 thunk로 넘겨
  // check 시점에 지연 조회한다(quota 관례) — 팩토리 생성 시 getConfig를 읽지 않아 미설정 env가 빌드를 막지 않는다.
  // app.wsMessageRateLimiter로 노출해 진단·테스트가 activeAccountCount()를 관찰하게 한다.
  // config는 첫 파싱 후 불변이므로 projection을 첫 check에서 한 번만 만들어 캐시한다 — check는 매 프레임 도는
  // hot path라 프레임마다 새 6-필드 객체를 할당하면 flood 시 공격률에 비례한 GC garbage가 된다. 캐시 수명은
  // 팩토리(=registerWebsocket) 수명과 같아, 앱마다 새 팩토리를 만드는 테스트에서도 staleness가 없다.
  let cachedLimits: MessageRateLimits | undefined
  const rateLimiterFactory = createMessageRateLimiterFactory(() => {
    if (cachedLimits !== undefined) return cachedLimits
    const c = getConfig()
    cachedLimits = {
      capacity: c.WS_MSG_RATE_CAPACITY,
      refillPerSec: c.WS_MSG_RATE_REFILL_PER_SEC,
      accountCapacity: c.WS_MSG_RATE_ACCOUNT_CAPACITY,
      accountRefillPerSec: c.WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC,
      maxViolations: c.WS_MSG_RATE_MAX_VIOLATIONS,
      accountMaxEntries: c.WS_MSG_RATE_ACCOUNT_MAX_ENTRIES,
    }
    return cachedLimits
  })
  app.decorate('wsMessageRateLimiter', rateLimiterFactory)

  // per-request 계정 신원 슬롯. null 기본값으로 데코레이트하고 preValidation 훅에서 요청별로 대입한다
  // (객체 리터럴 데코레이트 금지 — 요청 간 공유 참조가 되어 신원이 교차 오염된다).
  app.decorateRequest('account', null)

  // per-request 정원 반납 클로저 슬롯. account 관례 미러 — null 기본값으로 데코레이트하고 reserve 성공 시
  // preValidation 훅이 요청별 releaseOnce를 대입한다(객체 리터럴 데코레이트 금지).
  app.decorateRequest('releaseQuota', null)

  app.register(fastifyWebsocket, { options: { maxPayload: MAX_FRAME_BYTES } })

  app.register((instance, _opts, done) => {
    // upgrade 전 게이트: Origin allowlist 대조(403)·세션 쿠키 검증(401)을 preValidation 수명주기 훅으로
    // 수행한다. reply.code().send() 후 return하면 라이프사이클이 단락돼 upgrade가 완료되지 않는다.
    // 정원 게이트(동시 접속 상한)는 이 지점을 seam으로 두고 정책값은 배포 토픽에서 채운다.
    instance.get(
      GAME_SOCKET_PATH,
      { websocket: true, preValidation: gameAuthPreValidation(sessionAuth, quota) },
      (socket, req: FastifyRequest) => {
        const ctx = createConnectionContext()
        // 게이트가 확정한 계정 신원을 컨텍스트에 보관한다(핸들러·라우팅이 소유권 검증에 재사용).
        ctx.account = req.account
        connections.set(socket, ctx)

        // (Path 2, 정상 close) 정원 반납을 ws 'close'에 별도 리스너로 배선한다 — 아래 close 핸들러(정리·grace)와
        // 독립이다. releaseOnce는 idempotent라 raw-close와 이중 발화해도 한 번만 반납한다. 소켓 핸들러에 도달한
        // 연결은 항상 reserve에 성공했으므로 releaseQuota는 non-null이지만, 데코레이션 null 기본값과의 정합을 위해
        // 방어적으로 가드한다.
        if (req.releaseQuota) socket.on('close', req.releaseQuota)

        // 인바운드 유량 제한기를 socket-open 시점에 arm한다 — deadline과 같은 이유로 pre-handshake 창(open →
        // system:ready)도 유량 제한 대상이 되게 한다(핸드셰이크 완료를 기다리면 그 사이 flood가 무제한이다).
        // account는 preValidation 게이트가 non-null을 보장하지만(인증 실패면 upgrade 자체가 차단), strictNullChecks
        // 하에서 req.account는 여전히 nullable이라 releaseQuota와 같은 방어적 가드로 accountId를 좁혀 캡처한다.
        // accountId는 여기서 한 번만 읽어 상수로 고정한다 — 아래 close 리스너가 이 캡처값을 쓴다(재조회 금지).
        const accountId = req.account?.accountId
        if (accountId !== undefined) {
          // check와 동일한 단조 clock(performance.now())을 넘겨, 생존 계정 버킷 재사용 시 리필 기준을
          // 일치시킨다 — 즉시 재연결은 고갈 유지, refill-horizon 경과 후면 회복(churn 우회 차단, issue #77).
          ctx.rateLimiter = rateLimiterFactory.createConnection(accountId, performance.now())

          // 계정 버킷 반납을 once-guard 클로저로 ws 'close'에 배선한다(releaseQuota 관례 미러). ws 'close'는 이
          // 코드베이스에서 2회 이상 발화할 수 있어(그래서 releaseQuota도 releaseOnce다), 가드가 없으면
          // releaseAccount가 이중 감소해 refCount를 조기에 0으로 만들어 살아 있는 형제 연결의 계정 엔트리를
          // 지운다(계정 차원 상한 우회). rateReleased 플래그가 load-bearing이라, 캡처한 accountId로 정확히 1회만 반납한다.
          let rateReleased = false
          socket.on('close', () => {
            if (rateReleased) return
            rateReleased = true
            rateLimiterFactory.releaseAccount(accountId)
          })
        }

        // 서버 주도 하트비트를 시작해 죽은 연결을 감지·정리한다. env로 튜닝된 간격·임계를 매니저에 넘기고,
        // 반환된 타이머 핸들을 ctx.heartbeat에 배선해 cleanup 경로가 이를 clear할 수 있게 한다.
        const config = getConfig()
        const heartbeat = createHeartbeat(socket, {
          pingIntervalMs: config.WS_HEARTBEAT_PING_INTERVAL_MS,
          maxMissed: config.WS_HEARTBEAT_MAX_MISSED,
        })
        ctx.heartbeat = heartbeat.start()

        // 진행 데드라인(논리 진행, 하트비트와 별도 슬롯)을 만든다. 만료 시 graceful close(terminate 아님).
        // socket-open 즉시 설정한다 — pre-handshake 창(open → system:ready)도 진행 데드라인으로 묶어,
        // 인증 게이트를 통과했으나 핸드셰이크를 완료하지 않는(system:ready 미송신) 연결이 영구 잔존하는 것을
        // 막는다. accept 시 enterInitialState → enterState(characterSelect) → rearmDeadline이 같은 타이머를
        // 새로 설정하므로 중복 arm은 무해하다(rearm은 기존 타이머를 clear 후 재설정). ctx.deadline에 배선해
        // cleanup이 clear한다.
        const deadline = createDeadline(socket, { deadlineMs: config.WS_SESSION_DEADLINE_MS })
        ctx.deadline = deadline
        deadline.rearm()

        // pong 수신은 매니저에 알려 미스 카운터를 리셋한다(연결이 살아 있다는 신호).
        socket.on('pong', () => {
          heartbeat.notePong()
        })

        // 연결 직후 서버 버전을 알리는 system:hello를 push한다. 버전은 per-connection 권위인
        // ctx.protocolVersion을 단일 출처로 쓴다(핸드셰이크 대조와 같은 값). 동기 push는 injectWS
        // 클라이언트가 message 리스너를 붙이기 전에 발화해 프레임이 드롭되는 레이스를 만든다 — setImmediate로
        // 지연시켜 클라이언트의 promise 기반 리스너 부착(process.nextTick보다 늦음) 뒤에 나가게 한다.
        setImmediate(() => {
          safeSend(socket, { type: 'system:hello', protocolVersion: ctx.protocolVersion })
        })

        // 프레임 하나를 처리하는 async 본체 — JSON.parse부터 핸드셰이크·라우팅·FSM까지. 유량 gate 뒤에서
        // per-connection 큐(ctx.frameTail)로 직렬화 호출된다. 내부 방어 try/catch가 어떤 throw/reject든
        // error{internal}로 격리하므로 이 함수는 항상 resolve한다(큐 정지 방지 — trap #1).
        const processFrame = async (data: RawData): Promise<void> => {
          // 프레임 파싱 실패는 핸드셰이크 게이트보다 우선한다(type 판별 이전). 파싱만 별도 try로 감싸
          // bad_payload로 응답하고 종료한다.
          let parsed: unknown
          try {
            parsed = JSON.parse(frameToText(data))
          } catch {
            safeSend(socket, { type: 'error', code: 'bad_payload', message: 'JSON 파싱 실패' })
            return
          }

          // 핸드셰이크·라우팅은 순수 함수(handshake.ts·router.ts)가 계산하고 여기서 부수효과(전송·close·
          // 상태 변이)를 실행한다. fastify errorHandler가 message 핸들러 예외를 잡지 못하므로, 현재 경로가
          // throw-safe하더라도 방어적으로 전체를 감싸 어떤 throw든 error{internal}로 격리하고 소켓을
          // 생존시킨다(네트워크 진입점 견고성 — 원래 의도된 불변식을 핸들러 전체로 확장). 이제 FSM 경로가
          // async라 await한 reject도 이 try가 잡는다(큐 태스크가 항상 resolve하게 하는 격리선 — trap #1).
          try {
            const result = handleHandshakeFrame(ctx, parsed)
            switch (result.action) {
              case 'accept':
                // 핸드셰이크 완료 → characterSelect로 진입시킨다. enterInitialState가 characterList + prompt를
                // 발화한다(setImmediate 금지 — 대화 중 클라이언트는 이미 리스너를 붙였다). enterInitialState는
                // 이제 async라 await한다 — 큐가 이 프레임 완결까지 다음 프레임을 막으므로 emit 순서가 보존된다.
                // ctx.state 변이는 FSM(enterState) 단일 지점에서만 일어난다(Lock D).
                ctx.ready = true
                await enterInitialState(
                  ctx,
                  buildSession(ctx, sessionAuth, socket, deadline, lifecycle, safeSend, effectiveLiveWorld),
                )
                break
              case 'error':
                safeSend(socket, result.event)
                break
              case 'reload':
                // reload 프레임을 먼저 보내고 다음 tick에 close한다 — 같은 tick 내 close가 프레임 플러시를
                // 앞질러 클라이언트가 reload를 못 받는 injectWS 특이 동작을 피한다(서버 권위 종료).
                safeSend(socket, result.event)
                setImmediate(() => {
                  if (socket.readyState === socket.OPEN) socket.close()
                })
                break
              case 'pass': {
                // 핸드셰이크를 통과한 프레임의 위임처는 세션 상태로 갈린다: command 상태면 라우터(dispatch)로,
                // 그 이전(characterSelect·create)이면 FSM handleInput으로 보낸다(Lock C). 이미 파싱된 객체를
                // 재파싱 없이 넘긴다.
                if (ctx.state === ConnectionState.command) {
                  // command/dispatch 분기는 동기로 유지한다 — permissionPort가 동기라 await가 불필요하며 FSM
                  // 경계 밖이다(SessionAuthPort async 마이그레이션은 이 분기를 건드리지 않는다). buildActorContext의
                  // 배선 불변식 throw(account/boundCharacterId null)는 위 방어 try/catch가 error{internal}로 격리한다.
                  const result = dispatch(commandRegistry, parsed, buildActorContext(ctx), permissionPort)
                  // 유효 명령 처리 성공(handled)만 무입력 타이머를 재-arm한다 — 거부(rejected:
                  // unknown_type·bad_payload·forbidden·internal)가 flood로 타이머를 무한 연장하지 못하게 한다.
                  if (result.outcome === 'handled') ctx.idle?.arm()
                  if (result.event !== undefined) safeSend(socket, result.event)
                } else {
                  // handleSessionFrame은 이제 async라 await한다 — 큐가 프레임 완결 뒤에만 다음 프레임을 태워
                  // 공유 상태(state·createProgress) 동시 변이가 없다.
                  await handleSessionFrame(
                    ctx,
                    buildSession(ctx, sessionAuth, socket, deadline, lifecycle, safeSend, effectiveLiveWorld),
                    parsed,
                  )
                }
                break
              }
              default:
                // HandshakeResult에 새 action이 추가되면 컴파일 타임에 여기서 걸린다 — 조용한 no-op 방지.
                assertNever(result)
            }
          } catch (error) {
            // 방어선: handshake/dispatch/FSM 경로의 예상치 못한 throw·reject를 격리한다. 원인은 클라이언트에
            // 노출하지 않되(정적 internal 메시지), 서버에는 로깅해 운영 신호를 남긴다 — buildSession의 배선
            // 불변식 위반(account null 등)이 여기로 올라오므로 로그 없이는 무증상 실패가 된다.
            app.log.error({ err: error }, 'ws message handler failed')
            safeSend(socket, {
              type: 'error',
              code: 'internal',
              message: '메시지 처리 중 서버 오류가 발생했다',
            })
          }
        }

        socket.on('message', (data: RawData) => {
          // 인바운드 유량 gate — JSON.parse·enqueue보다 먼저 둔다(동기, 큐 밖). flood 방어의 핵심 목적이 "정상
          // read + 고속 프레임 투입으로 파싱·dispatch CPU를 소진시키는 공격 차단"이므로, 파싱 비용을 치르기 전에
          // 초과분을 버려야 방어가 성립한다. 큐 이전에 두는 것이 특히 중요하다 — accept를 큐에 태우기 전에
          // 걸러야, flood 프레임이 tail 체인에 무한 누적돼(각 프레임이 클로저+Promise 할당) 메모리를 증폭시키는
          // 것을 막는다(trap #2). rateLimiter는 socket-open에 arm돼 항상 non-null이지만 releaseQuota 관례처럼
          // 옵셔널 체이닝으로 방어한다 — null이면 verdict가 undefined라 gate를 건너뛴다. accept가 아니면
          // early-return해 파싱·dispatch·idle 재-arm까지 구조적으로 우회한다. 클록은 performance.now()(단조)를
          // 쓴다 — 코어 refill이 now의 단조 비감소를 가정하므로, NTP 보정으로 역행할 수 있는 Date.now() 대신
          // 단조 클록을 공급해 역방향 점프가 유발하는 정상 사용자 spurious drop을 막는다.
          const verdict = ctx.rateLimiter?.check(performance.now())
          if (verdict !== undefined && verdict !== 'accept') {
            // 유량 판정은 여기서 동기로 확정한다(초과분 파싱·dispatch를 큐에 태우지 않는 flood 방어의 핵심 —
            // 어떤 verdict든 processFrame을 호출하지 않는다). 응답(emit·close)이 필요한 경우에만, 그 응답을 큐에
            // 실어 accept 프레임의 (지연된) 응답과 send 순서를 보존한다: 동기로 바로 보내면 뒤 프레임의 rate_limited가
            // 앞 프레임(accept)의 큐-지연 응답을 추월해, ws가 한 TCP 세그먼트의 여러 프레임을 연속 emit할 때 순서가
            // 어긋난다. 순서 보존이 필요한 건 emit(drop-warn)과 close(shouldTerminate)뿐이다 — 순수 침묵 drop은
            // 아무 부수효과가 없어 큐 태스크를 만들지 않는다(flood 시 no-op 태스크 누적 방지). verdict·shouldTerminate를
            // 지금(이 프레임의 카운터 기준) 캡처해 하나의 태스크에서 처리한다 — close 판정을 이 프레임에 묶어 원 의미를 지킨다.
            const shouldTerminate = ctx.rateLimiter?.shouldTerminate() ?? false
            if (verdict === 'drop-warn' || shouldTerminate) {
              ctx.frameTail = ctx.frameTail
                .then(() => {
                  // drop-warn(연속 폐기 구간의 첫 폐기)만 1회 경고한다 — 이후 연속 drop은 침묵해 경고 증폭을 막는다.
                  if (verdict === 'drop-warn') {
                    safeSend(socket, {
                      type: 'error',
                      code: 'rate_limited',
                      message: '인바운드 속도 상한을 초과했습니다. 잠시 후 다시 시도하세요.',
                    })
                  }
                  // 지속 위반이 임계를 넘으면 graceful close한다(코어가 소유한 위반 카운터로 판정).
                  if (shouldTerminate && socket.readyState === socket.OPEN) socket.close()
                })
                .catch((err: unknown) => {
                  app.log.error({ err }, 'ws frame queue task failed')
                })
            }
            return
          }

          // accept된 프레임만 per-connection 큐에 직렬화한다. tail에 .then으로 체이닝해 프레임 N+1이 프레임 N
          // 완결(processFrame resolve) 뒤에만 처리되도록 강제한다(*프레임 대 프레임* 재진입 방지). ws는 message
          // 리스너를 await하지 않으므로 이 큐가 없으면 프레임 2가 프레임 1의 await 도중 시작돼 공유 상태를 동시
          // 변이한다. (프레임과 무관한 'close'·deadline·idle 콜백은 이 큐 밖 별개 리스너라 여기서 못 막는다 —
          // 그 await-gap 재진입은 ctx.closed 가드가 별도로 방어한다.) 마지막
          // .catch는 belt-and-suspenders다 — processFrame이 내부 방어 try/catch로 항상 resolve하지만, 예기치 못한
          // rejection이 체인을 끊어(이후 .then 스킵) 연결을 영구 정지시키지 않도록 삼킨다(trap #1). 리스너는 동기
          // 함수로 유지한다(async 리스너를 .on에 넘기면 no-misused-promises 위반이며 ws가 await하지도 않는다).
          ctx.frameTail = ctx.frameTail
            .then(() => processFrame(data))
            .catch((err: unknown) => {
              app.log.error({ err }, 'ws frame queue task failed')
            })
        })

        socket.on('close', () => {
          // close-race 가드: FSM이 포트 await로 멈춘 사이 이 close가 발화할 수 있다. 플래그를 먼저 세워, await
          // 재개 후 FSM(SessionContext.isClosed)이 죽은 연결에 대한 월드 등록·command 상태 대입을 건너뛰게 한다.
          ctx.closed = true
          // 매니저 stop()으로 ping 타이머를 정지하고 진행 데드라인을 clear한다.
          heartbeat.stop()
          deadline.clear()
          // 도메인 판정(§3.4): command + 등록 + binding.connection===ctx면 markLinkDead로 grace 창을 연다.
          // 미등록(characterSelect·create)·stale(옛 소켓)·비-command는 no-op이라 도메인 종결·포트 호출이 없다.
          // binding.connection===ctx 가드가 load-bearing: 서버 주도 종료(evict/grace) 후 옛 소켓의 뒤늦은
          // close가 새 세션을 markLinkDead하는 재진입을 막는다.
          // 서버 주도 종료 시(isShuttingDown) markLinkDead(grace)를 건너뛴다 — 이미 converge가 등록 바인딩을
          // 일괄 종결했으므로, 뒤늦은 close가 새 link-dead(+새 30s grace 타이머)를 만들어 종료를 지연시키지 못하게 한다.
          if (!converger.isShuttingDown()) lifecycle.handleClose(ctx)
          // transport 정리는 소켓 한정 — markLinkDead 여부와 무관하게 이 소켓의 heartbeat·deadline·idle을
          // 정리하고 connections에서 제거한다(link-dead 바인딩은 registry에 유지, ctx 참조도 살아 있다).
          cleanupConnection(connections, socket)
        })
      },
    )
    done()
  })
}
