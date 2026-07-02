import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db } from 'mongodb'
import type { RoomState } from 'shared'
import { WorldRepository } from './worldRepository.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

/** 테스트용 유효 RoomState 팩토리 — _id 없음, roomId가 자연키. */
function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 1,
    exits: [{ direction: '북', closed: false, locked: false }],
    respawn: [{ interval: 60, lastDeathTime: 0, mobId: 500 }],
    schemaVersion: 1,
    ...overrides,
  }
}

describe('WorldRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let repo: WorldRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_world_repo_test')
    db = harness.db
    repo = new WorldRepository(db)
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('roomStates').deleteMany({})
  })

  it('upsert 후 findByRoomId로 동일한 RoomState를 되돌려준다(roundtrip)', async () => {
    const state = makeRoomState()
    await repo.upsert(state)

    const found = await repo.findByRoomId(state.roomId)
    expect(found).toEqual(state)
  })

  it('반환 문서에 Mongo _id가 새어 나오지 않는다(roomStateSchema shape)', async () => {
    const state = makeRoomState({ roomId: 7 })
    await repo.upsert(state)

    const found = await repo.findByRoomId(7)
    expect(found).not.toBeNull()
    expect(found).not.toHaveProperty('_id')
  })

  it('저장 문서의 Mongo _id는 roomId(숫자)다', async () => {
    const state = makeRoomState({ roomId: 42 })
    await repo.upsert(state)

    const raw = await db.collection<{ _id: number }>('roomStates').findOne({ _id: 42 })
    expect(raw).not.toBeNull()
    expect(raw?._id).toBe(42)
  })

  it('존재하지 않는 roomId에 대해 findByRoomId는 null을 반환한다', async () => {
    const found = await repo.findByRoomId(999)
    expect(found).toBeNull()
  })

  it('upsert는 같은 roomId를 갱신한다(중복 생성 아님)', async () => {
    await repo.upsert(makeRoomState({ roomId: 3, schemaVersion: 1 }))
    await repo.upsert(makeRoomState({ roomId: 3, respawn: [], schemaVersion: 2 }))

    const found = await repo.findByRoomId(3)
    expect(found?.schemaVersion).toBe(2)
    expect(found?.respawn).toEqual([])
    const count = await db.collection<{ _id: number }>('roomStates').countDocuments({ _id: 3 })
    expect(count).toBe(1)
  })

  it('deleteByRoomId는 문서를 제거한다', async () => {
    const state = makeRoomState({ roomId: 5 })
    await repo.upsert(state)

    await repo.deleteByRoomId(5)

    const found = await repo.findByRoomId(5)
    expect(found).toBeNull()
  })

  it('잘못된 RoomState(schemaVersion 누락)는 경계 검증으로 거부된다', async () => {
    const { schemaVersion, ...partial } = makeRoomState()
    void schemaVersion
    await expect(repo.upsert(partial as RoomState)).rejects.toThrow()
  })
})
