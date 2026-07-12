/**
 * 주기 flush 스케줄러 — DirtyTracker와 AsyncWriteQueue를 잇는 저장 정책 엔진.
 *
 * 게임 루프가 markDirty로 DirtyTracker에 쌓아 둔 변경 스냅샷을, 주입된 clock의 주기 tick
 * (기본 120초)마다 한 번에 drain해 AsyncWriteQueue로 흘려보낸다. 게임 틱과 영속화 write를
 * 분리하는 write-behind 파이프라인의 스케줄 층이다.
 *
 * clock seam:
 *   setInterval/clearInterval을 직접 부르지 않고 주입된 SchedulerClock을 통해 호출한다.
 *   SchedulerClock·IntervalHandle·defaultClock 정의는 ../util/clock.js가 단일 출처이며
 *   (save·heartbeat·WorldClock 공유), 여기서는 back-compat용으로 재-export만 한다. 기본값은
 *   전역 setInterval/clearInterval을 위임하는 defaultClock이다. 이 seam으로 (a) 테스트에서
 *   FakeClock을 주입해 tick을 수동 구동하고(비결정적 실타이머 대기 제거), (b) heartbeat
 *   스케줄러로 clock을 교체할 수 있다. 전역 싱글턴을 쓰지 않고 의존성을 모두 생성자로 주입해
 *   인스턴스 격리를 보장한다.
 *
 * flush 절차:
 *   (1) DirtyTracker.drain()으로 이미 coalesce된(키당 최신 1건) 항목 배열을 얻는다.
 *   (2) 배열을 순회하며 AsyncWriteQueue.enqueue를 **동기 burst**로 호출한다 — 각 enqueue
 *       사이에 await로 yield하지 않고 반환된 Promise를 수집한 뒤 마지막에 Promise.all로
 *       완료를 기다린다. AsyncWriteQueue 소비자 계약("coalescing은 동기 burst에서만 성립")을
 *       지키기 위함이다. drain 결과가 0건이면 enqueue를 한 번도 부르지 않는 no-op이다.
 *
 * re-entrancy:
 *   enqueue는 backpressure로 block할 수 있어 flush가 여러 tick에 걸쳐 진행될 수 있다.
 *   flushing 플래그로 이전 flush 진행 중 다음 tick의 flush 시작을 건너뛴다. drain()은
 *   파괴적·원자적이라 두 flush가 겹쳐도 서로소 집합을 drain하므로 write 정합성은 항상
 *   유지된다 — 플래그는 장기 backpressure 시 대기 flush가 쌓이는 것을 막는 방어다.
 *
 *   불변식: re-entrancy flushing 플래그는 **interval(onTick) 경로만** 보호한다. 직접 flush()
 *   호출(SaveEngine.shutdown이 사용)은 항상 허용되며 플래그를 확인·설정하지 않는다. 정합성은
 *   DirtyTracker.drain()의 원자적·파괴적 특성에 근거한다 — 동시 flush는 서로소 집합을 drain하므로
 *   interval flush와 shutdown flush가 겹쳐도 같은 항목을 이중 write하지 않는다. Story 5 SaveEngine은
 *   이 계약에 의도적으로 의존한다(진행 중 tick flush와 무관하게 shutdown이 즉시 잔여분을 flush).
 *
 * Open Q 1 (interval-only):
 *   flush 트리거는 시간 간격만 사용한다. dirty 건수 임계값 기반 병행 트리거는 두지 않는다.
 */

import type { DirtyEntry } from './dirtyTracker.js'
import type { SaveLogger } from './logger.js'
import { NOOP_LOGGER } from './logger.js'
import { defaultClock, type SchedulerClock, type IntervalHandle } from '../util/clock.js'

/** 타이머 seam back-compat 재-export — saveEngine의 기존 `from './saveScheduler.js'` import를 유지한다. */
export type { SchedulerClock, IntervalHandle } from '../util/clock.js'

/** 기본 flush 간격(ms) — 120초. 생성자 옵션으로 override 가능하다. */
export const DEFAULT_INTERVAL_MS = 120_000

/** DirtyTracker 의존성의 최소 계약(구조적 주입 — 테스트 mock 허용). */
export interface DirtyDrainSource {
  drain(): readonly DirtyEntry[]
  readonly size: number
}

/** AsyncWriteQueue 의존성의 최소 계약(구조적 주입 — 테스트 mock 허용). */
export interface WriteEnqueue {
  enqueue(job: DirtyEntry): Promise<void>
}

/** SaveScheduler 생성 옵션. */
export interface SaveSchedulerOptions {
  /** flush 간격 ms(기본 DEFAULT_INTERVAL_MS). */
  readonly intervalMs?: number
  /** tick seam(기본 defaultClock — 전역 setInterval/clearInterval). */
  readonly clock?: SchedulerClock
  /** flush 에러 logger(기본 NOOP_LOGGER). */
  readonly logger?: SaveLogger
}

export class SaveScheduler {
  private readonly tracker: DirtyDrainSource
  private readonly queue: WriteEnqueue
  private readonly intervalMs: number
  private readonly clock: SchedulerClock
  private readonly logger: SaveLogger

  /** 활성 interval 핸들(정지 상태면 null). */
  private handle: IntervalHandle | null = null
  /** flush 진행 중 여부(re-entrancy 방어). */
  private flushing = false

  constructor(
    tracker: DirtyDrainSource,
    queue: WriteEnqueue,
    options: SaveSchedulerOptions = {},
  ) {
    this.tracker = tracker
    this.queue = queue
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.clock = options.clock ?? defaultClock
    this.logger = options.logger ?? NOOP_LOGGER
  }

  /** 실행 중이면 true(테스트·검사용). */
  get running(): boolean {
    return this.handle !== null
  }

  /**
   * DirtyTracker를 drain해 각 항목을 AsyncWriteQueue로 동기 burst enqueue한다.
   * 빈 배치는 no-op(enqueue 호출 없음). enqueue backpressure 완료까지 await한다.
   */
  async flush(): Promise<void> {
    const entries = this.tracker.drain()
    if (entries.length === 0) return
    // 동기 burst — map은 각 enqueue 사이에 await로 yield하지 않고 동기 순회하므로 첫 await
    // 전에 모든 enqueue가 발사된다. AsyncWriteQueue의 "coalescing은 동기 burst에서만 성립"
    // 계약을 지킨다. drain 소스가 collection:id로 이미 coalesce돼 한 배치에 동일 키가 없어
    // 이 계약은 vacuously 성립하지만, 다른 drain 소스로 교체돼도 안전하도록 유지한다.
    await Promise.all(entries.map((entry) => this.queue.enqueue(entry)))
  }

  /** interval을 걸어 주기적으로 flush한다. 이미 실행 중이면 재-arm하지 않는다. */
  start(): void {
    if (this.handle !== null) return
    this.handle = this.clock.setInterval(() => {
      // onTick은 flush rejection을 catch해 logger로 기록하지만, 그 logger.error 자체가 throw하면
      // 예외가 onTick을 탈출한다. 여기서 .catch로 최후 방어해 백그라운드 tick 경로의 unhandled
      // rejection을 막는다(장수 서버 크래시 방지). logger가 이미 throw한 상황이라 재기록할 안전한
      // 곳이 없으므로 형제 asyncWriteQueue.work()의 관례를 따라 조용히 삼킨다.
      void this.onTick().catch(() => {})
    }, this.intervalMs)
  }

  /** interval을 해제한다. 이후 tick은 더 이상 flush를 트리거하지 않는다. */
  stop(): void {
    if (this.handle === null) return
    this.clock.clearInterval(this.handle)
    this.handle = null
  }

  /**
   * interval 콜백. re-entrancy 플래그로 이전 flush 진행 중 중복 실행을 막고, flush의
   * rejection을 삼켜 async 콜백의 unhandled rejection을 방지한다(logger로 기록).
   */
  private async onTick(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await this.flush()
    } catch (error) {
      this.logger.error({ err: error }, '주기 flush 실패')
    } finally {
      this.flushing = false
    }
  }
}
