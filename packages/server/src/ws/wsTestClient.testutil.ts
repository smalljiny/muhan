import { serverEventSchema, PROTOCOL_VERSION, type ServerEvent } from 'shared'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { GAME_SOCKET_PATH } from './plugin.js'
import { buildApp } from '../app.js'
import {
  SEED_VALID_COOKIE,
  SEED_CHARACTER_ID,
  createSeededAuthAdapter,
} from '../auth/inMemorySessionAuthAdapter.js'

/**
 * WS transport 테스트 헬퍼 — injectWS 클라이언트(단위)와 실 `ws` 클라이언트(E2E)를 함께 관찰하는 유틸.
 *
 * `waitForMessage`/`waitForClose`는 최소 emitter 계약(`{ once(event, cb) }`)에만 의존해 injectWS
 * 클라이언트와 실 `ws` 클라이언트가 동일하게 충족한다(injectWS는 `await app.ready()` 후 동작). Story 7의
 * `startTestServer`/`newAuthedClient`/`waitForOpen`은 포트 0 실 TCP 흐름을 세우는 헬퍼로 같은 관찰기를 재사용한다.
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

/** 프레임을 순서대로 하나씩 꺼내는 리더. 유실 없이 다중 동기 프레임을 소비한다. */
export interface MessageReader {
  next(timeoutMs?: number): Promise<ServerEvent>
}

/**
 * 소켓에 영구 `message` 리스너 하나를 걸어 도착 프레임을 버퍼링하는 리더를 만든다.
 *
 * `waitForMessage`는 `once`라 프레임당 리스너 하나만 대기시킨다 — 서버가 같은 턴에 2프레임 이상을
 * 동기 발화하면(핸드셰이크 accept의 characterList+prompt) 배치 도착분이 유실되거나 두 `once`가 같은
 * 프레임을 중복 소비한다. 이 리더는 영구 리스너로 모든 프레임을 큐에 쌓아 `next()`가 순서대로 꺼내게
 * 한다(유실 없음). 파싱 실패(계약 밖 이벤트)는 리스너에서 throw하지 않고 다음 `next()`에 표면화한다
 * (공유 유틸의 unhandled rejection 방지). 소켓당 리더는 하나만 쓴다 — `waitForMessage`와 혼용하면 두
 * 리스너가 프레임을 이중 소비한다.
 */
export function createMessageReader(ws: WebSocket): MessageReader {
  const queue: Array<{ ok: true; value: ServerEvent } | { ok: false; error: Error }> = []
  const waiters: Array<(item: { ok: true; value: ServerEvent } | { ok: false; error: Error }) => void> = []

  ws.on('message', (data: unknown) => {
    let item: { ok: true; value: ServerEvent } | { ok: false; error: Error }
    try {
      item = { ok: true, value: serverEventSchema.parse(JSON.parse(String(data))) }
    } catch (err) {
      item = { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
    }
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(item)
    else queue.push(item)
  })

  return {
    next(timeoutMs = 1000): Promise<ServerEvent> {
      const buffered = queue.shift()
      if (buffered !== undefined) {
        return buffered.ok ? Promise.resolve(buffered.value) : Promise.reject(buffered.error)
      }
      return waitForEvent<ServerEvent>(timeoutMs, 'reader.next', (settle, fail) => {
        waiters.push((item) => (item.ok ? settle(item.value) : fail(item.error)))
      })
    },
  }
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
 * 소켓이 `open`될 때까지 기다린다. `timeoutMs` 내에 열리지 않거나 `error`가 나면 reject한다.
 * `waitForMessage`로 hello 리스너를 먼저 건 다음 이 함수로 open을 확인하는 순서로 쓴다.
 */
export function waitForOpen(ws: WebSocket, timeoutMs = 1000): Promise<void> {
  return waitForEvent<void>(timeoutMs, 'waitForOpen', (settle, fail) => {
    ws.once('open', () => settle())
    ws.once('error', fail)
  })
}

// ── 인증(Story 3) 테스트 헬퍼 ─────────────────────────────────────────────────

/** preValidation 게이트를 통과하는 정규 테스트 Origin. env WS_ALLOWED_ORIGINS 값과 일치해야 한다. */
export const DEFAULT_TEST_ORIGIN = 'http://localhost'

/**
 * cookie/Origin 주입 옵션. `undefined`(미지정)면 유효 기본값(시드 쿠키·허용 Origin)을 쓰고, `null`이면
 * 해당 헤더를 아예 생략한다(부재 케이스 테스트). `cookie`는 `__session` 쿠키에 담길 순수 토큰 값이다.
 */
export interface AuthHeaderOptions {
  cookie?: string | null
  origin?: string | null
}

/** AuthHeaderOptions를 실제 upgrade 요청 헤더(`cookie`·`origin`)로 변환한다. */
function buildAuthHeaders(opts?: AuthHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  const cookie = opts?.cookie === undefined ? SEED_VALID_COOKIE : opts.cookie
  if (cookie !== null) headers.cookie = `__session=${cookie}`
  const origin = opts?.origin === undefined ? DEFAULT_TEST_ORIGIN : opts.origin
  if (origin !== null) headers.origin = origin
  return headers
}

/**
 * 시드 세션 어댑터가 배선된 app을 만든다. preValidation 게이트가 유효 쿠키를 인식하도록, 모든 인증
 * 테스트의 buildApp 진입점을 이 팩토리로 단일화한다(어댑터 시드 누락 방지). deps는 buildApp으로 전달된다.
 */
export function buildSeededApp(deps?: Parameters<typeof buildApp>[0]): FastifyInstance {
  return buildApp({ ...deps, sessionAuth: deps?.sessionAuth ?? createSeededAuthAdapter() })
}

/**
 * injectWS로 게임 소켓 upgrade를 시도한다(단위 테스트 진입점). 기본값은 유효 시드 쿠키+허용 Origin이라
 * 게이트를 통과한다. 게이트 거부(non-101) 시 injectWS는 promise를 reject한다(`Unexpected server response: NNN`).
 */
export function injectAuthedWS(app: FastifyInstance, opts?: AuthHeaderOptions): Promise<WebSocket> {
  return app.injectWS(GAME_SOCKET_PATH, { headers: buildAuthHeaders(opts) })
}

/**
 * 실 `ws` 클라이언트를 cookie/Origin 헤더와 함께 만든다(E2E 진입점). 기본값은 유효 시드 쿠키+허용 Origin.
 * `autoPong` 등 실 클라이언트 옵션도 함께 받아 하트비트 테스트가 재사용한다.
 */
export function newAuthedClient(
  url: string,
  opts?: AuthHeaderOptions & RealClientOptions,
): WebSocket {
  const { cookie, origin, ...realOpts } = opts ?? {}
  return new WebSocket(url, { headers: buildAuthHeaders({ cookie, origin }), ...realOpts })
}

/**
 * 실 `ws` upgrade 거부를 관찰한다. 거부된 upgrade는 `'error'`·`'close'`가 아니라 `'unexpected-response'`
 * 이벤트로 statusCode(401·403)를 알린다 — 그 statusCode를 돌려준다. 예상과 달리 `'open'`되면 reject한다
 * (소켓이 열려선 안 되는 거부 케이스의 강한 단언).
 */
export function waitForUnexpectedResponse(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return waitForEvent<number>(timeoutMs, 'waitForUnexpectedResponse', (settle, fail) => {
    ws.once('unexpected-response', (_req, res) => settle(res.statusCode ?? 0))
    ws.once('open', () => fail(new Error('거부되어야 할 upgrade가 열렸다')))
  })
}

// ── 세션 FSM(Story 4) 종단 배선 헬퍼 ──────────────────────────────────────────

/**
 * 소켓을 connect→hello→ready→characterList→prompt→selectCharacter→entered→command 경로로 왕복시켜
 * command 상태에 도달시킨다(Lock B — Story 4·5·7이 공유하는 단일 traversal).
 *
 * 유실 없는 `createMessageReader`로 핸드셰이크 accept가 동기 발화하는 2프레임(characterList+prompt)을
 * 안전히 소비한다. injectWS 소켓은 이미 OPEN이라 open 대기를 건너뛰고, 실 `ws` 소켓은 open을 먼저
 * 기다린 뒤 send한다(send-before-open throw 회피). 반환된 리더로 호출자가 이후 프레임(예: echo:result)을
 * 이어서 읽는다 — 같은 소켓에 `waitForMessage`를 섞지 않는다(이중 소비).
 *
 * 리더는 어떤 프레임도 발화되기 전에 리스너를 걸어야 하므로, 이 헬퍼는 소켓 생성 직후(첫 send·open 전)
 * 호출한다.
 */
export async function enterCommandState(ws: WebSocket, timeoutMs = 1000): Promise<MessageReader> {
  const reader = createMessageReader(ws)
  if (ws.readyState !== ws.OPEN) await waitForOpen(ws, timeoutMs)

  await reader.next(timeoutMs) // system:hello
  ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
  await reader.next(timeoutMs) // session:characterList
  await reader.next(timeoutMs) // session:prompt(selectCharacter)
  ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
  await reader.next(timeoutMs) // session:entered
  return reader
}
