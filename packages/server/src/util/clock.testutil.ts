/**
 * 수동 구동 FakeClock — SchedulerClock 테스트 더블의 단일 출처.
 *
 * setInterval으로 등록된 콜백을 tick()으로 직접 발사한다. 실타이머를 쓰지 않아 완전히
 * 결정적이며, 테스트가 간격 경과를 명시적으로 구동한다(비결정적 대기 제거). SchedulerClock
 * 소비자 테스트가 인라인 중복 없이 공유한다(현재 save 패키지 테스트, 이후 heartbeat·WorldClock으로 확대).
 */

import type { IntervalHandle, SchedulerClock } from './clock.js'

export class FakeClock implements SchedulerClock {
  private readonly handlers = new Map<IntervalHandle, () => void>()
  private nextId = 1
  /** 마지막으로 setInterval에 전달된 간격(ms) — 간격 검증용. */
  public lastMs: number | null = null

  setInterval(callback: () => void, ms: number): IntervalHandle {
    this.lastMs = ms
    const handle = this.nextId++ as unknown as IntervalHandle
    this.handlers.set(handle, callback)
    return handle
  }

  clearInterval(handle: IntervalHandle): void {
    this.handlers.delete(handle)
  }

  /**
   * 등록된 모든 interval 콜백을 times회 발사한다(간격 경과 시뮬레이션).
   * times 미지정 시 1회 발사한다(기존 무인자 tick() 호환).
   */
  tick(times = 1): void {
    for (let i = 0; i < times; i++) {
      for (const cb of this.handlers.values()) cb()
    }
  }

  /** 현재 등록된 활성 interval 개수. */
  get activeCount(): number {
    return this.handlers.size
  }
}
