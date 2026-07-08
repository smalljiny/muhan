import { serverEventSchema, type ServerEvent } from 'shared'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { GAME_SOCKET_PATH } from './plugin.js'

/**
 * WS transport 테스트 헬퍼 — injectWS 클라이언트(단위)와 실 `ws` 클라이언트(E2E)를 함께 관찰하는 유틸.
 *
 * `waitForMessage`/`waitForClose`는 최소 emitter 계약(`{ once(event, cb) }`)에만 의존해 injectWS
 * 클라이언트와 실 `ws` 클라이언트가 동일하게 충족한다(injectWS는 `await app.ready()` 후 동작). Story 7의
 * `startTestServer`/`newClient`/`waitForOpen`은 포트 0 실 TCP 흐름을 세우는 헬퍼로 같은 관찰기를 재사용한다.
 */

/** `waitForMessage`가 요구하는 최소 emitter 계약. `ws` WebSocket이 구조적으로 충족한다. */
export interface MessageEmitter {
  once(event: 'message', listener: (data: unknown) => void): void
}

/** `waitForClose`가 요구하는 최소 emitter 계약. `ws` WebSocket이 구조적으로 충족한다. */
export interface CloseEmitter {
  once(event: 'close', listener: (code: number) => void): void
}

/**
 * 단일 이벤트를 타임아웃과 함께 기다리는 공통 스켈레톤. `register`가 첫 이벤트에서 `settle`을 부르면
 * 타이머를 해제하고 resolve, `fail`을 부르면 reject한다. `waitForClose`·`waitForMessage`가 공유한다.
 */
function waitForEvent<T>(
  timeoutMs: number,
  label: string,
  register: (settle: (value: T) => void, fail: (err: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 타임아웃`)), timeoutMs)
    const settle = (value: T): void => {
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (err: Error): void => {
      clearTimeout(timer)
      reject(err)
    }
    register(settle, fail)
  })
}

/**
 * 소켓이 닫힐 때까지 기다렸다가 close 코드를 돌려준다. `timeoutMs` 내에 닫히지 않으면 reject.
 * 프로토콜 레이어 거부(예: maxPayload 초과 → 1009)를 관찰하는 데 쓴다. `ws.send()` 전에 호출한다.
 */
export function waitForClose(ws: CloseEmitter, timeoutMs = 1000): Promise<number> {
  return waitForEvent(timeoutMs, 'waitForClose', (settle) => ws.once('close', settle))
}

/**
 * 소켓이 다음 메시지를 보낼 때까지 기다렸다가 `serverEventSchema`로 검증·파싱해 돌려준다.
 * `once`로 리스너를 걸어 한 번만 소비하고, 파싱이 실패(계약 밖 이벤트)하면 promise를 clean reject한다
 * (emitter 콜백에서 throw하면 uncaught로 새므로 try/catch로 감싼다). `ws.send()` 전에 호출해 리스너를 먼저 건다.
 */
export function waitForMessage(ws: MessageEmitter, timeoutMs = 1000): Promise<ServerEvent> {
  return waitForEvent(timeoutMs, 'waitForMessage', (settle, fail) =>
    ws.once('message', (data) => {
      try {
        settle(serverEventSchema.parse(JSON.parse(String(data))))
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }),
  )
}

/**
 * `predicate`가 true가 될 때까지 `intervalMs`마다 폴링한다. `timeoutMs` 초과 시 reject.
 * 서버측 상태 전이(예: 연결 레지스트리 크기 변화)를 경합 없이 관찰하는 데 쓴다.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 타임아웃')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 실 `ws` 클라이언트 연결 옵션. `autoPong: false`는 프로토콜 레벨 자동 pong을 억제해
 * 하트비트-miss terminate(Story 7 T7.4)를 실 소켓으로 강제하는 데 쓴다. 모든 필드가 선택이라
 * ws `ClientOptions`에 구조적으로 대입된다(fresh literal 아닌 변수로 넘겨 excess-property 회피).
 */
export interface RealClientOptions {
  autoPong?: boolean
}

/**
 * app을 포트 0(임의 포트)·`127.0.0.1`(IPv4 loopback)로 리슨시키고 게임 소켓 URL을 돌려준다.
 * `localhost`는 ::1로 resolve될 수 있어 IPv4 bind 서버에 간헐 ECONNREFUSED를 유발하므로 명시적
 * IPv4를 쓴다. 할당된 실제 포트는 `app.server.address()`에서 읽는다. injectWS와 구별되는 실 TCP 흐름.
 */
export async function startTestServer(app: FastifyInstance, path = GAME_SOCKET_PATH): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('포트 0 리슨 주소를 확인할 수 없다')
  }
  return `ws://127.0.0.1:${address.port}${path}`
}

/**
 * 실 `ws` 클라이언트 소켓을 만들어 (open을 기다리지 않고) 동기 반환한다.
 *
 * open 전에 `waitForMessage`로 `message` 리스너를 먼저 걸 수 있게 해, 서버가 upgrade 직후
 * `setImmediate`로 push하는 `system:hello`가 리스너 부착 전에 발화해 드롭되는 레이스를 없앤다
 * (open 후 리스너를 걸면 hello 프레임이 이미 지나가 유실될 수 있다). WS 프레임은 open 이후에만
 * 도착하므로 open 전 리스너 부착은 안전하다.
 */
export function newClient(url: string, options?: RealClientOptions): WebSocket {
  return new WebSocket(url, options)
}

/**
 * 소켓이 `open`될 때까지 기다린다. `timeoutMs` 내에 열리지 않거나 `error`가 나면 reject한다.
 * `waitForMessage`로 hello 리스너를 먼저 건 다음 이 함수로 open을 확인하는 순서로 쓴다.
 */
export function waitForOpen(ws: WebSocket, timeoutMs = 1000): Promise<void> {
  return waitForEvent<void>(timeoutMs, 'waitForOpen', (settle, fail) => {
    ws.once('open', () => settle())
    ws.once('error', fail)
  })
}
