import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CharacterRepository } from '../repo/characterRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'
import type { WorldRepository } from '../repo/worldRepository.js'
import { DocumentNotFoundError } from '../repo/types.js'
import { NOOP_LOGGER, type SaveLogger } from './logger.js'
import { SaveEngine } from './saveEngine.js'
import { FakeClock } from '../util/clock.testutil.js'

/** 백그라운드 워커가 진행하도록 남은 microtask/macrotask를 비운다. */
const barrier = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** repo 스파이 묶음 — SaveEngine에 주입할 최소 fake repo 3종. */
interface Spies {
  charUpdate: ReturnType<typeof vi.fn>
  bankUpdate: ReturnType<typeof vi.fn>
  worldUpsert: ReturnType<typeof vi.fn>
  charRepo: CharacterRepository
  bankRepo: BankRepository
  worldRepo: WorldRepository
}

function makeSpies(): Spies {
  const charUpdate = vi.fn<(id: string, patch: unknown) => Promise<void>>(() => Promise.resolve())
  const bankUpdate = vi.fn<(id: string, patch: unknown) => Promise<void>>(() => Promise.resolve())
  const worldUpsert = vi.fn<(state: unknown) => Promise<void>>(() => Promise.resolve())
  return {
    charUpdate,
    bankUpdate,
    worldUpsert,
    charRepo: { updateById: charUpdate } as unknown as CharacterRepository,
    bankRepo: { updateById: bankUpdate } as unknown as BankRepository,
    worldRepo: { upsert: worldUpsert } as unknown as WorldRepository,
  }
}

/** 즉시 resolve하는 backoff sleep(비결정적 타이밍 제거). */
const immediate = (): Promise<void> => Promise.resolve()

function makeEngine(spies: Spies, clock: FakeClock, logger: SaveLogger = NOOP_LOGGER): SaveEngine {
  return new SaveEngine(spies.charRepo, spies.bankRepo, spies.worldRepo, logger, {
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
      const engine = new SaveEngine(spies.charRepo, spies.bankRepo, spies.worldRepo, NOOP_LOGGER, {
        clock,
        intervalMs: 5_000,
        queueOptions: { sleep: immediate },
      })
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
      clock.tick() // 주기 flush — evict됐으면 drain이 비어 재-dispatch 없음
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
      // → saveNow(snap_new). tracker.evict는 이미 drain된 키라 no-op이므로, in-flight snap_old write가
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
})
