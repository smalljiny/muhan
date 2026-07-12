import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from './clock.testutil.js'

/**
 * 공유 FakeClock의 계약 검증 — save·heartbeat 테스트가 이 더블에 의존하므로 노출 표면
 * (tick·activeCount·lastMs·clearInterval)의 동작을 단위로 고정한다.
 */
describe('FakeClock', () => {
  it('setInterval은 lastMs를 기록하고 activeCount를 증가시킨다', () => {
    const clock = new FakeClock()
    expect(clock.lastMs).toBeNull()
    expect(clock.activeCount).toBe(0)

    clock.setInterval(() => undefined, 5_000)

    expect(clock.lastMs).toBe(5_000)
    expect(clock.activeCount).toBe(1)
  })

  it('tick()은 등록된 모든 콜백을 1회 발사한다', () => {
    const clock = new FakeClock()
    const a = vi.fn()
    const b = vi.fn()
    clock.setInterval(a, 1_000)
    clock.setInterval(b, 1_000)

    clock.tick()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('tick(times)는 콜백을 times회 반복 발사한다', () => {
    const clock = new FakeClock()
    const cb = vi.fn()
    clock.setInterval(cb, 1_000)

    clock.tick(3)

    expect(cb).toHaveBeenCalledTimes(3)
  })

  it('clearInterval 이후에는 tick이 해당 콜백을 발사하지 않는다', () => {
    const clock = new FakeClock()
    const cb = vi.fn()
    const handle = clock.setInterval(cb, 1_000)

    clock.clearInterval(handle)
    clock.tick()

    expect(cb).not.toHaveBeenCalled()
    expect(clock.activeCount).toBe(0)
  })

  it('콜백이 없어도 tick은 안전한 no-op이다', () => {
    const clock = new FakeClock()
    expect(() => clock.tick()).not.toThrow()
  })
})
