import { serverEventSchema, type ServerEvent } from 'shared'

/**
 * WS transport 테스트 헬퍼 — `app.injectWS()`가 돌려주는 `ws` 클라이언트를 관찰하는 유틸.
 *
 * 최소 인터페이스(`{ on(event, cb) }`)에만 의존하도록 설계해, Story 7이 실제 `ws` 클라이언트로
 * E2E를 재확장할 때 재작성 없이 그대로 재사용되게 한다. injectWS는 `await app.ready()` 후에만 동작한다.
 */

/** `waitForMessage`가 요구하는 최소 emitter 계약. `ws` WebSocket이 구조적으로 충족한다. */
export interface MessageEmitter {
  on(event: 'message', listener: (data: unknown) => void): void
}

/** `waitForClose`가 요구하는 최소 emitter 계약. `ws` WebSocket이 구조적으로 충족한다. */
export interface CloseEmitter {
  on(event: 'close', listener: (code: number) => void): void
}

/**
 * 단일 이벤트를 타임아웃과 함께 기다리는 공통 스켈레톤. `register`가 첫 이벤트에서 `settle`을 부르면
 * 타이머를 해제하고 resolve한다. `waitForClose`·`waitForMessage`가 이벤트명·매핑만 달리해 공유한다.
 */
function waitForEvent<T>(
  timeoutMs: number,
  label: string,
  register: (settle: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 타임아웃`)), timeoutMs)
    register((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/**
 * 소켓이 닫힐 때까지 기다렸다가 close 코드를 돌려준다. `timeoutMs` 내에 닫히지 않으면 reject.
 * 프로토콜 레이어 거부(예: maxPayload 초과 → 1009)를 관찰하는 데 쓴다. `ws.send()` 전에 호출한다.
 */
export function waitForClose(ws: CloseEmitter, timeoutMs = 1000): Promise<number> {
  return waitForEvent(timeoutMs, 'waitForClose', (settle) => ws.on('close', settle))
}

/**
 * 소켓이 다음 메시지를 보낼 때까지 기다렸다가 `serverEventSchema`로 검증·파싱해 돌려준다.
 * unchecked 캐스트 대신 스키마로 파싱해 서버가 계약 밖 이벤트를 보내면 테스트 경계에서 잡는다.
 * `timeoutMs` 내에 도착하지 않으면 reject한다. `ws.send()` 전에 호출해 리스너를 먼저 건다.
 */
export function waitForMessage(ws: MessageEmitter, timeoutMs = 1000): Promise<ServerEvent> {
  return waitForEvent(timeoutMs, 'waitForMessage', (settle) =>
    ws.on('message', (data) => settle(serverEventSchema.parse(JSON.parse(String(data))))),
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
