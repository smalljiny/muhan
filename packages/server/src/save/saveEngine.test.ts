import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from 'vitest'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
import type { ObjectRepository } from '../repo/objectRepository.js'
import { DocumentNotFoundError } from '../repo/types.js'
import { NOOP_LOGGER, type SaveLogger } from './logger.js'
import { SaveEngine, type SaveEngineOptions } from './saveEngine.js'
import { DirtyTracker } from './dirtyTracker.js'
import { createMarkObjectDeleted } from './markObjectDeleted.js'
import { FakeClock } from '../util/clock.testutil.js'

/** 백그라운드 워커가 진행하도록 남은 microtask/macrotask를 비운다. */
const barrier = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** repo 스파이 묶음 — SaveEngine에 주입할 최소 fake repo 4종. */
interface Spies {
  charUpdate: ReturnType<typeof vi.fn>
  bankUpdate: ReturnType<typeof vi.fn>
  worldUpsert: ReturnType<typeof vi.fn>
  objectDelete: ReturnType<typeof vi.fn>
  charRepo: CharacterRepository
  bankRepo: BankRepository
  worldRepo: WorldRepository
  objectRepo: ObjectRepository
}

function makeSpies(): Spies {
  const charUpdate = vi.fn<(id: string, patch: unknown) => Promise<void>>(() => Promise.resolve())
  const bankUpdate = vi.fn<(id: string, patch: unknown) => Promise<void>>(() => Promise.resolve())
  const worldUpsert = vi.fn<(state: unknown) => Promise<void>>(() => Promise.resolve())
  const objectDelete = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve())
  return {
    charUpdate,
    bankUpdate,
    worldUpsert,
    objectDelete,
    charRepo: { updateById: charUpdate } as unknown as CharacterRepository,
    bankRepo: { updateById: bankUpdate } as unknown as BankRepository,
    worldRepo: { upsert: worldUpsert } as unknown as WorldRepository,
    objectRepo: { deleteById: objectDelete } as unknown as ObjectRepository,
  }
}

/** 즉시 resolve하는 backoff sleep(비결정적 타이밍 제거). */
const immediate = (): Promise<void> => Promise.resolve()

function makeEngine(spies: Spies, clock: FakeClock, logger: SaveLogger = NOOP_LOGGER): SaveEngine {
  return new SaveEngine(spies.charRepo, spies.bankRepo, spies.worldRepo, spies.objectRepo, logger, {
    clock,
    queueOptions: { sleep: immediate },
  })
}

describe('SaveEngine', () => {
  let clock: FakeClock
  let spies: Spies

  beforeEach(() => {
    clock = new FakeClock()
    spies = makeSpies()
  })

  afterEach(() => {
    vi.clearAllMocks()
    // 각 테스트가 try/finally로 직접 복원하지 않도록 여기서 일괄 복원한다 —
    // 이 파일은 DirtyTracker.prototype을 스파이하므로 누수되면 다른 테스트로 번진다.
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('T5.1 — 조립·dispatch 배선', () => {
    it('start()는 scheduler를 기본 120초 간격으로 arm한다', () => {
      const engine = makeEngine(spies, clock)
      engine.start()
      expect(clock.lastMs).toBe(120_000)
      expect(clock.activeCount).toBe(1)
    })

    it('생성자 옵션 intervalMs로 간격을 override한다', () => {
      const engine = new SaveEngine(
        spies.charRepo,
        spies.bankRepo,
        spies.worldRepo,
        spies.objectRepo,
        NOOP_LOGGER,
        {
          clock,
          intervalMs: 5_000,
          queueOptions: { sleep: immediate },
        },
      )
      engine.start()
      expect(clock.lastMs).toBe(5_000)
    })

    it('markDirty→주기 flush가 collection별 어댑터로 dispatch한다(characters→updateById, bankAccounts→updateById, roomStates→upsert)', async () => {
      const engine = makeEngine(spies, clock)
      engine.markDirty('characters', 'c1', { gold: 10 })
      engine.markDirty('bankAccounts', 'b1', { gold: 500 })
      engine.markDirty('roomStates', '42', { roomId: 42, open: true })

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.charUpdate).toHaveBeenCalledTimes(1)
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 10 })
      expect(spies.bankUpdate).toHaveBeenCalledTimes(1)
      expect(spies.bankUpdate).toHaveBeenCalledWith('b1', { gold: 500 })
      expect(spies.worldUpsert).toHaveBeenCalledTimes(1)
      expect(spies.worldUpsert).toHaveBeenCalledWith({ roomId: 42, open: true })
    })

    it('전체 문서 스냅샷(_id 포함)도 patch 컬렉션은 _id를 벗겨 updateById로 넘긴다', async () => {
      const engine = makeEngine(spies, clock)
      // 호출자가 라이브 전체 문서를 스냅샷으로 넘긴 경우 — _id가 $set에 실리면 Mongo immutable 에러.
      engine.markDirty('characters', 'c1', { _id: 'c1', gold: 10, name: '타이' })
      engine.markDirty('bankAccounts', 'b1', { _id: 'b1', gold: 500 })

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 10, name: '타이' })
      expect(spies.bankUpdate).toHaveBeenCalledWith('b1', { gold: 500 })
    })

    it('saveNow도 전체 문서 스냅샷의 _id를 벗겨 updateById로 넘긴다', async () => {
      const engine = makeEngine(spies, clock)
      await engine.saveNow('characters', 'c1', { _id: 'c1', gold: 99 }, 'logout')
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 99 })
    })

    it('실 logger를 queue에 주입한다 — permanent 실패 시 logger.error로 기록한다(무흔적 폐기 방지)', async () => {
      spies.charUpdate.mockRejectedValue(new DocumentNotFoundError('characters', 'c1'))
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      engine.markDirty('characters', 'c1', { gold: 10 })
      engine.start()
      clock.tick()
      await barrier()

      expect(logger.error).toHaveBeenCalledTimes(1)
    })
  })

  describe('T5.2 — saveNow + pending evict', () => {
    it('saveNow는 repo write를 await한다(fire-and-forget 아님)', async () => {
      let resolveWrite!: () => void
      spies.charUpdate.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
      )
      const engine = makeEngine(spies, clock)

      let settled = false
      const p = engine.saveNow('characters', 'c1', { gold: 99 }, 'logout')
      void p.then(() => {
        settled = true
      })

      await Promise.resolve()
      expect(settled).toBe(false) // repo write가 아직 안 끝났으면 saveNow도 미완료
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 99 })

      resolveWrite()
      await p
      expect(settled).toBe(true)
    })

    it('evict(핵심): markDirty(old)→saveNow(new)→주기 flush 시 stale old로 덮어쓰지 않는다', async () => {
      const engine = makeEngine(spies, clock)

      engine.markDirty('characters', 'c1', { gold: 1 }) // stale
      await engine.saveNow('characters', 'c1', { gold: 99 }, 'logout') // 최신 즉시 write + evict

      engine.start()
      clock.tick() // 주기 flush — evict됐으면 checkout이 비어 재-dispatch 없음
      await barrier()

      expect(spies.charUpdate).toHaveBeenCalledTimes(1)
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 99 })
    })

    it('evict-before-write 판별: saveNow write가 in-flight인 동안 도착한 최신 markDirty를 유실하지 않는다', async () => {
      // 이 테스트는 evict-before-write와 evict-after-write를 구별한다. evict-after였다면 write 완료
      // 후 evict가 in-flight 중 도착한 snap_newer를 지워 유실시킨다(logic bug). evict-before는
      // snap_newer가 evict 이후 tracker에 남아 다음 flush로 영속화됨을 보장한다.
      let resolveWrite!: () => void
      spies.charUpdate.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
      )
      const engine = makeEngine(spies, clock)

      engine.markDirty('characters', 'c1', { gold: 1 }) // snap_old
      const p = engine.saveNow('characters', 'c1', { gold: 2 }, 'logout') // snap_new — write가 hang
      await Promise.resolve()

      engine.markDirty('characters', 'c1', { gold: 3 }) // snap_newer — write in-flight 중 도착

      resolveWrite()
      await p

      engine.start()
      clock.tick()
      await barrier()

      // saveNow의 snap_new write(호출 1) + snap_newer 주기 flush write(호출 2).
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 2 })
      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 3 })
    })

    it('회귀(write-loss): flush로 큐에 in-flight인 stale write가 saveNow의 최신 write를 덮어쓰지 않는다', async () => {
      // 레이스: markDirty(snap_old) → 주기 flush가 snap_old를 큐로 옮겨 워커가 in-flight로 가져간다
      // → saveNow(snap_new). tracker.evict는 이미 checkout된 키라 no-op이므로, in-flight snap_old write가
      // saveNow의 snap_new write보다 나중에 완료되면 최신값을 덮어쓴다(무성 데이터 손실). saveNow가
      // 큐의 pending 취소 + in-flight write await까지 수행해야 이 창이 봉쇄된다.
      const writeLog: unknown[] = []
      let releaseStale!: () => void
      let firstCall = true
      spies.charUpdate.mockImplementation((_id: string, patch: unknown) => {
        if (firstCall) {
          firstCall = false
          // snap_old — 큐 워커가 in-flight로 가져간 뒤 hang. 나중에 release한다.
          return new Promise<void>((resolve) => {
            releaseStale = () => {
              writeLog.push(patch)
              resolve()
            }
          })
        }
        writeLog.push(patch)
        return Promise.resolve()
      })
      const engine = makeEngine(spies, clock)

      engine.markDirty('characters', 'c1', { gold: 1 }) // snap_old (stale)
      engine.start()
      clock.tick() // 주기 flush — snap_old를 큐로 enqueue
      await barrier() // 워커가 snap_old를 in-flight로 가져가 hang

      // snap_new 즉시 저장 — 이 시점 snap_old는 큐에서 in-flight.
      const p = engine.saveNow('characters', 'c1', { gold: 99 }, 'logout')

      releaseStale() // in-flight snap_old write 완료
      await p

      // 최종 write는 snap_new여야 한다 — stale snap_old가 나중에 완료돼 덮어쓰면 안 된다.
      expect(writeLog.at(-1)).toEqual({ gold: 99 })
    })

    it('saveNow write 실패 시 rethrow한다(fail-loud, 재-mark 없음) + reason을 실패 로그에 담는다', async () => {
      spies.charUpdate.mockRejectedValue(new DocumentNotFoundError('characters', 'c1'))
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      await expect(engine.saveNow('characters', 'c1', { gold: 5 }, 'logout')).rejects.toThrow(
        DocumentNotFoundError,
      )
      // 실패 로그에 관측용 reason이 담긴다.
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'characters', id: 'c1', reason: 'logout' }),
        expect.any(String),
      )
    })

    it('알 수 없는 collection saveNow는 logger.error 기록 후 no-op(throw 없음)', async () => {
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      await expect(engine.saveNow('unknownColl', 'x', {}, 'test')).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(spies.charUpdate).not.toHaveBeenCalled()
    })

    it('id가 문자열이 아니면 saveNow가 throw한다(Mongo _id 연산자 주입 차단)', async () => {
      const engine = makeEngine(spies, clock)

      await expect(
        engine.saveNow('characters', { $ne: '' } as unknown as string, { gold: 1 }, 'logout'),
      ).rejects.toThrow()
      expect(spies.charUpdate).not.toHaveBeenCalled()
    })

    it('prototype 키(__proto__) collection saveNow는 hasOwn 가드로 no-op(어댑터 오인 없음)', async () => {
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      await expect(engine.saveNow('__proto__', 'x', {}, 'test')).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(spies.charUpdate).not.toHaveBeenCalled()
    })
  })

  /**
   * 완료 프로토콜 배선 — 큐의 종결 통지가 tracker 반납으로 이어진다.
   *
   * 이 배선이 빠지면 스냅샷이 inProgress에 영구 잔류해 tracker가 무한 성장하고, 반대로 호출자
   * 옵션이 엔진 배선을 덮으면 반납 자체가 발화하지 않는다. 두 방향 모두 예외도 로그도 남기지
   * 않는 무성 결함이라 배선 형태를 직접 고정한다.
   */
  describe('T2.3 — 완료 프로토콜 배선(onSettled → tracker.ack/discard)', () => {
    it('write 성공 시 tracker.ack을 checkout 엔트리로 정확히 1회 호출한다', async () => {
      const ackSpy = vi.spyOn(DirtyTracker.prototype, 'ack')
      // checkout이 내준 엔트리를 포착해 참조 동일성까지 단언한다 — 값 동등성만 보면 배선이
      // 엔트리를 재구성해 넘겨도 통과하는데, 그러면 tracker의 반납 가드가 영영 성립하지 않는다.
      const checkoutSpy = vi.spyOn(DirtyTracker.prototype, 'checkout')
      const engine = makeEngine(spies, clock)
      engine.markDirty('characters', 'c1', { gold: 10 })

      engine.start()
      clock.tick()
      await barrier()

      const checkedOut = checkoutSpy.mock.results.flatMap((r) =>
        r.type === 'return' ? [...r.value] : [],
      )
      expect(checkedOut).toHaveLength(1)
      expect(ackSpy).toHaveBeenCalledTimes(1)
      expect(ackSpy).toHaveBeenCalledWith(checkedOut[0])
      expect(ackSpy.mock.calls[0]?.[0]).toBe(checkedOut[0])
    })

    it('permanent 실패 시 tracker.discard를 호출한다(ack 아님)', async () => {
      const ackSpy = vi.spyOn(DirtyTracker.prototype, 'ack')
      const discardSpy = vi.spyOn(DirtyTracker.prototype, 'discard')
      const checkoutSpy = vi.spyOn(DirtyTracker.prototype, 'checkout')
      spies.charUpdate.mockRejectedValue(new DocumentNotFoundError('characters', 'c1'))
      const engine = makeEngine(spies, clock, { error: vi.fn() })
      engine.markDirty('characters', 'c1', { gold: 10 })

      engine.start()
      clock.tick()
      await barrier()

      const checkedOut = checkoutSpy.mock.results.flatMap((r) =>
        r.type === 'return' ? [...r.value] : [],
      )
      expect(checkedOut).toHaveLength(1)
      expect(discardSpy).toHaveBeenCalledTimes(1)
      // 반납 가드가 참조 동일성이므로, 폐기 경로도 checkout이 내준 그 엔트리여야 한다.
      expect(discardSpy.mock.calls[0]?.[0]).toBe(checkedOut[0])
      expect(ackSpy).not.toHaveBeenCalled()
    })

    /**
     * 호출자가 `onSettled`를 넘기면 엔진 배선이 덮여 반납이 발화하지 않고, 스냅샷이 inProgress에
     * 영구 잔류한다. 그 고장은 예외도 로그도 남기지 않으므로 런타임 무시가 아니라 타입으로 막는다
     * — `queueOptions`가 `Omit<AsyncWriteQueueOptions, 'onSettled'>`라 넘기는 것 자체가 컴파일
     * 에러다. 아래 단언이 그 형태를 고정한다(생성자 스프레드 순서는 같은 방어의 이중화다).
     */
    it('queueOptions는 onSettled를 받지 않는다(엔진 배선 보호)', () => {
      expectTypeOf<NonNullable<SaveEngineOptions['queueOptions']>>().not.toHaveProperty('onSettled')
      expectTypeOf<NonNullable<SaveEngineOptions['queueOptions']>>().toHaveProperty('sleep')
      expectTypeOf<NonNullable<SaveEngineOptions['queueOptions']>>().toHaveProperty('capacity')
    })
  })

  describe('T5.3 — shutdown', () => {
    it('scheduler를 멈추고 남은 dirty를 강제 flush한 뒤 queue를 drain해 모든 write를 완료한다', async () => {
      const engine = makeEngine(spies, clock)
      engine.start()
      engine.markDirty('characters', 'c1', { gold: 7 })
      engine.markDirty('bankAccounts', 'b1', { gold: 12 })

      await engine.shutdown()

      expect(spies.charUpdate).toHaveBeenCalledWith('c1', { gold: 7 })
      expect(spies.bankUpdate).toHaveBeenCalledWith('b1', { gold: 12 })
      // scheduler가 정지돼 interval이 해제됐다.
      expect(clock.activeCount).toBe(0)
    })

    it('shutdown은 scheduler가 멈춘 뒤에도 잔여 dirty를 flush한다(주기 tick 없이)', async () => {
      const engine = makeEngine(spies, clock)
      engine.start()
      engine.markDirty('roomStates', '9', { roomId: 9, hp: 3 })

      await engine.shutdown()

      // clock.tick 없이도 shutdown의 직접 flush 경로로 dispatch됐다.
      expect(spies.worldUpsert).toHaveBeenCalledTimes(1)
      expect(spies.worldUpsert).toHaveBeenCalledWith({ roomId: 9, hp: 3 })
    })

    it('dirty가 없어도 shutdown은 안전하게 완료된다', async () => {
      const engine = makeEngine(spies, clock)
      engine.start()
      await expect(engine.shutdown()).resolves.toBeUndefined()
      expect(clock.activeCount).toBe(0)
    })
  })

  describe('T4 — objectDeletions 삭제 어댑터', () => {
    /** 삭제 mark의 툼스톤 스냅샷(markObjectDeleted seam이 싣는 형태와 동일). */
    const tombstone = (id: string): unknown => ({ _id: id, deleted: true })

    it('markDirty→주기 flush가 objectDeletions를 deleteById로 dispatch한다(id만, snapshot 미사용)', async () => {
      const engine = makeEngine(spies, clock)
      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
      expect(spies.objectDelete).toHaveBeenCalledWith('obj-1')
    })

    it('markObjectDeleted seam→주기 flush 경로로 deleteById가 정확히 1회 호출된다', async () => {
      // 실 seam을 통과시켜 프로덕션이 실제로 흘리는 형태(컬렉션 리터럴·툼스톤)로 배선을 관통 검증한다
      // — 직접 markDirty에 넣으면 seam과 dispatch 키가 어긋나도 검출되지 않는다.
      const engine = makeEngine(spies, clock)
      const markObjectDeleted = createMarkObjectDeleted((collection, id, snapshot) =>
        engine.markDirty(collection, id, snapshot),
      )

      markObjectDeleted('obj-1')
      engine.start()
      clock.tick()
      await barrier()

      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
      expect(spies.objectDelete).toHaveBeenCalledWith('obj-1')
    })

    it('같은 id를 여러 번 mark해도 coalescing으로 deleteById가 1회만 호출된다', async () => {
      const engine = makeEngine(spies, clock)
      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))
      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
    })

    it('OQ1 순서: characters mark 후 objectDeletions mark를 같은 flush로 checkout하면 updateById가 deleteById보다 먼저 호출된다', async () => {
      // 단일 워커 FIFO + DirtyTracker 삽입 순서 보존이라 markDirty 호출 순서가 곧 write 시도 순서다.
      // 이 순서가 뒤집히면 "책은 지워졌는데 주문은 미학습" 방향의 실손실 노출 창이 넓어진다(OQ1).
      const engine = makeEngine(spies, clock)
      engine.markDirty('characters', 'char-1', { spells: [1] })
      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.charUpdate).toHaveBeenCalledTimes(1)
      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
      const charOrder = spies.charUpdate.mock.invocationCallOrder[0] ?? 0
      const deleteOrder = spies.objectDelete.mock.invocationCallOrder[0] ?? 0
      expect(charOrder).toBeLessThan(deleteOrder)
    })

    it('OQ1 실패 격리: 삭제가 4회(1+3) transient 실패해도 characters write는 커밋되고 워커가 살아 다음 job을 처리한다', async () => {
      spies.objectDelete.mockRejectedValue(new Error('네트워크 일시 실패'))
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      engine.markDirty('characters', 'char-1', { spells: [1] })
      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))

      engine.start()
      clock.tick()
      await barrier()

      // characters write는 삭제 실패와 무관하게 커밋된다(같은 flush, 앞선 job).
      expect(spies.charUpdate).toHaveBeenCalledWith('char-1', { spells: [1] })
      // 총 시도 = 1(초기) + MAX_RETRIES(3).
      expect(spies.objectDelete).toHaveBeenCalledTimes(4)
      // 재시도 소진은 logger.error 1건으로 기록된다(무흔적 폐기 방지).
      expect(logger.error).toHaveBeenCalledTimes(1)

      // 워커 생존 — 이후 job이 정상 처리된다.
      engine.markDirty('bankAccounts', 'bank-1', { gold: 5 })
      clock.tick()
      await barrier()
      expect(spies.bankUpdate).toHaveBeenCalledWith('bank-1', { gold: 5 })
    })

    it('permanent 분류: 이미 삭제된 id의 DocumentNotFoundError는 재시도 없이 폐기되고 logger.error 1회를 남긴다', async () => {
      spies.objectDelete.mockRejectedValue(new DocumentNotFoundError('objects', 'obj-1'))
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))
      engine.start()
      clock.tick()
      await barrier()

      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('saveNow(objectDeletions)는 evict-before-write 계약을 따른다(주기 flush가 같은 키를 재-dispatch하지 않는다)', async () => {
      const engine = makeEngine(spies, clock)

      engine.markDirty('objectDeletions', 'obj-1', tombstone('obj-1'))
      await engine.saveNow('objectDeletions', 'obj-1', tombstone('obj-1'), 'study')

      engine.start()
      clock.tick()
      await barrier()

      expect(spies.objectDelete).toHaveBeenCalledTimes(1)
      expect(spies.objectDelete).toHaveBeenCalledWith('obj-1')
    })

    it('saveNow(objectDeletions) 실패는 rethrow하고 reason을 실패 로그에 담는다(fail-loud)', async () => {
      spies.objectDelete.mockRejectedValue(new DocumentNotFoundError('objects', 'obj-1'))
      const logger = { error: vi.fn() }
      const engine = makeEngine(spies, clock, logger)

      await expect(
        engine.saveNow('objectDeletions', 'obj-1', tombstone('obj-1'), 'study'),
      ).rejects.toThrow(DocumentNotFoundError)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'objectDeletions', id: 'obj-1', reason: 'study' }),
        expect.any(String),
      )
    })

    it('shutdown이 잔여 objectDeletions mark를 checkout해 삭제를 완료한다', async () => {
      const engine = makeEngine(spies, clock)
      engine.start()
      engine.markDirty('objectDeletions', 'obj-7', tombstone('obj-7'))

      await engine.shutdown()

      expect(spies.objectDelete).toHaveBeenCalledWith('obj-7')
    })
  })
})
