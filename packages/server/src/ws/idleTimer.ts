import type { IdleTimer } from './connection.js'

/**
 * per-connection 무입력(idle) 타이머 매니저 — 월드 진입(command) 후 유효 명령이 없는 연결을 감시한다.
 *
 * 단발 setTimeout 모델(deadline.ts 관례 미러): `arm`이 idle 타이머를 clear한 뒤 새로 설정하고(첫 설정·
 * 재-arm 모두 동일 = rearm 의미), `idleMs` 안에 유효 명령 처리(dispatch handled)가 없으면 타이머가 발화해
 * 주입 `onExpire`를 호출한다. `clear`는 idempotent 해제다.
 *
 * deadline과 결정적으로 다른 점: **소켓을 만지지 않는다.** deadline은 만료 시 socket.close로 직접 종결하지만,
 * idle의 종결은 3층 경계상 셸(resolveDisconnect)이 소유한다 — 그래서 만료 시 socket.close가 아니라 주입
 * `onExpire`(캡처한 바인딩으로 resolveDisconnect(idleTimeout)를 호출)로 종결을 위임한다. 타이머는 주입
 * 가능(`setTimeoutFn`/`clearTimeoutFn`)이라 fake clock으로 결정적 단위 테스트가 되고, 미주입 시 전역 타이머를 쓴다.
 */

/** idle 튜닝 + 타이머 주입 옵션. 타이머 미주입 시 전역 setTimeout/clearTimeout을 쓴다(deadline.ts 관례 미러). */
export interface IdleTimerOptions {
  /** 무입력 종료 창(ms). env WS_IDLE_TIMEOUT_MS를 지연 조회한 값이 배선된다(하드코딩 금지). */
  readonly idleMs: number
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
  /** 만료 시 종결 위임 콜백. resolveDisconnect(binding, 'idleTimeout')을 감싸 배선된다. */
  readonly onExpire?: () => void
}

/**
 * idle 타이머 매니저를 만든다. 상태(현재 타이머 핸들)는 클로저에 캡슐화한다(createDeadline 관례 미러).
 *
 * `arm`은 기존 타이머를 clear한 뒤 새 setTimeout을 설정한다(첫 설정·재-arm 모두 동일 동작). 만료 시
 * 핸들을 비운 뒤 `onExpire?.()`를 호출한다 — socket.close는 하지 않는다(종결은 셸이 위임받아 수행).
 */
export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
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
    // 단발 발화이므로 핸들을 먼저 비워 이후 clear(중복 정리)가 소멸한 핸들을 건드리지 않게 한다.
    timer = null
    opts.onExpire?.()
  }

  function arm(): void {
    clear()
    timer = setTimeoutFn(expire, opts.idleMs)
  }

  return { arm, clear }
}
