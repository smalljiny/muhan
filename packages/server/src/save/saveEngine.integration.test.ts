import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Db } from 'mongodb'
import type { BankAccount, Character, RoomState } from 'shared'
import { SaveEngine } from './saveEngine.js'
import { NOOP_LOGGER } from './logger.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { BankRepository } from '../repo/bankRepository.js'
import { WorldRepository } from '../repo/worldRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { FakeClock } from '../util/clock.testutil.js'

/** 즉시 resolve backoff sleep. */
const immediate = (): Promise<void> => Promise.resolve()
/** 백그라운드 워커 진행용 배리어. */
const barrier = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

describe('SaveEngine (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let charRepo: CharacterRepository
  let bankRepo: BankRepository
  let worldRepo: WorldRepository
  let clock: FakeClock

  function makeEngine(): SaveEngine {
    return new SaveEngine(charRepo, bankRepo, worldRepo, NOOP_LOGGER, {
      clock,
      queueOptions: { sleep: immediate },
    })
  }

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_save_engine_test')
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
    clock = new FakeClock()
    vi.clearAllMocks()
  })

  it('CC#1 — saveNow가 repo write를 await하고 반환 시점에 문서가 실제 갱신돼 있다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 100 }))
    const engine = makeEngine()

    await engine.saveNow('characters', 'char-1', { gold: 777 }, 'logout')

    // 어떤 tick·drain도 없이, saveNow 반환 직후 Mongo가 갱신돼 있어야 한다(fire-and-forget 아님).
    expect((await charRepo.findById('char-1'))?.gold).toBe(777)
  })

  it('CC#2 — evict: markDirty(old)→saveNow(new)→주기 flush 후 Mongo가 new를 유지한다(stale 덮어쓰기 봉쇄)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const engine = makeEngine()

    engine.markDirty('characters', 'char-1', { gold: 1 }) // stale
    await engine.saveNow('characters', 'char-1', { gold: 999 }, 'logout') // 최신 즉시 write + evict

    engine.start()
    clock.tick() // 주기 flush — evict됐으면 stale을 drain하지 못한다
    await barrier()

    expect((await charRepo.findById('char-1'))?.gold).toBe(999)
  })

  it('CC#3 — shutdown이 남은 dirty를 강제 flush하고 queue를 drain해 종료 전 모두 영속화한다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    await bankRepo.insert(makeBank({ _id: 'bank-1', gold: 0 }))
    const engine = makeEngine()
    engine.start()

    engine.markDirty('characters', 'char-1', { gold: 250 })
    engine.markDirty('bankAccounts', 'bank-1', { gold: 8888 })
    engine.markDirty('roomStates', '3', makeRoomState({ roomId: 3, schemaVersion: 5 }))

    await engine.shutdown()

    expect((await charRepo.findById('char-1'))?.gold).toBe(250)
    expect((await bankRepo.findById('bank-1'))?.gold).toBe(8888)
    expect((await worldRepo.findByRoomId(3))?.schemaVersion).toBe(5)
  })

  it('CC#4 — shutdown 직전 markDirty된 엔티티도 종료 전 영속화된다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const engine = makeEngine()
    engine.start()

    // 주기 tick 없이 곧바로 shutdown — 직전 mark가 shutdown 강제 flush로 잡혀야 한다.
    engine.markDirty('characters', 'char-1', { gold: 4242 })
    await engine.shutdown()

    expect((await charRepo.findById('char-1'))?.gold).toBe(4242)
  })

  it('shutdown 후 남은 pending이 없다(drain 완료)', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const engine = makeEngine()
    engine.start()
    engine.markDirty('characters', 'char-1', { gold: 1 })

    await engine.shutdown()

    // shutdown 후 추가 tick은 아무것도 dispatch하지 않는다(scheduler 정지 + tracker 비움).
    clock.tick()
    await barrier()
    expect((await charRepo.findById('char-1'))?.gold).toBe(1)
  })
})
