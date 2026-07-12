/**
 * 타이머 seam 단일 출처 — setInterval/clearInterval 주입 계약을 한 곳에 모은다.
 *
 * saveScheduler·heartbeat·WorldClock 등 주기 콜백을 거는 컴포넌트가 전역 setInterval/
 * clearInterval을 직접 부르지 않고 이 모듈의 SchedulerClock을 통해 호출한다. 이 seam으로
 * (a) 테스트에서 FakeClock을 주입해 tick을 수동 구동하고(비결정적 실타이머 대기 제거),
 * (b) 서로 다른 스케줄러가 clock 구현을 교체·공유할 수 있다. 전역 싱글턴을 쓰지 않고 의존성을
 * 생성자로 주입해 인스턴스 격리를 보장한다.
 *
 * 기본값 defaultClock은 전역 setInterval/clearInterval에 그대로 위임한다(동작 불변).
 */

/** clock이 반환하는 불투명 interval 핸들. */
export type IntervalHandle = ReturnType<typeof setInterval>

/**
 * 주기 tick seam. setInterval/clearInterval의 최소 계약만 노출해 테스트 FakeClock·
 * 다른 스케줄러 구현으로 교체 가능하게 한다.
 */
export interface SchedulerClock {
  setInterval(callback: () => void, ms: number): IntervalHandle
  clearInterval(handle: IntervalHandle): void
}

/** 전역 setInterval/clearInterval에 위임하는 기본 clock. */
export const defaultClock: SchedulerClock = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
}
