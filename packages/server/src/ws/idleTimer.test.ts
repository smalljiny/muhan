import { describe, it, expect, vi } from 'vitest'
import { createIdleTimer } from './idleTimer.js'

// idleTimer는 순수 로직이라 주입한 fake clock으로 결정적으로 검증한다(deadline.test.ts 관례 미러).
// deadline과 달리 소켓을 만지지 않는다 — 만료 시 종결은 주입 onExpire(resolveDisconnect 위임)로만 한다.

/** 주입용 결정적 fake clock. tick()이 등록된 단발 타이머를 발화하고 발화 후 엔트리를 제거한다. */
function createFakeClock() {
  interface Entry {
    id: number
    fn: () => void
    delay: number
  }
  let entries: Entry[] = []
  let nextId = 1
  const setTimeoutFn = ((fn: () => void, delay: number) => {
    const id = nextId++
    entries = [...entries, { id, fn, delay }]
    return id as unknown as NodeJS.Timeout
  }) as unknown as typeof setTimeout
  const clearTimeoutFn = ((handle: NodeJS.Timeout) => {
    entries = entries.filter((e) => e.id !== (handle as unknown as number))
  }) as unknown as typeof clearTimeout
  // 단발 발화: 현재 등록된 엔트리를 모두 비운 뒤 각 핸들러를 1회 호출한다(재-arm은 다음 tick에서 발화).
  function tick(): void {
    const due = entries
    entries = []
    for (const e of due) e.fn()
  }
  // 마지막으로 설정된 타이머의 delay를 돌려준다(arm 지연값 검증용).
  function lastDelay(): number | undefined {
    return entries[entries.length - 1]?.delay
  }
  return { setTimeoutFn, clearTimeoutFn, tick, lastDelay }
}

/** 표준 셋업(idle 1000ms, 주입 fake clock). */
function makeIdle(onExpire?: () => void) {
  const clock = createFakeClock()
  const idle = createIdleTimer({
    idleMs: 1000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onExpire,
  })
  return { idle, clock }
}

describe('createIdleTimer', () => {
  it('arm(설정) 후 idle이 경과하면 onExpire를 호출한다', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.arm()
    clock.tick()

    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('arm은 idleMs를 지연값으로 타이머를 설정한다', () => {
    const { idle, clock } = makeIdle()

    idle.arm()

    // 설정된 타이머의 지연이 주입 idleMs(1000)와 일치한다(하드코딩 없음 — 팩토리가 옵션값을 소비).
    expect(clock.lastDelay()).toBe(1000)
  })

  it('설정 후 clear하면 만료되지 않는다', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.arm()
    idle.clear()
    clock.tick()

    expect(onExpire).not.toHaveBeenCalled()
  })

  it('arm은 이전 타이머를 취소하고 새로 설정한다 (재-arm 시 직전 경과분 무시)', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.arm()
    idle.arm() // 이전 타이머 취소 후 새 타이머 설정(clear-then-set = rearm 의미).
    clock.tick() // 새 타이머만 발화 — 이전 타이머는 취소됐으므로 onExpire는 1회.

    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('arm을 반복(flood)하면 각 tick마다 이전 타이머가 취소돼 만료가 누적되지 않는다', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.arm()
    idle.arm()
    idle.arm()
    clock.tick()

    // 매 arm이 직전 타이머를 clear하므로 활성 타이머는 항상 1개다.
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('만료 후 추가 tick은 onExpire를 다시 부르지 않는다 (단발)', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.arm()
    clock.tick()
    clock.tick()
    clock.tick()

    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('clear는 idempotent하다 (설정 없이 여러 번 호출해도 안전)', () => {
    const onExpire = vi.fn()
    const { idle, clock } = makeIdle(onExpire)

    idle.clear()
    idle.clear()
    clock.tick()

    expect(onExpire).not.toHaveBeenCalled()
  })

  it('onExpire 미주입 시에도 만료가 throw하지 않는다', () => {
    const { idle, clock } = makeIdle()

    idle.arm()
    expect(() => clock.tick()).not.toThrow()
  })

  it('setTimeoutFn/clearTimeoutFn 미주입 시 전역 타이머로 동작한다', () => {
    // 소켓 의존이 없음을 확인 — 전역 타이머만으로 arm/clear가 throw 없이 성립한다.
    const idle = createIdleTimer({ idleMs: 1000, onExpire: vi.fn() })
    expect(() => {
      idle.arm()
      idle.clear()
    }).not.toThrow()
  })
})
