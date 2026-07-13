import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DirtyEntry } from './dirtyTracker.js'
import { DirtyTracker } from './dirtyTracker.js'
import { AsyncWriteQueue, type WriteAdapter } from './asyncWriteQueue.js'
import { NOOP_LOGGER } from './logger.js'
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
    it('간격 경과(tick) 시 DirtyTracker를 drain해 각 항목을 enqueue한다', () => {
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

    it('빈 배치(drain 0건)는 no-op이라 enqueue를 호출하지 않는다', () => {
      const tracker = new DirtyTracker()
      const { queue, enqueue } = mockQueue()
      const scheduler = new SaveScheduler(tracker, queue, { clock })

      scheduler.start()
      clock.tick() // 첫 tick: dirty 없음
      clock.tick() // 재flush도 빈 배치

      expect(enqueue).not.toHaveBeenCalled()
    })

    it('flush() 직접 호출도 drain→enqueue 절차를 수행한다', async () => {
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
      // 큐 자체의 drain을 배리어로 사용 — 워커가 어댑터까지 dispatch 완료
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
