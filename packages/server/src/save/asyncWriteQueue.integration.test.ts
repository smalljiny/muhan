import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Db } from 'mongodb'
import type { BankAccount, Character, RoomState } from 'shared'
import {
  AsyncWriteQueue,
  type DispatchMap,
  type WriteAdapter,
} from './asyncWriteQueue.js'
import { NOOP_LOGGER } from './logger.js'
import type { DirtyEntry } from './dirtyTracker.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { BankRepository } from '../repo/bankRepository.js'
import { WorldRepository } from '../repo/worldRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'

/** backoff을 즉시 resolve하는 주입 sleep(비결정적 타이밍 제거). */
const immediate = (): Promise<void> => Promise.resolve()

function job(collection: string, id: string, snapshot: unknown): DirtyEntry {
  return { collection, id, snapshot }
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 100,
    currentRoom: 1,
    level: 1,
    hpCurrent: 55,
    mpCurrent: 40,
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  }
}

function makeBank(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    _id: 'bank-1',
    owner: 'char-1',
    gold: 1000,
    schemaVersion: 1,
    ...overrides,
  }
}

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 1,
    exits: [{ direction: '북', closed: false, locked: false }],
    respawn: [],
    schemaVersion: 1,
    ...overrides,
  }
}

describe('AsyncWriteQueue (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let charRepo: CharacterRepository
  let bankRepo: BankRepository
  let worldRepo: WorldRepository

  /** 실제 repo 메서드를 감싼 프로덕션 dispatch 맵. */
  function makeDispatch(): DispatchMap {
    return {
      characters: (id, snapshot) =>
        charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>),
      bankAccounts: (id, snapshot) =>
        bankRepo.updateById(id, snapshot as Partial<Omit<BankAccount, '_id'>>),
      roomStates: (_id, snapshot) => worldRepo.upsert(snapshot as RoomState),
    }
  }

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_async_write_queue_test')
    db = harness.db
    const objects = new ObjectRepository(db)
    charRepo = new CharacterRepository(db, objects)
    bankRepo = new BankRepository(db, objects)
    worldRepo = new WorldRepository(db)
    await objects.init()
    await charRepo.init()
    await bankRepo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('characters').deleteMany({})
    await db.collection('bankAccounts').deleteMany({})
    await db.collection('roomStates').deleteMany({})
    vi.clearAllMocks()
  })

  it('세 dispatch 경로를 실제 Mongo에 반영한다(characters·bankAccounts→updateById, roomStates→upsert)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 100 }))
    await bankRepo.insert(makeBank({ _id: 'bank-1', gold: 1000 }))

    const queue = new AsyncWriteQueue(makeDispatch(), NOOP_LOGGER, { sleep: immediate })
    const enqueues = [
      queue.enqueue(job('characters', 'char-1', { gold: 250 })),
      queue.enqueue(job('bankAccounts', 'bank-1', { gold: 7777 })),
      queue.enqueue(job('roomStates', '1', makeRoomState({ roomId: 1, schemaVersion: 3 }))),
    ]
    await queue.drain()
    await Promise.all(enqueues)

    expect((await charRepo.findById('char-1'))?.gold).toBe(250)
    expect((await bankRepo.findById('bank-1'))?.gold).toBe(7777)
    expect((await worldRepo.findByRoomId(1))?.schemaVersion).toBe(3)
  })

  it('world-state batch: 같은 roomId를 burst enqueue하면 upsert 1회로 coalesce된다', async () => {
    const upsertSpy = vi.spyOn(worldRepo, 'upsert')
    const queue = new AsyncWriteQueue(makeDispatch(), NOOP_LOGGER, { sleep: immediate })

    const enqueues = [
      queue.enqueue(job('roomStates', '9', makeRoomState({ roomId: 9, schemaVersion: 1 }))),
      queue.enqueue(job('roomStates', '9', makeRoomState({ roomId: 9, schemaVersion: 2 }))),
      queue.enqueue(job('roomStates', '9', makeRoomState({ roomId: 9, schemaVersion: 3 }))),
    ]
    await queue.drain()
    await Promise.all(enqueues)

    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect((await worldRepo.findByRoomId(9))?.schemaVersion).toBe(3)
  })

  it('같은 collection:_id 재enqueue 시 최종 write 1회, 마지막 값을 반영한다(coalescing)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const spy = vi.fn<WriteAdapter>((id, snapshot) =>
      charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>),
    )
    const queue = new AsyncWriteQueue({ characters: spy }, NOOP_LOGGER, { sleep: immediate })

    const enqueues = [
      queue.enqueue(job('characters', 'char-1', { gold: 1 })),
      queue.enqueue(job('characters', 'char-1', { gold: 2 })),
      queue.enqueue(job('characters', 'char-1', { gold: 42 })),
    ]
    await queue.drain()
    await Promise.all(enqueues)

    expect(spy).toHaveBeenCalledTimes(1)
    expect((await charRepo.findById('char-1'))?.gold).toBe(42)
  })

  it('DocumentNotFoundError(존재하지 않는 id)는 재시도하지 않고 1회만 호출한다', async () => {
    // char-1을 insert하지 않아 updateById가 matched=0 → DocumentNotFoundError를 던진다.
    const spy = vi.fn<WriteAdapter>((id, snapshot) =>
      charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>),
    )
    const logger = { error: vi.fn() }
    const queue = new AsyncWriteQueue({ characters: spy }, logger, { sleep: immediate })

    await queue.enqueue(job('characters', 'ghost', { gold: 5 }))
    await queue.drain()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('ZodError(malformed snapshot)는 실제 어댑터의 스키마 검증에서 permanent로 분류돼 재시도하지 않는다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    // 실제 repo 어댑터 경유 — updateById가 characterPatchSchema.parse에서 ZodError를 동기 throw한다.
    // (shared의 zod가 던지는 ZodError를 서버가 instanceof로 permanent 분류하는 교차 패키지 경로.)
    const adapter = vi.fn<WriteAdapter>((id, snapshot) =>
      charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>),
    )
    const logger = { error: vi.fn() }
    const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

    // 스키마에 없는 키 — strictObject.partial()이 거부해 DB 접근 전에 ZodError를 던진다.
    await queue.enqueue(job('characters', 'char-1', { notAField: 1 }))
    await queue.drain()

    expect(adapter).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    // Mongo는 미변경(검증 실패로 write 도달 못 함).
    expect((await charRepo.findById('char-1'))?.gold).toBe(0)
  })

  it('transient 에러는 재시도 후 성공하면 실제 Mongo에 write된다(2회 실패 후 성공)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    let n = 0
    const adapter = vi.fn<WriteAdapter>(async (id, snapshot) => {
      n += 1
      if (n < 3) throw new Error('일시적 write 실패')
      await charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>)
    })
    const sleep = vi.fn(() => Promise.resolve())
    const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { sleep })

    await queue.enqueue(job('characters', 'char-1', { gold: 99 }))
    await queue.drain()

    expect(adapter).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect((await charRepo.findById('char-1'))?.gold).toBe(99)
  })

  it('transient 에러가 계속되면 1+MAX_RETRIES=4회 호출 후 최종 실패로 폐기하고, Mongo는 미변경', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 7 }))
    const adapter = vi.fn<WriteAdapter>(() => Promise.reject(new Error('일시적 write 실패')))
    const logger = { error: vi.fn() }
    const queue = new AsyncWriteQueue({ characters: adapter }, logger, { sleep: immediate })

    await queue.enqueue(job('characters', 'char-1', { gold: 500 }))
    await queue.drain()

    expect(adapter).toHaveBeenCalledTimes(4)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect((await charRepo.findById('char-1'))?.gold).toBe(7)
  })

  it('capacity 초과 시 enqueue가 block해 무한 성장 없이 동작하고, 해제 후 전부 write된다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'a', name: 'a', gold: 0 }))
    await charRepo.insert(makeCharacter({ _id: 'b', name: 'b', gold: 0 }))
    await charRepo.insert(makeCharacter({ _id: 'c', name: 'c', gold: 0 }))
    await charRepo.insert(makeCharacter({ _id: 'd', name: 'd', gold: 0 }))

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = vi.fn<WriteAdapter>(async (id, snapshot) => {
      await gate
      await charRepo.updateById(id, snapshot as Partial<Omit<Character, '_id'>>)
    })
    const queue = new AsyncWriteQueue({ characters: adapter }, NOOP_LOGGER, { capacity: 2, sleep: immediate })

    const settled = { a: false, b: false, c: false, d: false }
    const eA = queue.enqueue(job('characters', 'a', { gold: 1 }))
    const eB = queue.enqueue(job('characters', 'b', { gold: 2 }))
    const eC = queue.enqueue(job('characters', 'c', { gold: 3 }))
    const eD = queue.enqueue(job('characters', 'd', { gold: 4 }))
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

    await new Promise((resolve) => setTimeout(resolve, 0))

    // a는 in-flight, b·c는 pending(capacity=2)까지 수락, d는 backpressure로 block.
    expect(settled.d).toBe(false)
    expect(queue.pendingSize).toBeLessThanOrEqual(2)

    release()
    await queue.drain()
    await Promise.all([eA, eB, eC, eD])

    expect(adapter).toHaveBeenCalledTimes(4)
    expect((await charRepo.findById('a'))?.gold).toBe(1)
    expect((await charRepo.findById('d'))?.gold).toBe(4)
    expect(queue.pendingSize).toBe(0)
  })

  it('drain()은 모든 pending write 완료를 await하고 반환 후 큐가 빈다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    await bankRepo.insert(makeBank({ _id: 'bank-1', gold: 0 }))
    const queue = new AsyncWriteQueue(makeDispatch(), NOOP_LOGGER, { sleep: immediate })

    const enqueues = [
      queue.enqueue(job('characters', 'char-1', { gold: 11 })),
      queue.enqueue(job('bankAccounts', 'bank-1', { gold: 22 })),
      queue.enqueue(job('roomStates', '2', makeRoomState({ roomId: 2 }))),
    ]
    await queue.drain()
    await Promise.all(enqueues)

    expect(queue.pendingSize).toBe(0)
    expect((await charRepo.findById('char-1'))?.gold).toBe(11)
    expect((await bankRepo.findById('bank-1'))?.gold).toBe(22)
    expect(await worldRepo.findByRoomId(2)).not.toBeNull()
  })

  it('멱등성: 동일 job을 2회 처리해도 문서 상태가 1회 처리와 동일하다(at-least-once 안전)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const queue = new AsyncWriteQueue(makeDispatch(), NOOP_LOGGER, { sleep: immediate })

    await queue.enqueue(job('characters', 'char-1', { gold: 333 }))
    await queue.drain()
    // 같은 스냅샷을 다시 처리($set·upsert 모두 멱등).
    await queue.enqueue(job('characters', 'char-1', { gold: 333 }))
    await queue.enqueue(job('roomStates', '5', makeRoomState({ roomId: 5, schemaVersion: 1 })))
    await queue.drain()
    await queue.enqueue(job('roomStates', '5', makeRoomState({ roomId: 5, schemaVersion: 1 })))
    await queue.drain()

    expect((await charRepo.findById('char-1'))?.gold).toBe(333)
    const roomCount = await db
      .collection<{ _id: number }>('roomStates')
      .countDocuments({ _id: 5 })
    expect(roomCount).toBe(1)
  })
})
