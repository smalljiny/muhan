import { describe, it, expect, vi } from 'vitest'
import { createDeadline, type DeadlineSocket } from './deadline.js'

// 데드라인은 순수 로직이라 fake socket + 주입한 fake clock으로 결정적으로 검증한다.
// heartbeat의 createFakeClock을 setTimeout/clearTimeout(단발) 버전으로 각색한다 —
// setTimeout은 발화 후 엔트리를 제거해 단발 의미를 지킨다(setInterval의 반복과 다름).

/** 주입용 결정적 fake clock. tick()이 등록된 단발 타이머를 발화하고 발화 후 엔트리를 제거한다. */
function createFakeClock() {
  interface Entry {
    id: number
    fn: () => void
  }
  let entries: Entry[] = []
  let nextId = 1
  const setTimeoutFn = ((fn: () => void) => {
    const id = nextId++
    entries = [...entries, { id, fn }]
    return id as unknown as NodeJS.Timeout
  }) as unknown as typeof setTimeout
  const clearTimeoutFn = ((handle: NodeJS.Timeout) => {
    entries = entries.filter((e) => e.id !== (handle as unknown as number))
  }) as unknown as typeof clearTimeout
  // 단발 타이머 발화: 현재 등록된 엔트리를 모두 비운 뒤(발화 전 제거) 각 핸들러를 1회 호출한다.
  // 핸들러가 다시 setTimeout을 걸면(rearm) 그 엔트리는 남아 다음 tick에서 발화한다.
  function tick(): void {
    const due = entries
    entries = []
    for (const e of due) e.fn()
  }
  return { setTimeoutFn, clearTimeoutFn, tick }
}

function createFakeSocket(): DeadlineSocket & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() }
}

/** 표준 셋업(데드라인 1000ms, 주입 fake clock). */
function makeDeadline(onExpire?: () => void) {
  const clock = createFakeClock()
  const socket = createFakeSocket()
  const deadline = createDeadline(socket, {
    deadlineMs: 1000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onExpire,
  })
  return { deadline, socket, clock }
}

describe('createDeadline', () => {
  it('rearm(무장) 후 데드라인이 경과하면 소켓을 close한다', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    clock.tick()

    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('무장 후 clear하면 만료되지 않는다', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    deadline.clear()
    clock.tick()

    expect(socket.close).not.toHaveBeenCalled()
  })

  it('rearm은 이전 타이머를 취소하고 새로 무장한다 (rearm 직전까지 경과분 무시)', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    deadline.rearm() // 이전 타이머 취소 후 새 타이머 무장.
    clock.tick() // 새 타이머만 발화 — 이전 타이머는 취소됐으므로 close는 1회.

    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('rearm을 반복하면 각 tick마다 이전 타이머가 취소돼 close가 누적되지 않는다', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    deadline.rearm()
    deadline.rearm()
    clock.tick()

    // 매 rearm이 직전 타이머를 clear하므로 활성 타이머는 항상 1개다.
    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('만료 후 추가 tick은 close를 다시 부르지 않는다 (단발)', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    clock.tick()
    clock.tick()
    clock.tick()

    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('만료 시 onExpire 콜백을 호출한다', () => {
    const onExpire = vi.fn()
    const { deadline, clock } = makeDeadline(onExpire)

    deadline.rearm()
    clock.tick()

    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('clear는 idempotent하다 (무장 없이 여러 번 호출해도 안전)', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.clear()
    deadline.clear()
    clock.tick()

    expect(socket.close).not.toHaveBeenCalled()
  })

  it('onExpire 미주입 시에도 만료가 close만 부르고 throw하지 않는다', () => {
    const { deadline, socket, clock } = makeDeadline()

    deadline.rearm()
    expect(() => clock.tick()).not.toThrow()
    expect(socket.close).toHaveBeenCalledTimes(1)
  })
})
