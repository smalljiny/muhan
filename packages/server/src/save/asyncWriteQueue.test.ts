import { describe, it, expect, afterEach, vi } from 'vitest'
import type { DirtyEntry } from './dirtyTracker.js'
import {
  AsyncWriteQueue,
  DEFAULT_CAPACITY,
  MAX_RETRIES,
  type WriteAdapter,
  type WriteOutcome,
} from './asyncWriteQueue.js'
import { NOOP_LOGGER } from './logger.js'
import { DocumentNotFoundError } from '../repo/types.js'
import { ZodError } from 'zod'

/** 테스트용 DirtyEntry 팩토리. */
function job(collection: string, id: string, snapshot: unknown): DirtyEntry {
  return { collection, id, snapshot }
}

/** backoff을 즉시 resolve해 비결정적 타이밍을 제거하는 주입 sleep. */
const immediate = (): Promise<void> => Promise.resolve()

/** 남은 microtask/macrotask를 flush한다(워커 진행 관찰용). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('AsyncWriteQueue (unit)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('상수', () => {
    it('DEFAULT_CAPACITY=1024, MAX_RETRIES=3을 노출한다', () => {
      expect(DEFAULT_CAPACITY).toBe(1024)
      expect(MAX_RETRIES).toBe(3)
    })

    it('capacity를 지정하지 않으면 DEFAULT_CAPACITY를 사용한다', () => {
      const queue = new AsyncWriteQueue({}, NOOP_LOGGER, { sleep: immediate })
      expect(queue.capacity).toBe(DEFAULT_CAPACITY)
    })
  })

  describe('enqueue + drain', () => {
    it('enqueue한 job 1건을 drain 시 collection 어댑터로 1회 dispatch한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', { gold: 10 }))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(1)
      expect(adapter).toHaveBeenCalledWith('c1', { gold: 10 })
      expect(queue.pendingSize).toBe(0)
    })

    it('collection별로 서로 다른 어댑터에 dispatch한다', async () => {
      const charAdapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const roomAdapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue(
        { characters: charAdapter, roomStates: roomAdapter },
        NOOP_LOGGER,
        { sleep: immediate },
      )

      const enqueues = [
        queue.enqueue(job('characters', 'c1', { gold: 1 })),
        queue.enqueue(job('roomStates', '42', { open: true })),
      ]
      await queue.drain()
      await Promise.all(enqueues)

      expect(charAdapter).toHaveBeenCalledTimes(1)
      expect(charAdapter).toHaveBeenCalledWith('c1', { gold: 1 })
      expect(roomAdapter).toHaveBeenCalledTimes(1)
      expect(roomAdapter).toHaveBeenCalledWith('42', { open: true })
    })
  })

  describe('coalescing (last-value-wins)', () => {
    it('같은 collection:id를 burst enqueue하면 최종 1회만 write하고 마지막 값을 반영한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      // yield 없이 동기 burst로 enqueue해야 coalescing이 성립한다(호출 계약).
      const enqueues = [
        queue.enqueue(job('characters', 'x', { v: 1 })),
        queue.enqueue(job('characters', 'x', { v: 2 })),
        queue.enqueue(job('characters', 'x', { v: 3 })),
      ]
      await queue.drain()
      await Promise.all(enqueues)

      expect(adapter).toHaveBeenCalledTimes(1)
      expect(adapter).toHaveBeenCalledWith('x', { v: 3 })
    })

    it('서로 다른 키는 coalescing되지 않고 각각 write된다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      const enqueues = [
        queue.enqueue(job('characters', 'a', {})),
        queue.enqueue(job('characters', 'b', {})),
      ]
      await queue.drain()
      await Promise.all(enqueues)

      expect(adapter).toHaveBeenCalledTimes(2)
    })
  })

  describe('capacity-full backpressure', () => {
    it('pending이 capacity를 초과하면 enqueue가 공간이 생길 때까지 block한다', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const adapter = vi.fn<WriteAdapter>(async () => {
        await gate
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { capacity: 2, sleep: immediate })

      const settled = { a: false, b: false, c: false, d: false }
      const eA = queue.enqueue(job('characters', 'a', {}))
      const eB = queue.enqueue(job('characters', 'b', {}))
      const eC = queue.enqueue(job('characters', 'c', {}))
      const eD = queue.enqueue(job('characters', 'd', {}))
      void eA.then(() => {
        settled.a = true
      })
      void eB.then(() => {
        settled.b = true
      })
      void eC.then(() => {
        settled.c = true
      })
      void eD.then(() => {
        settled.d = true
      })

      await flush()

      // 워커가 a를 in-flight로 가져가 슬롯 1개가 비어 c까지 수락되지만,
      // 게이트가 열리기 전까지 d는 capacity로 block된다.
      expect(settled.a).toBe(true)
      expect(settled.b).toBe(true)
      expect(settled.c).toBe(true)
      expect(settled.d).toBe(false)

      release()
      await queue.drain()
      await Promise.all([eA, eB, eC, eD])

      expect(adapter).toHaveBeenCalledTimes(4)
      expect(queue.pendingSize).toBe(0)
    })
  })

  describe('permanent 에러 (DocumentNotFoundError)', () => {
    it('재시도 없이 1회만 호출하고 logger로 기록한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() =>
        Promise.reject(new DocumentNotFoundError('characters', 'c1')),
      )
      const logger = { error: vi.fn() }
      const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })
  })

  describe('permanent 에러 (ZodError)', () => {
    it('스키마 검증 실패는 재시도 없이 1회만 호출하고 logger로 기록한다', async () => {
      const zodError = new ZodError([])
      const adapter = vi.fn<WriteAdapter>(() => Promise.reject(zodError))
      const logger = { error: vi.fn() }
      const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', { gold: 'malformed' }))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })
  })

  describe('워커 body 방어 (logger·sleep이 throw해도 생존)', () => {
    it('주입된 logger.error가 throw해도 워커가 죽지 않고 후속 job을 처리한다', async () => {
      const seen: string[] = []
      const adapter = vi.fn<WriteAdapter>((id) => {
        seen.push(id)
        return id === 'bad'
          ? Promise.reject(new Error('일시적 네트워크 오류'))
          : Promise.resolve()
      })
      const logger = {
        error: vi.fn(() => {
          throw new Error('logger 자체가 터진다')
        }),
      }
      const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

      await queue.enqueue(job('characters', 'bad', {}))
      await queue.enqueue(job('characters', 'good', { v: 1 }))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(seen).toContain('good')
    })
  })

  describe('transient 에러 재시도', () => {
    it('MAX_RETRIES 안에서 성공하면 write가 완료된다(2회 실패 후 성공=3회 호출)', async () => {
      let n = 0
      const adapter = vi.fn<WriteAdapter>(() => {
        n += 1
        return n < 3 ? Promise.reject(new Error('일시적 네트워크 오류')) : Promise.resolve()
      })
      const sleep = vi.fn(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(3)
      expect(sleep).toHaveBeenCalledTimes(2)
    })

    it('계속 실패하면 1+MAX_RETRIES=4회 호출 후 최종 실패로 폐기하고 기록한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() =>
        Promise.reject(new Error('일시적 네트워크 오류')),
      )
      const logger = { error: vi.fn() }
      const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(MAX_RETRIES + 1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('한 job의 재시도 소진이 워커를 죽이지 않고 후속 job을 처리한다', async () => {
      const seen: string[] = []
      const adapter = vi.fn<WriteAdapter>((id) => {
        seen.push(id)
        return id === 'bad'
          ? Promise.reject(new Error('일시적 네트워크 오류'))
          : Promise.resolve()
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      await queue.enqueue(job('characters', 'bad', {}))
      await queue.enqueue(job('characters', 'good', { v: 1 }))
      await queue.drain()

      expect(seen.filter((id) => id === 'good')).toHaveLength(1)
    })
  })

  describe('알 수 없는 collection', () => {
    it('어댑터가 없는 collection job은 재시도 없이 기록하고 폐기한다', async () => {
      const logger = { error: vi.fn() }
      const queue = new AsyncWriteQueue({}, logger, { sleep: immediate })

      await queue.enqueue(job('unknownColl', 'x', {}))
      await queue.drain()

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(queue.pendingSize).toBe(0)
    })

    it('prototype 키(__proto__) collection은 hasOwn 가드로 폐기된다(어댑터 오인 없음)', async () => {
      const logger = { error: vi.fn() }
      const queue = new AsyncWriteQueue({}, logger, { sleep: immediate })

      await queue.enqueue(job('__proto__', 'x', {}))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(queue.pendingSize).toBe(0)
    })
  })

  describe('evict (saveNow 협조 — pending 취소 + in-flight await)', () => {
    it('pending인 키를 evict하면 write되지 않고 취소된다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      // enqueue 직후(동기) pending에만 있고 워커는 microtask라 아직 시작 전.
      const enq = queue.enqueue(job('characters', 'c1', { gold: 1 }))
      await queue.evict('characters', 'c1')
      await enq
      await queue.drain()

      expect(adapter).not.toHaveBeenCalled()
      expect(queue.pendingSize).toBe(0)
    })

    it('in-flight인 키를 evict하면 그 write 완료를 await한 뒤 반환한다', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let done = false
      const adapter = vi.fn<WriteAdapter>(async () => {
        await gate
        done = true
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', { gold: 1 }))
      await flush() // 워커가 in-flight로 가져가 gate에서 hang

      let evictSettled = false
      const evictP = queue.evict('characters', 'c1').then(() => {
        evictSettled = true
      })
      await Promise.resolve()
      expect(evictSettled).toBe(false) // in-flight write가 안 끝났으면 evict도 미완료

      release()
      await evictP
      expect(done).toBe(true) // in-flight write가 완료된 뒤 evict가 반환됐다
    })

    it('없는 키를 evict하면 즉시 반환한다(no-op)', async () => {
      const queue = new AsyncWriteQueue({}, NOOP_LOGGER, { sleep: immediate })
      await expect(queue.evict('characters', 'missing')).resolves.toBeUndefined()
    })

    it('회귀(deadlock): pending 키 evict가 capacity로 block된 enqueue를 깨운다', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const adapter = vi.fn<WriteAdapter>(async () => {
        await gate
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, {
        capacity: 1,
        sleep: immediate,
      })

      // in-flight 1건(a) — 워커가 가져가 gate에서 hang.
      await queue.enqueue(job('characters', 'a', {}))
      await flush()
      // pending 1건(stale b)로 capacity(1) 포화.
      await queue.enqueue(job('characters', 'b', { gold: 1 }))
      // 세 번째 enqueue(c)는 capacity로 block.
      let cSettled = false
      const eC = queue.enqueue(job('characters', 'c', {})).then(() => {
        cSettled = true
      })
      await Promise.resolve()
      expect(cSettled).toBe(false)

      // stale b를 evict — 슬롯이 비므로 block된 c가 깨어나야 한다(방치 시 deadlock).
      await queue.evict('characters', 'b')
      await eC
      expect(cSettled).toBe(true)

      release()
      await queue.drain()
      expect(queue.pendingSize).toBe(0)
    })
  })

  /**
   * 완료 프로토콜 — 큐가 job 종결을 onSettled(entry, outcome)로 통지한다.
   *
   * DirtyTracker의 수명 계약(checkout→ack/discard)은 "write가 언제 끝났는가"를 큐만 알기 때문에
   * 이 통지 없이는 성립하지 않는다. 통지가 빠지면 스냅샷이 inProgress에 영구 잔류하고(누수),
   * 반대로 실패 경로에서 통지가 빠지면 폐기된 스냅샷이 최신인 척 남아 재접속 hydrate가 이미
   * 버려진 값을 덮어쓴다. 그래서 성공·실패 **모든** 종결 경로를 개별 케이스로 고정한다.
   */
  describe('완료 프로토콜 (onSettled)', () => {
    /** onSettled 통지를 기록하는 스파이. */
    const settleSpy = (): ReturnType<typeof vi.fn> =>
      vi.fn<(entry: DirtyEntry, outcome: WriteOutcome) => void>()

    it('write 성공 시 onSettled(entry, "acked")를 정확히 1회 호출한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, {
        sleep: immediate,
        onSettled,
      })
      const entry = job('characters', 'c1', { gold: 10 })

      await queue.enqueue(entry)
      await queue.drain()

      expect(onSettled).toHaveBeenCalledTimes(1)
      // 인자는 enqueue된 엔트리와 **같은 참조**여야 한다 — tracker의 반납 조건이 참조 동일성이라
      // 복제본을 넘기면 ack이 조용한 no-op이 되어 스냅샷이 inProgress에 영구 잔류한다.
      expect(onSettled.mock.calls[0]?.[0]).toBe(entry)
      expect(onSettled.mock.calls[0]?.[1]).toBe('acked')
    })

    it('재시도 안에서 성공하면 통지는 여전히 acked 1회다(중간 실패는 통지하지 않는다)', async () => {
      let n = 0
      const adapter = vi.fn<WriteAdapter>(() => {
        n += 1
        return n < 3 ? Promise.reject(new Error('일시적 네트워크 오류')) : Promise.resolve()
      })
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(3)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('acked')
    })

    it('permanent 에러(DocumentNotFoundError)는 discarded로 통지한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() =>
        Promise.reject(new DocumentNotFoundError('characters', 'c1')),
      )
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, { error: vi.fn() }, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('discarded')
    })

    it('permanent 에러(ZodError)는 discarded로 통지한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.reject(new ZodError([])))
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, { error: vi.fn() }, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'c1', { gold: 'malformed' }))
      await queue.drain()

      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('discarded')
    })

    it('transient 재시도 소진은 discarded로 통지한다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.reject(new Error('일시적 네트워크 오류')))
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, { error: vi.fn() }, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'c1', {}))
      await queue.drain()

      expect(adapter).toHaveBeenCalledTimes(MAX_RETRIES + 1)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('discarded')
    })

    it('어댑터 미발견 job도 discarded로 통지한다', async () => {
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({}, { error: vi.fn() }, { sleep: immediate, onSettled })

      await queue.enqueue(job('unknownColl', 'x', {}))
      await queue.drain()

      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('discarded')
    })

    it('주입 logger가 throw하는 경로도 discarded로 통지한다(안쪽 방어 경유)', async () => {
      const adapter = vi.fn<WriteAdapter>(() =>
        Promise.reject(new DocumentNotFoundError('characters', 'c1')),
      )
      const logger = {
        error: vi.fn(() => {
          throw new Error('logger 자체가 터진다')
        }),
      }
      const onSettled = settleSpy()
      const queue = new AsyncWriteQueue({ characters: adapter }, logger, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'c1', {}))
      await expect(queue.drain()).resolves.toBeUndefined()

      // 결과를 확정하지 못한 경로는 보수적으로 discarded다 — write 성공을 확인하지 못했는데
      // acked로 통지하면 아직 영속되지 않은 스냅샷이 tracker에서 사라진다.
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]?.[1]).toBe('discarded')
    })

    /**
     * 스펙 §8.8 — 통지 콜백의 오류가 워커 루프를 죽이지 않는다.
     *
     * onSettled 구현체(SaveEngine.settle→tracker.ack)가 throw하면 그 job의 반납은 실패하지만,
     * 그 실패가 후속 job의 write까지 막으면 한 번의 콜백 버그가 전체 세이브 파이프라인을 정지시킨다.
     */
    it('§8.8: onSettled가 throw해도 워커가 죽지 않고 후속 job을 write·통지한다', async () => {
      const written: string[] = []
      const adapter = vi.fn<WriteAdapter>((id) => {
        written.push(id)
        return Promise.resolve()
      })
      const onSettled = vi.fn<(entry: DirtyEntry, outcome: WriteOutcome) => void>((entry) => {
        if (entry.id === 'bad') throw new Error('통지 처리기가 터진다')
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, {
        sleep: immediate,
        onSettled,
      })

      await queue.enqueue(job('characters', 'bad', {}))
      await queue.enqueue(job('characters', 'good', {}))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(written).toEqual(['bad', 'good'])
      expect(onSettled).toHaveBeenCalledTimes(2)
    })

    it('§8.8: onSettled의 throw는 logger.error로 흔적을 남긴다', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const error = vi.fn()
      const cause = new Error('통지 처리기가 터진다')
      const queue = new AsyncWriteQueue({ characters: adapter }, { error }, {
        sleep: immediate,
        onSettled: () => {
          throw cause
        },
      })

      await queue.enqueue(job('characters', 'c1', {}))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(error).toHaveBeenCalledTimes(1)
      expect(error.mock.calls[0]?.[0]).toMatchObject({
        collection: 'characters',
        id: 'c1',
        outcome: 'acked',
        err: cause,
      })
    })

    /**
     * 통지 실패를 기록하려는 logger 자체가 throw하는 이중 고장.
     *
     * 이 파일의 소비자 계약은 실 logger 주입을 요구하는데, 그 logger가 고장 나 있을 수 있다.
     * 흔적 남기기에 실패하는 것까지는 감수하되 워커 루프는 살아 후속 job을 계속 write해야 한다 —
     * 로깅 실패가 세이브 파이프라인 전체를 정지시키면 고장의 크기가 부풀어 오른다.
     */
    it('§8.8: 통지 throw를 기록하려는 logger까지 throw해도 워커가 후속 job을 write한다', async () => {
      const written: string[] = []
      const adapter = vi.fn<WriteAdapter>((id) => {
        written.push(id)
        return Promise.resolve()
      })
      const error = vi.fn(() => {
        throw new Error('logger도 터진다')
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, { error }, {
        sleep: immediate,
        onSettled: (entry) => {
          if (entry.id === 'bad') throw new Error('통지 처리기가 터진다')
        },
      })

      await queue.enqueue(job('characters', 'bad', {}))
      await queue.enqueue(job('characters', 'good', {}))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(written).toEqual(['bad', 'good'])
      expect(error).toHaveBeenCalledTimes(1)
    })

    it('onSettled 미주입이어도 write는 정상 동작한다(옵션)', async () => {
      const adapter = vi.fn<WriteAdapter>(() => Promise.resolve())
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      await queue.enqueue(job('characters', 'c1', { gold: 1 }))
      await expect(queue.drain()).resolves.toBeUndefined()

      expect(adapter).toHaveBeenCalledTimes(1)
    })
  })

  describe('drain', () => {
    it('pending이 없으면 즉시 반환한다', async () => {
      const queue = new AsyncWriteQueue({}, NOOP_LOGGER, { sleep: immediate })
      await expect(queue.drain()).resolves.toBeUndefined()
    })

    it('drain은 모든 pending write 완료를 await하고 반환 후 큐가 빈다', async () => {
      const written: string[] = []
      const adapter = vi.fn<WriteAdapter>((id) => {
        written.push(id)
        return Promise.resolve()
      })
      const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep: immediate })

      const enqueues = [
        queue.enqueue(job('characters', 'a', {})),
        queue.enqueue(job('characters', 'b', {})),
        queue.enqueue(job('characters', 'c', {})),
      ]
      await queue.drain()
      await Promise.all(enqueues)

      expect(written.sort()).toEqual(['a', 'b', 'c'])
      expect(queue.pendingSize).toBe(0)
    })
  })
})
