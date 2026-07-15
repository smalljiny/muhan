import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock, type WorldTickSlot } from './worldClock.js'

// 호출된 tickSec를 기록하는 fake 슬롯. 실 슬롯(게임시간·크리처 큐 등)은 붙이지 않는다.
function makeSlot(
  name: string,
  intervalSec: number,
  run: (tickSec: number) => void = () => undefined,
): { slot: WorldTickSlot; calls: number[] } {
  const calls: number[] = []
  const slot: WorldTickSlot = {
    name,
    intervalSec,
    run(tickSec: number): void {
      calls.push(tickSec)
      run(tickSec)
    },
  }
  return { slot, calls }
}

describe('WorldClock', () => {
  it('1Hz interval을 1000ms로 arm한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    world.start()
    expect(clock.lastMs).toBe(1000)
    expect(clock.activeCount).toBe(1)
  })

  it('intervalSec=1 슬롯을 매 tick마다 호출한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, calls } = makeSlot('every', 1)
    world.register(slot)
    world.start()

    clock.tick(3)

    expect(calls).toEqual([1, 2, 3])
  })

  it('intervalSec=N 슬롯을 tickSec % N === 0인 틱에만 호출한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, calls } = makeSlot('every3', 3)
    world.register(slot)
    world.start()

    clock.tick(6)

    expect(calls).toEqual([3, 6])
  })

  it('한 슬롯의 throw를 격리·로깅하고 나머지 슬롯을 계속 호출한다', () => {
    const clock = new FakeClock()
    const logger = { error: vi.fn() }
    const world = new WorldClock({ clock, logger })

    // throw 슬롯을 먼저 등록해 순회 중단이 없음을 증명한다(순서 load-bearing).
    const { slot: boom } = makeSlot('boom', 1, () => {
      throw new Error('slot exploded')
    })
    const { slot: ok, calls: okCalls } = makeSlot('ok', 1)
    world.register(boom)
    world.register(ok)
    world.start()

    clock.tick(1)

    expect(okCalls).toEqual([1])
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'boom' }),
      expect.any(String),
    )
  })

  it('register가 반환한 해제 함수 호출 후 그 슬롯을 더는 호출하지 않는다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, calls } = makeSlot('every', 1)
    const unregister = world.register(slot)
    world.start()

    clock.tick(1)
    unregister()
    clock.tick(2)

    expect(calls).toEqual([1])
  })

  it('해제는 그 슬롯만 제거하고 다른 슬롯에 영향을 주지 않는다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot: a, calls: aCalls } = makeSlot('a', 1)
    const { slot: b, calls: bCalls } = makeSlot('b', 1)
    const unregisterA = world.register(a)
    world.register(b)
    world.start()

    unregisterA()
    clock.tick(1)

    expect(aCalls).toEqual([])
    expect(bCalls).toEqual([1])
  })

  it('start() 중복 호출 시 interval을 한 번만 arm한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    world.start()
    world.start()
    expect(clock.activeCount).toBe(1)
  })

  it('stop() 후 running === false이고 activeCount === 0이다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    world.start()
    expect(world.running).toBe(true)

    world.stop()

    expect(world.running).toBe(false)
    expect(clock.activeCount).toBe(0)
  })

  it('stop()은 정지 상태에서 호출해도 안전한 no-op이다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    expect(() => world.stop()).not.toThrow()
    expect(world.running).toBe(false)
  })

  it('currentTick()는 단조 tick 카운터를 노출한다(슬롯 now 소스)', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    expect(world.currentTick()).toBe(0)
    world.start()
    clock.tick(3)
    expect(world.currentTick()).toBe(3)
  })
})
