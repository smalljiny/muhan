import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { RawData, WebSocket } from 'ws'
import type { ServerEvent } from 'shared'
import {
  cleanupConnection,
  createConnectionContext,
  type ConnectionContext,
} from './connection.js'
import { handleHandshakeFrame } from './handshake.js'
import { createHeartbeat } from './heartbeat.js'
import { createCommandRegistry, dispatch } from './router.js'
import { getConfig } from '../config/env.js'

/** switch 완전성 컴파일 강제 — 도달하면 union에 미처리 variant가 생긴 것이다. */
function assertNever(value: never): never {
  throw new Error(`처리되지 않은 HandshakeResult: ${JSON.stringify(value)}`)
}

/**
 * 게임 소켓 경로. transport 위에 버전 협상 핸드셰이크(Story 4)와 명령 라우팅(Story 6)이 배선돼 있다.
 * 인증(T2)만 seam으로 남아 미구현이다.
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
declare module 'fastify' {
  interface FastifyInstance {
    wsConnections: Map<WebSocket, ConnectionContext>
  }
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
 * `@fastify/websocket`을 transport-only로 등록하고 게임 소켓 라우트를 마운트한다.
 *
 * `verifyClient`은 쓰지 않는다(transport-only). 플러그인을 먼저 등록해 `onRoute` 훅이 자리잡은 뒤
 * 별도 encapsulated 플러그인에서 라우트를 마운트한다(등록 순서 의존을 top-level await 없이 만족).
 * per-connection 정리는 소켓 `'close'` 이벤트가, 서버 종료 시 소켓 닫기는 플러그인 기본 preClose가 맡는다.
 */
export function registerWebsocket(app: FastifyInstance): void {
  const connections = new Map<WebSocket, ConnectionContext>()
  app.decorate('wsConnections', connections)

  app.register(fastifyWebsocket, { options: { maxPayload: MAX_FRAME_BYTES } })

  app.register((instance, _opts, done) => {
    // T3.4 SEAM (Story 4-6): 인증 preValidation 훅은 여기 라우트 옵션에 붙는다(현재 미부착).
    instance.get(GAME_SOCKET_PATH, { websocket: true }, (socket) => {
      // T3.4 SEAM (Story 4-6): 인증은 여기 이전에 preValidation 훅으로 게이트된다(현재 미부착).
      const ctx = createConnectionContext()
      connections.set(socket, ctx)

      // 서버 주도 하트비트를 시작해 죽은 연결을 감지·정리한다. env로 튜닝된 간격·임계를 매니저에 넘기고,
      // 반환된 타이머 핸들을 ctx.heartbeat에 배선해 cleanup 경로가 이를 clear할 수 있게 한다.
      const config = getConfig()
      const heartbeat = createHeartbeat(socket, {
        pingIntervalMs: config.WS_HEARTBEAT_PING_INTERVAL_MS,
        maxMissed: config.WS_HEARTBEAT_MAX_MISSED,
      })
      ctx.heartbeat = heartbeat.start()

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
        // message 핸들러가 던진 에러는 fastify errorHandler가 잡지 못하므로 자체 try/catch로 감싼다.
        let parsed: unknown
        try {
          parsed = JSON.parse(frameToText(data))
        } catch {
          // 파싱 실패는 핸드셰이크 게이트보다 우선한다(type 판별 이전에 실패).
          safeSend(socket, { type: 'error', code: 'bad_payload', message: 'JSON 파싱 실패' })
          return
        }

        // 핸드셰이크 상태 전이는 순수 함수가 계산하고, 여기서 부수효과(전송·close·상태 변이)를 실행한다.
        const result = handleHandshakeFrame(ctx, parsed)
        switch (result.action) {
          case 'accept':
            ctx.ready = true
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
            // 핸드셰이크를 통과한 프레임을 라우터로 디스패치한다. 이미 파싱된 객체를 재파싱 없이 넘기고,
            // 순수 라우터가 계산한 응답 이벤트가 있을 때만 전송한다(예외 격리는 dispatch 내부가 담당).
            const event = dispatch(commandRegistry, parsed)
            if (event !== undefined) safeSend(socket, event)
            break
          }
          default:
            // HandshakeResult에 새 action이 추가되면 컴파일 타임에 여기서 걸린다 — 조용한 no-op 방지.
            assertNever(result)
        }
      })

      socket.on('close', () => {
        // 매니저 stop()으로 ping 타이머를 정지하고, cleanupConnection이 ctx.heartbeat를 한 번 더 clear한다.
        heartbeat.stop()
        cleanupConnection(connections, socket)
      })
    })
    done()
  })
}
