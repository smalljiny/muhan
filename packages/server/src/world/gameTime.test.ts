import { describe, it, expect } from 'vitest'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock } from './worldClock.js'
import { createGameTime } from './gameTime.js'

/**
 * 게임시각 진행 슬롯 검증. WorldClock(1Hz) 위에 intervalSec=150 슬롯을 얹어 150 실초마다
 * Time += 1이 굴러가는지, currentHour()가 Time % 24를 반영하는지 결정적으로 확인한다.
 * FakeClock 주입으로 실타이머 없이 tick을 수동 구동한다.
 */
describe('createGameTime', () => {
  it('슬롯 intervalSec가 150이고 name을 갖는다', () => {
    const { slot } = createGameTime()
    expect(slot.intervalSec).toBe(150)
    expect(slot.name).toBeTruthy()
  })

  it('초기 Time은 기본 0이라 currentHour()가 0이다', () => {
    const { currentHour } = createGameTime()
    expect(currentHour()).toBe(0)
  })

  it('초기 Time을 주입할 수 있다', () => {
    const { currentHour } = createGameTime({ initialTime: 5 })
    expect(currentHour()).toBe(5)
  })

  it('WorldClock+FakeClock에서 150틱 경과 시 Time이 정확히 1 증가한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, currentHour } = createGameTime()
    world.register(slot)
    world.start()

    // tickSec 1→150 진행. 150 % 150 === 0인 마지막 틱에서만 슬롯이 1회 발화한다.
    clock.tick(150)

    expect(currentHour()).toBe(1)
  })

  it('150틱 미만에서는 슬롯이 발화하지 않아 currentHour()가 그대로다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, currentHour } = createGameTime()
    world.register(slot)
    world.start()

    clock.tick(149)

    expect(currentHour()).toBe(0)
  })

  it('300틱 경과 시 슬롯이 2회 발화해 Time이 2 증가한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, currentHour } = createGameTime()
    world.register(slot)
    world.start()

    clock.tick(300)

    expect(currentHour()).toBe(2)
  })

  it('currentHour()는 Time % 24를 반환한다(24 경계 wrap)', () => {
    // 초기 Time=23에서 1회 발화하면 Time=24 → currentHour()는 0으로 wrap.
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const { slot, currentHour } = createGameTime({ initialTime: 23 })
    world.register(slot)
    world.start()

    clock.tick(150)

    expect(currentHour()).toBe(0)
  })

  it('초기 Time=25는 발화 없이도 currentHour()가 1이다(modulo 상시 적용)', () => {
    const { currentHour } = createGameTime({ initialTime: 25 })
    expect(currentHour()).toBe(1)
  })
})
