/**
 * per-connection 진행 데드라인 매니저 — 소켓 하나의 논리 진행을 감시한다.
 *
 * 단발 setTimeout 모델: `rearm`이 데드라인 타이머를 (재)설정하고, `deadlineMs` 안에 진행(상태 전이 또는
 * create 서브상태 전진)이 없으면 타이머가 발화해 소켓을 graceful `close`한다(하트비트의 terminate와 달리
 * 정상 종료 프레임을 보낸다). 진행이 있을 때마다 셸/FSM이 `rearm`을 불러 타이머를 새로 설정한다. 하트비트가
 * 물리 생존(setInterval·terminate)을 관할하는 것과 별도 슬롯으로 논리 진행(setTimeout·close)을 관할한다.
 * 타이머는 주입 가능(`setTimeoutFn`/`clearTimeoutFn`)이라 fake clock으로 결정적 단위 테스트가 가능하고,
 * 미주입 시 전역 타이머를 쓴다.
 */

/** 매니저가 의존하는 소켓 표면. 실 ws.WebSocket이 구조적으로 충족한다. */
export interface DeadlineSocket {
  close(): void
}

/** 데드라인 튜닝 + 타이머 주입 옵션. 타이머 미주입 시 전역 setTimeout/clearTimeout을 쓴다. */
export interface DeadlineOptions {
  readonly deadlineMs: number
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
  readonly onExpire?: () => void
}

/** per-connection 데드라인 핸들. `rearm`은 데드라인을 (재)설정하고, `clear`는 idempotent 해제다. */
export interface Deadline {
  rearm(): void
  clear(): void
}

/**
 * 데드라인 매니저를 만든다. 상태(현재 타이머 핸들)는 클로저에 캡슐화한다.
 *
 * `rearm`은 기존 타이머를 clear한 뒤 새 setTimeout을 설정한다(첫 설정·재설정 모두 동일 동작). 만료 시
 * `socket.close()` 후 `onExpire?.()`를 호출한다.
 */
export function createDeadline(socket: DeadlineSocket, opts: DeadlineOptions): Deadline {
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout

  let timer: NodeJS.Timeout | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  function expire(): void {
    // 단발 발화이므로 핸들을 비워 이후 clear가 이미 소멸한 핸들을 건드리지 않게 한다.
    timer = null
    socket.close()
    opts.onExpire?.()
  }

  function rearm(): void {
    clear()
    timer = setTimeoutFn(expire, opts.deadlineMs)
  }

  return { rearm, clear }
}
