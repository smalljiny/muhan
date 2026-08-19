import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Db } from 'mongodb'
import type { BankAccount, Character, ObjectInstance, RoomState } from 'shared'
import { SaveEngine } from './saveEngine.js'
import { NOOP_LOGGER } from './logger.js'
import { CharacterRepository } from '../repo/characterRepository.js'
import { BankRepository } from '../repo/bankRepository.js'
import { WorldRepository } from '../repo/worldRepository.js'
import { ObjectRepository } from '../repo/objectRepository.js'
import { createMongoTestDb, type MongoTestDb } from '../repo/mongoTestDb.testutil.js'
import { createMarkCharacterDirty } from '../world/markCharacterDirty.js'
import { createMarkObjectDeleted } from './markObjectDeleted.js'
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

function makeObject(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 1,
    type: 1,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 10,
    shotscur: 0,
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
  let objectRepo: ObjectRepository
  let clock: FakeClock

  function makeEngine(): SaveEngine {
    return new SaveEngine(charRepo, bankRepo, worldRepo, objectRepo, NOOP_LOGGER, {
      clock,
      queueOptions: { sleep: immediate },
    })
  }

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_save_engine_test')
    db = harness.db
    const objects = new ObjectRepository(db)
    objectRepo = objects
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
    await db.collection('objects').deleteMany({})
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

  it('CC#5 — 전체 Character 문서 스냅샷이 stripImmutableId→updateById Zod 경계를 통과해 flush된다', async () => {
    // 라이브 characters markDirty는 부분 스냅샷이 아니라 전체 문서를 싣는다(markCharacterDirty 계약).
    // 그 형태가 어댑터 경계에서 조용히 거부되면(_id immutable 에러·strict patch 거부) 봉쇄하려던
    // write-loss가 그대로 나므로, 실 Mongo·실 Zod 경계로 관통 검증한다.
    // schemaVersion은 5(현행)로 둔다 — 라이브 캐릭터는 findById의 backfill 체인을 거쳐 v5로 승격된
    // 문서이고, v4 이하면 read-path의 backfillCharacterV5가 spells·realm을 재시딩해 write 경계가 아닌
    // 읽기 승격을 검증하게 된다.
    await charRepo.insert(
      makeCharacter({ _id: 'char-1', gold: 100, currentRoom: 1, level: 1, schemaVersion: 5 }),
    )
    const engine = makeEngine()
    engine.start()

    // 실 헬퍼를 통과시켜 라이브 경로가 실제로 흘리는 스냅샷 형태 그대로 경계를 친다 — 직접 markDirty에
    // 넣으면 프로덕션이 만들 수 없는 형태(status 포함)를 검증하게 된다.
    // optional 객체 필드(buffs·statusEffects)까지 실어 patch 스키마 표면을 넓게 친다.
    const markCharacterDirty = createMarkCharacterDirty((collection, id, snapshot) =>
      engine.markDirty(collection, id, snapshot),
    )
    markCharacterDirty(
      'char-1',
      makeCharacter({
        _id: 'char-1',
        gold: 4242,
        currentRoom: 77,
        level: 9,
        experience: 5_000,
        stats: [11, 12, 13, 14, 15],
        realm: [1, 2, 3, 4],
        schemaVersion: 5,
        buffs: { 5: { until: 900 } },
        statusEffects: { poison: { until: 800, interval: 10 } },
      }),
    )
    await engine.shutdown()

    // 거부됐다면 재시도 소진 후 폐기돼 문서가 그대로 남는다 — 아래 단언이 그 실패를 잡는다.
    const persisted = await charRepo.findById('char-1')
    expect(persisted).toMatchObject({ _id: 'char-1', gold: 4242, currentRoom: 77, level: 9 })
    expect(persisted?.stats).toEqual([11, 12, 13, 14, 15])
    expect(persisted?.realm).toEqual([1, 2, 3, 4])
    expect(persisted?.buffs).toEqual({ 5: { until: 900 } })
    expect(persisted?.statusEffects).toEqual({ poison: { until: 800, interval: 10 } })
  })

  it('CC#6 — soft-delete된 문서를 라이브 스냅샷 flush가 되살리지 않는다(무덤 부활 봉쇄)', async () => {
    // 도달 경로: 계정당 다중 소켓이 허용되고 assertOwnership이 라이브 레지스트리를 조회하지 않으므로,
    // 세션 S1이 캐릭터 C로 라이브 진입한 상태에서 형제 세션 S2가 C를 삭제할 수 있다. 이후 S1의 이동·종료
    // flush가 라이브 객체의 status='active'를 실으면 무덤이 부활한다 — 스냅샷의 status 제외가 그 봉쇄다.
    await charRepo.insert(makeCharacter({ _id: 'char-1', currentRoom: 1, schemaVersion: 5 }))
    // S1이 라이브로 들고 있는 객체(삭제 전 hydrate라 여전히 active).
    const liveCharacter = makeCharacter({
      _id: 'char-1',
      currentRoom: 77,
      schemaVersion: 5,
      status: 'active',
    })
    // S2의 삭제 — status='deleted' + deletedAt 기록.
    await charRepo.softDelete('char-1')
    expect((await charRepo.findById('char-1'))?.status).toBe('deleted')

    const engine = makeEngine()
    engine.start()
    // 실 헬퍼를 통과시켜 라이브 경로가 실제로 흘리는 스냅샷 형태 그대로 flush한다.
    const markCharacterDirty = createMarkCharacterDirty((collection, id, snapshot) =>
      engine.markDirty(collection, id, snapshot),
    )
    markCharacterDirty('char-1', liveCharacter)
    await engine.shutdown()

    const persisted = await charRepo.findById('char-1')
    // 라이브가 소유한 필드는 정상 flush됐다(단언이 vacuous하지 않음을 보장하는 대조 앵커).
    expect(persisted?.currentRoom).toBe(77)
    // 무덤은 그대로다 — status·deletedAt이 되돌려지지 않았다.
    expect(persisted?.status).toBe('deleted')
    expect(persisted?.deletedAt).toBeInstanceOf(Date)
    // 재로그인 차단 불변식: 삭제 캐릭터가 계정 목록에 복귀하지 않는다.
    expect(await charRepo.findByAccount('acc-1')).toEqual([])
  })

  it('CC#7 — markObjectDeleted→flush가 실 Mongo에서 objects 문서를 삭제한다', async () => {
    // 삭제 어댑터가 실제로 deleteById에 닿는지를 실 Mongo 경계로 관통 검증한다. 스텁 spy만으로는
    // 컬렉션 키 오타·id 전달 누락이 검출되지 않는다.
    await objectRepo.insert(makeObject({ _id: 'obj-1' }))
    const engine = makeEngine()
    engine.start()

    const markObjectDeleted = createMarkObjectDeleted((collection, id, snapshot) =>
      engine.markDirty(collection, id, snapshot),
    )
    markObjectDeleted('obj-1')
    await engine.shutdown()

    expect(await objectRepo.findById('obj-1')).toBeNull()
  })

  it('CC#8 — OQ1 순서: characters 갱신이 objectDeletions 삭제보다 먼저 커밋된다(같은 flush)', async () => {
    // 연마 성공 경로의 두 write가 한 flush에 실릴 때의 시도 순서를 실 Mongo로 고정한다.
    // 순서가 뒤집히면 "책 소멸 + 주문 미학습"(유일한 실손실) 방향의 노출 창이 넓어진다.
    await charRepo.insert(makeCharacter({ _id: 'char-1', schemaVersion: 5 }))
    await objectRepo.insert(makeObject({ _id: 'obj-1' }))
    // 실 repo 메서드를 통과시키면서(spyOn 기본 동작) 커밋 순서만 기록한다.
    const committed: string[] = []
    const updateSpy = vi.spyOn(charRepo, 'updateById')
    const deleteSpy = vi.spyOn(objectRepo, 'deleteById')
    updateSpy.mockImplementation(async (id, patch) => {
      await CharacterRepository.prototype.updateById.call(charRepo, id, patch)
      committed.push('characters')
    })
    deleteSpy.mockImplementation(async (id) => {
      await ObjectRepository.prototype.deleteById.call(objectRepo, id)
      committed.push('objectDeletions')
    })

    try {
      const engine = makeEngine()
      engine.start()

      engine.markDirty('characters', 'char-1', { spells: new Array<number>(16).fill(1) })
      createMarkObjectDeleted((collection, id, snapshot) =>
        engine.markDirty(collection, id, snapshot),
      )('obj-1')
      await engine.shutdown()
    } finally {
      updateSpy.mockRestore()
      deleteSpy.mockRestore()
    }

    // 시도·커밋 순서가 markDirty 호출 순서와 같다(단일 워커 FIFO 계약).
    expect(committed).toEqual(['characters', 'objectDeletions'])
    // 두 write 모두 실제로 반영됐다 — 순서 단언이 vacuous하지 않음을 보장하는 대조 앵커.
    expect((await charRepo.findById('char-1'))?.spells[0]).toBe(1)
    expect(await objectRepo.findById('obj-1')).toBeNull()
  })

  /**
   * 완료 프로토콜(checkout→ack/discard) 전환 회귀.
   *
   * flush가 파괴적 drain에서 checkout으로 바뀌면서 스냅샷이 write 종결까지 tracker에 남는다.
   * 반납(ack/discard)이 배선되지 않으면 그 키가 inProgress에 잔류하는데, 잔류 자체는 조용해서
   * 실 Mongo 왕복으로 "다음 주기가 여전히 최신값을 쓴다"를 관통 확인한다.
   */
  it('CC#9 — 반납 후 같은 키를 재-mark하면 다음 flush가 최신값을 영속화한다', async () => {
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    const engine = makeEngine()
    engine.start()

    engine.markDirty('characters', 'char-1', { gold: 111 })
    clock.tick()
    await barrier()
    expect((await charRepo.findById('char-1'))?.gold).toBe(111)

    // 반납된 키를 다시 마킹 — 두 번째 주기도 정상 dispatch돼야 한다.
    // shutdown을 배리어로 쓴다(강제 flush + queue drain) — 실 Mongo 왕복은 setTimeout(0) 한 번으로
    // 완료가 보장되지 않아 tick+barrier 반복은 비결정적이다.
    engine.markDirty('characters', 'char-1', { gold: 222 })
    await engine.shutdown()

    expect((await charRepo.findById('char-1'))?.gold).toBe(222)
  })

  it('CC#10 — permanent 실패로 폐기된 키도 이후 flush 경로를 막지 않는다', async () => {
    const logger = { error: vi.fn() }
    const engine = new SaveEngine(charRepo, bankRepo, worldRepo, objectRepo, logger, {
      clock,
      queueOptions: { sleep: immediate },
    })
    engine.start()

    // 존재하지 않는 문서 — updateById가 DocumentNotFoundError를 던져 permanent 폐기된다.
    engine.markDirty('characters', 'ghost-1', { gold: 5 })
    clock.tick()
    await barrier()

    // 폐기 이후 주기에서도 다른 키의 write가 정상 진행된다.
    // 최종 단언은 shutdown(강제 flush + queue drain) 뒤에 둔다 — 실 Mongo 왕복은 setTimeout(0)
    // 한 번으로 완료가 보장되지 않아 tick+barrier 시점 단언은 비결정적이다.
    await charRepo.insert(makeCharacter({ _id: 'char-1', gold: 0 }))
    engine.markDirty('characters', 'char-1', { gold: 333 })
    await engine.shutdown()

    expect((await charRepo.findById('char-1'))?.gold).toBe(333)
    // 폐기는 무흔적이 아니다 — permanent 실패 1건이 정확히 1회 기록된다.
    expect(logger.error).toHaveBeenCalledTimes(1)
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
