import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { RawData, WebSocket } from 'ws'
import type { ServerEvent } from 'shared'
import { cleanupConnection, createConnectionContext, type ConnectionContext } from './connection.js'
import { handleHandshakeFrame } from './handshake.js'
import { createHeartbeat } from './heartbeat.js'
import { createDeadline, type Deadline } from './deadline.js'
import { createCommandRegistry, dispatch } from './router.js'
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
import { createSessionRegistry, type SessionRegistry } from './sessionRegistry.js'
import { createResolveDisconnect } from './resolveDisconnect.js'
import { createSessionLifecycle, type SessionLifecycle } from './sessionLifecycle.js'

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

// 명령 레지스트리는 무상태 핸들러의 배선표라 연결 간 공유 안전하다 — 모듈 로드 시 1회 조립한다.
const commandRegistry = createCommandRegistry()

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
  }
  interface FastifyRequest {
    account: AccountIdentity | null
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
 * 이벤트를 소켓으로 안전하게 직렬화·전송한다. 프레임 수신과 응답 사이에 피어가 닫으면 `send`가
 * throw하며 message 리스너를 탈출하므로(fastify errorHandler 미포착), OPEN 상태만 전송하고
 * 잔여 예외를 삼킨다. Story 4-6의 응답 경로도 이 가드를 재사용한다.
 */
function safeSend(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== socket.OPEN) return
  try {
    socket.send(JSON.stringify(event))
  } catch {
    // 전송 직전 소켓이 닫힌 경우. 곧 'close'가 발화해 cleanup이 돌므로 무시한다.
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
 */
function buildSession(
  ctx: ConnectionContext,
  sessionAuth: SessionAuthPort,
  socket: WebSocket,
  deadline: Deadline,
  lifecycle: SessionLifecycle,
): SessionContext {
  if (ctx.account === null) {
    throw new Error('세션 불변식 위반: 인증 게이트를 통과했으나 account가 없다')
  }
  const account = ctx.account
  return {
    account,
    sessionAuth,
    emit: (event) => safeSend(socket, event),
    rearmDeadline: () => deadline.rearm(),
    clearDeadline: () => deadline.clear(),
    enterWorld: (characterId) => lifecycle.enterWorld(ctx, account.accountId, characterId),
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
 * async 훅에서 `return reply.code().send()`는 라이프사이클을 단락시켜 upgrade를 완료하지 않는다(거부).
 * 통과 시 undefined를 반환해 라이프사이클을 계속 진행시킨다.
 */
function gameAuthPreValidation(
  sessionAuth: SessionAuthPort,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (req, reply) => {
    const config = getConfig()

    // (1) Origin 게이트 — fail-closed.
    const origin = req.headers.origin
    if (origin === undefined || !config.WS_ALLOWED_ORIGINS.includes(origin)) {
      return reply.code(403).send({ error: 'forbidden_origin' })
    }

    // (2) 세션 쿠키 게이트 — __session 부재·무효 모두 401.
    const cookie = extractSessionCookie(req.headers.cookie)
    const identity = cookie === undefined ? null : sessionAuth.validateSessionCookie(cookie)
    if (identity === null) {
      return reply.code(401).send({ error: 'unauthenticated' })
    }

    req.account = identity
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
 */
export function registerWebsocket(
  app: FastifyInstance,
  sessionAuth: SessionAuthPort,
  lifecyclePort: SessionLifecyclePort = createNoopSessionLifecycleAdapter(app.log),
): void {
  const connections = new Map<WebSocket, ConnectionContext>()
  app.decorate('wsConnections', connections)
  app.decorate('wsLifecyclePort', lifecyclePort)

  // 세션 레지스트리·종결 seam·수명주기 조율기를 registerWebsocket 1회에 인스턴스화해 연결 간 공유한다
  // (per-connection이 아니다 — 재연결이 이전 소켓의 바인딩을 찾으려면 하나의 색인이어야 한다).
  const registry = createSessionRegistry()
  app.decorate('wsSessionRegistry', registry)

  // 등록된 바인딩의 단일 종결 함수. teardown은 종결 대상 바인딩의 ctx로 소켓을 역참조해 transport를 정리하고
  // 소켓을 닫는다 — 소켓은 registry가 아니라 셸의 connections(WebSocket→ctx)에만 있으므로 역방향으로 찾는다.
  // 소켓을 못 찾으면(이미 drop된 grace 경로) no-op으로 스킵한다(포트 호출은 resolveDisconnect가 이미 완료).
  const resolveDisconnect = createResolveDisconnect({
    registry,
    port: lifecyclePort,
    teardown: (binding) => {
      const sock = socketForContext(connections, binding.connection)
      if (sock === undefined) return
      cleanupConnection(connections, sock)
      sock.close()
    },
    logPortFailure: (err) => app.log.error({ err }, 'session lifecycle port onSessionEnd failed'),
  })

  // 월드 진입 등록·close 판정·grace 재연결 조율기. grace는 env WS_RECONNECT_GRACE_MS로 스케줄한다(하드코딩 금지).
  // graceMs는 thunk로 넘겨 스케줄 시점(연결 close)에 지연 조회한다 — 미설정 env로 buildApp을 막지 않는다.
  const lifecycle = createSessionLifecycle({
    registry,
    resolveDisconnect,
    graceMs: () => getConfig().WS_RECONNECT_GRACE_MS,
  })

  // per-request 계정 신원 슬롯. null 기본값으로 데코레이트하고 preValidation 훅에서 요청별로 대입한다
  // (객체 리터럴 데코레이트 금지 — 요청 간 공유 참조가 되어 신원이 교차 오염된다).
  app.decorateRequest('account', null)

  app.register(fastifyWebsocket, { options: { maxPayload: MAX_FRAME_BYTES } })

  app.register((instance, _opts, done) => {
    // upgrade 전 게이트: Origin allowlist 대조(403)·세션 쿠키 검증(401)을 preValidation 수명주기 훅으로
    // 수행한다. reply.code().send() 후 return하면 라이프사이클이 단락돼 upgrade가 완료되지 않는다.
    // 정원 게이트(동시 접속 상한)는 이 지점을 seam으로 두고 정책값은 배포 토픽에서 채운다.
    instance.get(
      GAME_SOCKET_PATH,
      { websocket: true, preValidation: gameAuthPreValidation(sessionAuth) },
      (socket, req: FastifyRequest) => {
        const ctx = createConnectionContext()
        // 게이트가 확정한 계정 신원을 컨텍스트에 보관한다(핸들러·라우팅이 소유권 검증에 재사용).
        ctx.account = req.account
        connections.set(socket, ctx)

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

        socket.on('message', (data: RawData) => {
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
          // 생존시킨다(네트워크 진입점 견고성 — 원래 의도된 불변식을 핸들러 전체로 확장).
          try {
            const result = handleHandshakeFrame(ctx, parsed)
            switch (result.action) {
              case 'accept':
                // 핸드셰이크 완료 → characterSelect로 진입시킨다. enterInitialState가 같은 message-handler
                // 턴에 characterList + prompt를 동기 발화한다(setImmediate 금지 — 대화 중 클라이언트는 이미
                // 리스너를 붙였다). ctx.state 변이는 FSM(enterState) 단일 지점에서만 일어난다(Lock D).
                ctx.ready = true
                enterInitialState(ctx, buildSession(ctx, sessionAuth, socket, deadline, lifecycle))
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
                  const result = dispatch(commandRegistry, parsed)
                  if (result.event !== undefined) safeSend(socket, result.event)
                } else {
                  handleSessionFrame(
                    ctx,
                    buildSession(ctx, sessionAuth, socket, deadline, lifecycle),
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
            // 방어선: handshake/dispatch 경로의 예상치 못한 throw를 격리한다. 원인은 클라이언트에 노출하지
            // 않되(정적 internal 메시지), 서버에는 로깅해 운영 신호를 남긴다 — buildSession의 배선 불변식
            // 위반(account null 등)이 여기로 올라오므로 로그 없이는 무증상 실패가 된다.
            app.log.error({ err: error }, 'ws message handler failed')
            safeSend(socket, {
              type: 'error',
              code: 'internal',
              message: '메시지 처리 중 서버 오류가 발생했다',
            })
          }
        })

        socket.on('close', () => {
          // 매니저 stop()으로 ping 타이머를 정지하고 진행 데드라인을 clear한다.
          heartbeat.stop()
          deadline.clear()
          // 도메인 판정(§3.4): command + 등록 + binding.connection===ctx면 markLinkDead로 grace 창을 연다.
          // 미등록(characterSelect·create)·stale(옛 소켓)·비-command는 no-op이라 도메인 종결·포트 호출이 없다.
          // binding.connection===ctx 가드가 load-bearing: 서버 주도 종료(evict/grace) 후 옛 소켓의 뒤늦은
          // close가 새 세션을 markLinkDead하는 재진입을 막는다.
          lifecycle.handleClose(ctx)
          // transport 정리는 소켓 한정 — markLinkDead 여부와 무관하게 이 소켓의 heartbeat·deadline·idle을
          // 정리하고 connections에서 제거한다(link-dead 바인딩은 registry에 유지, ctx 참조도 살아 있다).
          cleanupConnection(connections, socket)
        })
      },
    )
    done()
  })
}
