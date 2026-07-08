/**
 * 서버 주도 하트비트 매니저 — per-connection 인스턴스로 소켓 생존을 감시한다.
 *
 * 단일 인터벌(isAlive) 모델: `pingIntervalMs`마다 tick이 돌며 직전 라운드의 pong 미수신을 센다.
 * 연속 미수신이 `maxMissed`에 도달하면 소켓을 `terminate`하고 정지한다. pong 수신은 `notePong()`으로
 * 알리며 미스 카운터를 리셋한다. 타이머는 주입 가능(`setIntervalFn`/`clearIntervalFn`)이라 fake clock으로
 * 결정적 단위 테스트가 가능하고, 미주입 시 전역 타이머를 쓴다.
 */

/** 매니저가 의존하는 소켓 표면. 실 ws.WebSocket이 구조적으로 충족한다. */
export interface HeartbeatSocket {
  ping(): void
  terminate(): void
}

/** 하트비트 튜닝 + 타이머 주입 옵션. 타이머 미주입 시 전역 setInterval/clearInterval을 쓴다. */
export interface HeartbeatOptions {
  readonly pingIntervalMs: number
  readonly maxMissed: number
  readonly setIntervalFn?: typeof setInterval
  readonly clearIntervalFn?: typeof clearInterval
}

/** per-connection 하트비트 핸들. `start`가 타이머 핸들을 돌려줘 `ctx.heartbeat`에 배선한다. */
export interface Heartbeat {
  start(): NodeJS.Timeout
  stop(): void
  notePong(): void
}

/**
 * 하트비트 매니저를 만든다. 상태(미스 카운트·pong 대기 여부·타이머 핸들)는 클로저에 캡슐화한다.
 */
export function createHeartbeat(socket: HeartbeatSocket, opts: HeartbeatOptions): Heartbeat {
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval

  let timer: NodeJS.Timeout | null = null
  let missedPongs = 0
  // 직전 tick에서 ping을 보낸 뒤 아직 pong을 못 받은 상태인지. 다음 tick에서 미스 판정 근거가 된다.
  let awaitingPong = false

  function stop(): void {
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
  }

  function tick(): void {
    if (awaitingPong) {
      // 직전 ping에 대한 pong이 이번 tick까지 안 왔다 — 미스 1회 누적.
      missedPongs += 1
      if (missedPongs >= opts.maxMissed) {
        socket.terminate()
        stop()
        return
      }
    }
    awaitingPong = true
    socket.ping()
  }

  function start(): NodeJS.Timeout {
    missedPongs = 0
    awaitingPong = false
    timer = setIntervalFn(tick, opts.pingIntervalMs)
    return timer
  }

  function notePong(): void {
    missedPongs = 0
    awaitingPong = false
  }

  return { start, stop, notePong }
}
