/**
 * 1Hz 단일 월드 틱 소스 — 게임 전역 케이던스의 단일 출처.
 *
 * 서버 전체가 개별 setInterval을 흩뿌리지 않고 이 WorldClock 하나가 1초 케이던스로 단조 tick
 * 카운터를 굴린다. 등록된 각 슬롯은 자신의 intervalSec를 선언하고, WorldClock은 modulo 게이트
 * (`tickSec % intervalSec === 0`)로 해당 슬롯의 발화 시점만 걸러 호출한다. 즉 서로 다른 주기
 * (매초·N초)의 주기 작업을 하나의 단조 tick 위에 얹는 프레임워크다.
 *
 * 슬롯 격리: 한 슬롯의 run이 throw해도 try/catch로 잡아 logger로 기록하고 다음 슬롯을 계속
 * 호출한다. 한 슬롯의 실패가 틱 전체나 형제 슬롯을 죽이지 않는다.
 *
 * 이 모듈은 순수 프레임워크다(YAGNI). 실 슬롯(게임시간 진행·크리처 행동 큐·출구 타이머 등)은
 * 붙이지 않으며 후속 토픽에서 register로 연결한다. 현재는 단위 테스트가 등록하는 fake 슬롯으로만
 * 검증한다.
 *
 * clock seam: 전역 setInterval/clearInterval을 직접 부르지 않고 주입된 SchedulerClock을 통해
 * 호출한다(../util/clock.js 단일 출처). 테스트는 FakeClock을 주입해 tick을 수동 구동한다.
 */

import { defaultClock, type SchedulerClock, type IntervalHandle } from '../util/clock.js'

/**
 * 월드 틱에 얹히는 주기 작업 슬롯. intervalSec마다(정확히는 tickSec % intervalSec === 0인 틱)
 * run이 현재 tickSec와 함께 호출된다.
 */
export interface WorldTickSlot {
  readonly name: string
  readonly intervalSec: number
  run(tickSec: number): void
}

/** 슬롯 실패를 기록하는 최소 logger seam(console 금지 — save/logger.ts 관례 미러). */
export interface WorldTickLogger {
  error(ctx: Record<string, unknown>, msg: string): void
}

/** 아무것도 하지 않는 logger. 생성자 기본값·조용한 방어용으로만 노출한다. */
const NOOP_WORLD_TICK_LOGGER: WorldTickLogger = { error: () => undefined }

/** WorldClock 생성 옵션. */
export interface WorldClockOptions {
  /** tick seam(기본 defaultClock — 전역 setInterval/clearInterval). */
  readonly clock?: SchedulerClock
  /** 슬롯 실패 logger(기본 NOOP_WORLD_TICK_LOGGER). */
  readonly logger?: WorldTickLogger
}

export class WorldClock {
  private readonly clock: SchedulerClock
  private readonly logger: WorldTickLogger
  private readonly slots = new Set<WorldTickSlot>()

  /** 활성 interval 핸들(정지 상태면 null). */
  private handle: IntervalHandle | null = null
  /** 단조 tick 카운터(초). onTick에서 호출 전 pre-increment → 첫 tick=1. */
  private tickCounter = 0

  constructor(options: WorldClockOptions = {}) {
    this.clock = options.clock ?? defaultClock
    this.logger = options.logger ?? NOOP_WORLD_TICK_LOGGER
  }

  /** 실행 중이면 true(테스트·검사용). */
  get running(): boolean {
    return this.handle !== null
  }

  /**
   * 슬롯을 등록하고 해제 함수를 반환한다. 해제 함수는 그 슬롯만 제거하며(다른 슬롯 무영향)
   * 여러 번 호출해도 안전하다.
   */
  register(slot: WorldTickSlot): () => void {
    this.slots.add(slot)
    return () => {
      this.slots.delete(slot)
    }
  }

  /** 1Hz interval을 건다. 이미 arm돼 있으면 재-arm하지 않는다. */
  start(): void {
    if (this.handle !== null) return
    this.handle = this.clock.setInterval(() => this.onTick(), 1000)
  }

  /** interval을 해제한다. 정지 상태에서 호출해도 안전한 no-op이다. */
  stop(): void {
    if (this.handle === null) return
    this.clock.clearInterval(this.handle)
    this.handle = null
  }

  /**
   * interval 콜백. 단조 tick 카운터를 pre-increment로 올리고, modulo 게이트를 통과한 슬롯만
   * run한다. 슬롯 컬렉션은 순회 중 해제에 안전하도록 스냅샷([...slots])을 떠 순회하며, 각 run의
   * throw를 catch해 logger로 기록하고 다음 슬롯을 계속 호출한다(격리).
   */
  private onTick(): void {
    const tickSec = ++this.tickCounter
    for (const slot of [...this.slots]) {
      if (tickSec % slot.intervalSec !== 0) continue
      try {
        slot.run(tickSec)
      } catch (err) {
        this.logger.error({ slot: slot.name, err }, '월드 틱 슬롯 실행 실패')
      }
    }
  }
}
