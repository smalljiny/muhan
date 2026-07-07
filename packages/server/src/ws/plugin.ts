import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { RawData, WebSocket } from 'ws'
import type { ServerEvent } from 'shared'
import {
  cleanupConnection,
  createConnectionContext,
  type ConnectionContext,
} from './connection.js'

/**
 * 게임 소켓 경로. 인증·핸드셰이크·라우팅 없이 transport만 마운트한다(Story 4-6에서 로직 추가).
 */
export const GAME_SOCKET_PATH = '/game'

/**
 * 단일 프레임 최대 바이트. 프로토콜 레이어(`options.maxPayload`)로 강제해 버퍼 완성 전에 초과
 * 프레임을 거부한다(1009 close) — 메모리 소진 방어의 핵심. 핸들러 안에서 크기를 재는 방식은
 * 이미 버퍼링된 뒤라 방어가 되지 않는다.
 */
export const MAX_FRAME_BYTES = 64 * 1024

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
      // T3.4 SEAM (Story 4-6): 인증·핸드셰이크는 여기 이전에 preValidation 훅으로 게이트된다.
      // transport-only인 이 Story는 seam만 남기고 인증·라우팅 로직을 넣지 않는다.
      connections.set(socket, createConnectionContext())

      socket.on('message', (data: RawData) => {
        // message 핸들러가 던진 에러는 fastify errorHandler가 잡지 못하므로 자체 try/catch로 감싼다.
        try {
          // Story 4-6: 파싱된 명령을 라우터로 디스패치한다. transport-only인 이 Story는 파싱만 검증한다.
          JSON.parse(frameToText(data))
        } catch {
          safeSend(socket, {
            type: 'error',
            code: 'bad_payload',
            message: 'JSON 파싱 실패',
          })
        }
      })

      socket.on('close', () => {
        cleanupConnection(connections, socket)
      })
    })
    done()
  })
}
