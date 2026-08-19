import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DirtyEntry } from './dirtyTracker.js'
import { DirtyTracker } from './dirtyTracker.js'
import { AsyncWriteQueue, type WriteAdapter, type WriteOutcome } from './asyncWriteQueue.js'
import { NOOP_LOGGER } from './logger.js'
import { DocumentNotFoundError } from '../repo/types.js'
import {
  SaveScheduler,
  DEFAULT_INTERVAL_MS,
  type WriteEnqueue,
} from './saveScheduler.js'
import { FakeClock } from '../util/clock.testutil.js'

/** enqueue 호출을 기록하는 mock write 큐. */
function mockQueue(): { queue: WriteEnqueue; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn<(job: DirtyEntry) => Promise<void>>(() => Promise.resolve())
  return { queue: { enqueue }, enqueue }
}

describe('SaveScheduler', () => {
  let clock: FakeClock

  beforeEach(() => {
    clock = new FakeClock()
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  describe('T4.1 — 간격 상수·주입', () => {
    it('DEFAULT_INTERVAL_MS는 120초(120_000ms)다', () => {
      expect(DEFAULT_INTERVAL_MS).toBe(120_000)
    })

    it('간격을 지정하지 않으면 start 시 clock.setInterval을 120_000ms로 건다', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      scheduler.start()

      expect(clock.lastMs).toBe(120_000)
    })

    it('생성자 옵션으로 간격을 override할 수 있다(Open Q 1: interval-only)', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock, intervalMs: 5_000 })

      scheduler.start()

      expect(clock.lastMs).toBe(5_000)
    })
  })

  describe('T4.2 — flush 동작', () => {
    it('간격 경과(tick) 시 DirtyTracker를 checkout해 각 항목을 enqueue한다', () => {
      const tracker = new DirtyTracker()
      const { queue, enqueue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })
      tracker.markDirty('characters', 'c1', { gold: 10 })
      tracker.markDirty('roomStates', 'r42', { open: true })

      scheduler.start()
      clock.tick()

      expect(enqueue).toHaveBeenCalledTimes(2)
      expect(enqueue).toHaveBeenCalledWith({ collection: 'characters', id: 'c1', snapshot: { gold: 10 } })
      expect(enqueue).toHaveBeenCalledWith({ collection: 'roomStates', id: 'r42', snapshot: { open: true } })
    })

    it('flush 후 DirtyTracker.size는 0이 된다', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })
      tracker.markDirty('characters', 'c1', { gold: 10 })

      scheduler.start()
      clock.tick()

      expect(tracker.size).toBe(0)
    })

    it('빈 배치(checkout 0건)는 no-op이라 enqueue를 호출하지 않는다', () => {
      const tracker = new DirtyTracker()
      const { queue, enqueue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      scheduler.start()
      clock.tick() // 첫 tick: dirty 없음
      clock.tick() // 재flush도 빈 배치

      expect(enqueue).not.toHaveBeenCalled()
    })

    it('flush() 직접 호출도 checkout→enqueue 절차를 수행한다', async () => {
      const tracker = new DirtyTracker()
      const { queue, enqueue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })
      tracker.markDirty('characters', 'c1', { v: 1 })

      await scheduler.flush()

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(tracker.size).toBe(0)
    })
  })

  describe('T4.3 — start/stop 수명주기', () => {
    it('중복 start는 interval을 재-arm하지 않는다', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      scheduler.start()
      scheduler.start()

      expect(clock.activeCount).toBe(1)
      expect(scheduler.running).toBe(true)
    })

    it('stop() 후에는 tick이 더 이상 flush를 트리거하지 않는다', () => {
      const tracker = new DirtyTracker()
      const { queue, enqueue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      scheduler.start()
      scheduler.stop()
      expect(scheduler.running).toBe(false)

      tracker.markDirty('characters', 'c1', { v: 1 })
      clock.tick() // 정지 상태 — 등록된 콜백 없음

      expect(enqueue).not.toHaveBeenCalled()
      expect(tracker.size).toBe(1)
    })

    it('실행 중이 아닐 때 stop()은 안전한 no-op이다', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      expect(() => scheduler.stop()).not.toThrow()
      expect(scheduler.running).toBe(false)
    })
  })

  describe('re-entrancy 방어', () => {
    it('이전 flush가 backpressure로 진행 중이면 다음 tick의 flush를 건너뛴다', async () => {
      const tracker = new DirtyTracker()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const enqueue = vi.fn<(job: DirtyEntry) => Promise<void>>(() => gate)
      const scheduler = new SaveScheduler(tracker, { enqueue }, { clock })

      tracker.markDirty('characters', 'c1', { v: 1 })
      scheduler.start()
      clock.tick() // 첫 flush: enqueue가 gate에서 block

      tracker.markDirty('characters', 'c2', { v: 2 })
      clock.tick() // 두 번째 tick: 이전 flush 진행 중이라 건너뛴다

      // 첫 flush의 enqueue 1건만 발사됐고 c2는 tracker에 남아 있다
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(tracker.size).toBe(1)

      release()
      await Promise.resolve()
    })
  })

  describe('에러 방어', () => {
    it('enqueue가 reject해도 interval 콜백이 unhandled rejection 없이 정리되고 logger로 기록한다', async () => {
      const tracker = new DirtyTracker()
      const enqueue = vi.fn<(job: DirtyEntry) => Promise<void>>(() =>
        Promise.reject(new Error('enqueue 실패')),
      )
      const logger = { error: vi.fn() }
      const scheduler = new SaveScheduler(tracker, { enqueue }, { clock, logger })

      tracker.markDirty('characters', 'c1', { v: 1 })
      scheduler.start()
      clock.tick()

      // flush의 rejection이 onTick catch까지 전파될 때까지 microtask 큐를 비운다
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(logger.error).toHaveBeenCalledTimes(1)

      // 다음 tick에서 flushing 플래그가 풀려 다시 flush된다
      tracker.markDirty('characters', 'c2', { v: 2 })
      clock.tick()
      expect(enqueue).toHaveBeenCalledTimes(2)
    })

    it('logger.error 자체가 throw해도 interval 콜백이 unhandled rejection을 일으키지 않는다', async () => {
      const tracker = new DirtyTracker()
      const enqueue = vi.fn<(job: DirtyEntry) => Promise<void>>(() =>
        Promise.reject(new Error('enqueue 실패')),
      )
      // logger 자체가 throw — onTick catch 블록에서 예외가 재발생해 onTick을 탈출한다.
      const logger = {
        error: vi.fn(() => {
          throw new Error('logger 실패')
        }),
      }
      const scheduler = new SaveScheduler(tracker, { enqueue }, { clock, logger })

      // 관찰 대상을 직접 단언 — flushing 리셋 어서션으로는 이 버그를 못 잡는다(finally가 버그
      // 코드에서도 리셋). 호출부가 rejection 핸들러를 붙이지 않으면 여기서 spy가 호출된다.
      const spy = vi.fn()
      process.on('unhandledRejection', spy)
      try {
        tracker.markDirty('characters', 'c1', { v: 1 })
        scheduler.start()
        clock.tick()

        // microtask + macrotask 드레인 — unhandledRejection은 매크로태스크 경계에서 발사된다.
        await new Promise((resolve) => setTimeout(resolve, 0))
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(spy).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledTimes(1)
      } finally {
        process.removeListener('unhandledRejection', spy)
      }
    })
  })

  describe('T4.4 CC#5 — roomState end-to-end', () => {
    it('markDirty(roomStates) → 주기 flush → AsyncWriteQueue upsert 어댑터로 dispatch된다', async () => {
      const tracker = new DirtyTracker()
      const roomAdapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ roomStates: roomAdapter }, NOOP_LOGGER, {
        sleep: () => Promise.resolve(),
      })
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      tracker.markDirty('roomStates', 'r42', { open: true, mobs: [] })

      scheduler.start()
      clock.tick()
      // 큐 소진 대기(AsyncWriteQueue.drain)를 배리어로 사용 — 워커가 어댑터까지 dispatch 완료
      await queue.drain()

      expect(roomAdapter).toHaveBeenCalledTimes(1)
      expect(roomAdapter).toHaveBeenCalledWith('r42', { open: true, mobs: [] })
      expect(tracker.size).toBe(0)
    })

    it('동일 roomId를 여러 번 markDirty하면 coalescing되어 최종 스냅샷 1회만 upsert된다', async () => {
      const tracker = new DirtyTracker()
      const roomAdapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ roomStates: roomAdapter }, NOOP_LOGGER, {
        sleep: () => Promise.resolve(),
      })
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      tracker.markDirty('roomStates', 'r42', { hp: 1 })
      tracker.markDirty('roomStates', 'r42', { hp: 2 })
      tracker.markDirty('roomStates', 'r42', { hp: 3 })

      scheduler.start()
      clock.tick()
      await queue.drain()

      expect(roomAdapter).toHaveBeenCalledTimes(1)
      expect(roomAdapter).toHaveBeenCalledWith('r42', { hp: 3 })
    })
  })

  /**
   * 완료 프로토콜 왕복 — checkout → enqueue → write → ack/discard.
   *
   * SaveEngine이 하는 배선(onSettled → tracker.ack/discard)을 그대로 조립해, 스냅샷이 mark부터
   * write 종결까지 tracker 안에 **연속 존재**함을 구간별로 고정한다. flush가 checkout이 아니라
   * 파괴적 drain을 쓰면 큐에 넘어간 순간 스냅샷이 사라져 재접속 hydrate가 과거 문서를 읽는다(#124).
   */
  describe('완료 프로토콜 왕복 (checkout → write → ack/discard)', () => {
    interface Composed {
      tracker: DirtyTracker
      queue: AsyncWriteQueue
      scheduler: SaveScheduler
      settle: ReturnType<typeof vi.fn>
    }

    /** tracker·queue·scheduler를 프로덕션과 같은 형태로 조립한다(onSettled → ack/discard). */
    function compose(
      adapter: WriteAdapter,
      options: { logger?: { error: ReturnType<typeof vi.fn> }; onSettled?: (entry: DirtyEntry, outcome: WriteOutcome) => void } = {},
    ): Composed {
      const tracker = new DirtyTracker()
      const settle = vi.fn<(entry: DirtyEntry, outcome: WriteOutcome) => void>((entry, outcome) => {
        if (options.onSettled !== undefined) {
          options.onSettled(entry, outcome)
          return
        }
        if (outcome === 'acked') tracker.ack(entry)
        else tracker.discard(entry)
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, options.logger ?? NOOP_LOGGER, {
        sleep: () => Promise.resolve(),
        onSettled: (entry, outcome) => {
          settle(entry, outcome)
        },
      })
      const scheduler = new SaveScheduler(tracker, queue, { clock })
      return { tracker, queue, scheduler, settle }
    }

    /** 게이트로 write를 붙잡아 두는 어댑터 — in-flight 구간을 관찰한다. */
    function gatedAdapter(): { adapter: WriteAdapter; release: () => void } {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        adapter: async () => {
          await gate
        },
        release: () => {
          release()
        },
      }
    }

    it('flush는 checkout을 쓴다 — 큐로 넘어간 뒤에도 peek이 스냅샷을 반환한다', async () => {
      const { adapter, release } = gatedAdapter()
      const { tracker, queue, scheduler } = compose(adapter)
      const snapshot = { gold: 10 }
      tracker.markDirty('characters', 'c1', snapshot)

      await scheduler.flush()

      // registry는 비었지만 스냅샷은 inProgress에 남아 조회된다.
      expect(tracker.size).toBe(0)
      expect(tracker.peek('characters', 'c1')?.snapshot).toBe(snapshot)

      release()
      await queue.drain()
    })

    it('§8.7: write 성공 후 그 키만 peek이 undefined가 되고 같은 배치의 다른 키는 남는다', async () => {
      const { adapter: gated, release } = gatedAdapter()
      // c1은 즉시 성공하고 c2는 게이트에 걸려 in-flight로 남는다.
      const adapter = vi.fn<WriteAdapter>((id) => (id === 'c1' ? Promise.resolve() : gated(id, null)))
      const { tracker, queue, scheduler } = compose(adapter)
      tracker.markDirty('characters', 'c1', { gold: 10 })
      tracker.markDirty('characters', 'c2', { gold: 20 })

      await scheduler.flush()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(tracker.peek('characters', 'c1')).toBeUndefined()
      expect(tracker.peek('characters', 'c2')?.snapshot).toEqual({ gold: 20 })
      expect(tracker.inProgressSize).toBe(1)

      release()
      await queue.drain()
      expect(tracker.peek('characters', 'c2')).toBeUndefined()
      expect(tracker.inProgressSize).toBe(0)
    })

    it('§8.11: permanent 실패로 폐기된 스냅샷도 inProgress에서 제거된다(누수 없음)', async () => {
      const adapter = vi.fn<WriteAdapter>(() =>
        Promise.reject(new DocumentNotFoundError('characters', 'c1')),
      )
      const logger = { error: vi.fn() }
      const { tracker, queue, scheduler, settle } = compose(adapter, { logger })
      tracker.markDirty('characters', 'c1', { gold: 10 })

      await scheduler.flush()
      await queue.drain()

      expect(settle).toHaveBeenCalledTimes(1)
      expect(settle.mock.calls[0]?.[1]).toBe('discarded')
      expect(tracker.peek('characters', 'c1')).toBeUndefined()
      expect(tracker.inProgressSize).toBe(0)
    })

    it('§8.8: 통지 처리기가 throw하면 엔트리가 inProgress에 남고 다음 checkout이 덮어써 해소된다', async () => {
      let firstNotified = false
      const { tracker, queue, scheduler } = compose(() => Promise.resolve(), {
        onSettled: () => {
          // 첫 통지만 실패시킨다 — 반납이 누락된 엔트리가 어떻게 회수되는지 고정한다.
          if (!firstNotified) {
            firstNotified = true
            throw new Error('통지 처리기가 터진다')
          }
        },
      })
      const stale = { gold: 10 }
      tracker.markDirty('characters', 'c1', stale)

      await scheduler.flush()
      await queue.drain()

      // 반납이 실패해 과거 스냅샷이 잔류한다(안전한 실패 — 사라지는 것보다 남는 쪽).
      expect(tracker.peek('characters', 'c1')?.snapshot).toBe(stale)
      expect(tracker.inProgressSize).toBe(1)

      // 같은 키의 다음 checkout이 그 자리를 덮어써 누수가 해소된다.
      const fresh = { gold: 20 }
      tracker.markDirty('characters', 'c1', fresh)
      await scheduler.flush()

      expect(tracker.peek('characters', 'c1')?.snapshot).toBe(fresh)
      expect(tracker.inProgressSize).toBe(1)
      await queue.drain()
    })

    /**
     * §8.12 — flush 2회가 이중 enqueue를 만들지 않는다.
     *
     * flush()는 첫 await 전에 checkout()을 동기로 끝내므로 두 호출은 실제로 인터리브하지 않는다.
     * 여기서 고정하는 것은 그 결과다 — 직접 flush가 re-entrancy 플래그를 우회해도 checkout의
     * 파괴적 특성이 두 번째 호출에 빈 배열을 주어 같은 엔트리가 두 번 enqueue되지 않는다.
     */
    it('§8.12: flush가 겹쳐 호출돼도 같은 엔트리를 두 번 enqueue하지 않는다', async () => {
      const tracker = new DirtyTracker()
      const enqueued: DirtyEntry[] = []
      const enqueue = vi.fn<(job: DirtyEntry) => Promise<void>>((entry) => {
        enqueued.push(entry)
        return Promise.resolve()
      })
      const scheduler = new SaveScheduler(tracker, { enqueue }, { clock })
      tracker.markDirty('characters', 'c1', { v: 1 })
      tracker.markDirty('characters', 'c2', { v: 2 })

      await Promise.all([scheduler.flush(), scheduler.flush()])

      expect(enqueue).toHaveBeenCalledTimes(2)
      expect(enqueued.map((e) => e.id).sort()).toEqual(['c1', 'c2'])
    })

    it('evict가 반환하는 시점에는 in-flight write의 반납이 이미 반영돼 있다', async () => {
      const { adapter, release } = gatedAdapter()
      const { tracker, queue, scheduler, settle } = compose(adapter)
      tracker.markDirty('characters', 'c1', { gold: 10 })

      await scheduler.flush()
      await new Promise((resolve) => setTimeout(resolve, 0)) // 워커가 in-flight로 가져간다
      expect(settle).not.toHaveBeenCalled() // write가 아직 게이트에 걸려 있다

      const evictP = queue.evict('characters', 'c1')
      release()
      await evictP

      // saveNow는 이 시점에 "이 키의 미완료 큐 write 없음"을 전제로 최신값을 쓴다.
      // 반납이 evict 반환 뒤로 밀리면 뒤늦은 ack이 saveNow 이후에 도착한다.
      expect(settle).toHaveBeenCalledTimes(1)
      expect(settle.mock.calls[0]?.[1]).toBe('acked')
      expect(tracker.peek('characters', 'c1')).toBeUndefined()
    })
  })

  describe('기본 clock·logger seam', () => {
    it('NOOP_LOGGER.error는 아무것도 하지 않는다', () => {
      expect(() => NOOP_LOGGER.error({}, 'x')).not.toThrow()
    })

    it('clock 미주입 시 전역 setInterval/clearInterval을 사용하고 stop으로 정리된다', () => {
      const tracker = new DirtyTracker()
      const { queue } = mockQueue()
      const setSpy = vi.spyOn(globalThis, 'setInterval')
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      const scheduler = new SaveScheduler(tracker, queue)

      scheduler.start()
      expect(setSpy).toHaveBeenCalledTimes(1)
      scheduler.stop()
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(scheduler.running).toBe(false)
    })
  })
})
