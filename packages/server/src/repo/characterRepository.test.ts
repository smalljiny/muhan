import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db, Filter } from 'mongodb'
import { neededExp, type Character, type ObjectInstance } from 'shared'
import { CharacterRepository } from './characterRepository.js'
import { seedVitals } from './characterBackfill.js'
import { ObjectRepository } from './objectRepository.js'
import { DocumentNotFoundError } from './types.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

/** raw v1 문서 직접 주입용 컬렉션 스키마 — 문자열 _id를 강제하고 임의 필드를 허용한다. */
type RawCharacterDoc = { _id: string } & Record<string, unknown>

/** 테스트용 유효 Character 팩토리 — 스키마 shape를 정확히 만족한다. */
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
    // CURRENT 버전으로 시딩해 findById roundtrip이 backfill passthrough가 되게 한다.
    schemaVersion: 5,
    // 계정 링크 FK(Story 1로 필수화)와 soft-delete 상태 기본값.
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

/** 테스트용 유효 ObjectInstance 팩토리. */
function makeObject(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: 3,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 50,
    shotscur: 0,
    schemaVersion: 1,
    ...overrides,
  }
}

describe('CharacterRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let objects: ObjectRepository
  let repo: CharacterRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_character_repo_test')
    db = harness.db
    // unique 인덱스는 mongod 수명 동안 1회만 만들면 된다(deleteMany는 인덱스를 지우지 않는다).
    objects = new ObjectRepository(db)
    repo = new CharacterRepository(db, objects)
    await objects.init()
    await repo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('characters').deleteMany({})
    await db.collection('objects').deleteMany({})
  })

  it('insert 후 findById로 동일한 Character를 되돌려준다(roundtrip)', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found).toEqual(doc)
  })

  it('존재하지 않는 id에 대해 findById는 null을 반환한다', async () => {
    const found = await repo.findById('does-not-exist')
    expect(found).toBeNull()
  })

  it('updateById는 저장된 문서를 갱신한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await repo.updateById(doc._id, { gold: 250, currentRoom: 5 })

    const found = await repo.findById(doc._id)
    expect(found?.gold).toBe(250)
    expect(found?.currentRoom).toBe(5)
  })

  it('updateById는 유효하지 않은 부분 패치(gold 음수)를 경계 검증으로 거부한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await expect(repo.updateById(doc._id, { gold: -1 })).rejects.toThrow()
  })

  it('updateById는 status를 담지 않은 패치가 status default를 재주입하지 않는다 (무덤 부활 방지)', async () => {
    // 무덤(status='deleted') 문서에 status를 뺀 부분 패치를 적용한다. characterSchema.status에
    // 걸린 .default('active')가 patch 검증에서 재발화하면 $set에 status:'active'가 섞여 무덤이
    // 부활한다(silent lost-write). removeDefault 파생 패치 스키마가 이를 막는지 고정한다.
    const doc = makeCharacter({ status: 'deleted', deletedAt: new Date() })
    await repo.insert(doc)

    await repo.updateById(doc._id, { gold: 999 })

    const found = await repo.findById(doc._id)
    expect(found?.gold).toBe(999)
    // 핵심 단언: status가 건드려지지 않아 여전히 'deleted'다(수정 전이면 'active'로 부활).
    expect(found?.status).toBe('deleted')
    expect(found?.deletedAt).toBeInstanceOf(Date)
  })

  it('deleteById는 문서를 제거한다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    await repo.deleteById(doc._id)

    const found = await repo.findById(doc._id)
    expect(found).toBeNull()
  })

  it('잘못된 문서(name 빈 문자열)는 경계 검증으로 거부한다', async () => {
    const invalid = makeCharacter({ name: '' })
    await expect(repo.insert(invalid)).rejects.toThrow()
  })

  it('hydrateInventory는 캐릭터가 소유한 오브젝트만 반환한다', async () => {
    const char = makeCharacter({ _id: 'char-A' })
    await repo.insert(char)

    const owned1 = makeObject({ _id: 'o1', owner: { type: 'character', id: 'char-A' } })
    const owned2 = makeObject({ _id: 'o2', owner: { type: 'character', id: 'char-A' } })
    const other = makeObject({ _id: 'o3', owner: { type: 'character', id: 'char-B' } })
    const banked = makeObject({ _id: 'o4', owner: { type: 'bank', id: 'char-A' } })
    await objects.insert(owned1)
    await objects.insert(owned2)
    await objects.insert(other)
    await objects.insert(banked)

    const inventory = await repo.hydrateInventory('char-A')
    expect(inventory.map((o) => o._id).sort()).toEqual(['o1', 'o2'])
  })

  it('캐릭터 문서에는 권한 인벤토리 배열이 저장되지 않는다', async () => {
    const doc = makeCharacter()
    await repo.insert(doc)

    const raw = await db.collection<Character>('characters').findOne({ _id: doc._id } as Filter<Character>)
    expect(raw).not.toBeNull()
    expect(raw).not.toHaveProperty('inventory')
    expect(raw).not.toHaveProperty('items')
  })

  it('name unique 인덱스: 같은 name의 두 번째 캐릭터 insert는 거부된다', async () => {
    // _id는 다르게, name만 동일하게 — 실패가 name 인덱스에서 나야 한다(_id 충돌 아님).
    await repo.insert(makeCharacter({ _id: 'char-x', name: '중복이름' }))
    await expect(repo.insert(makeCharacter({ _id: 'char-y', name: '중복이름' }))).rejects.toThrow()
  })

  it('accountId는 insert→findById 왕복에서 보존된다', async () => {
    const doc = makeCharacter({ _id: 'char-acc', accountId: 'acc-42' })
    await repo.insert(doc)

    const found = await repo.findById(doc._id)
    expect(found?.accountId).toBe('acc-42')
  })

  it('findByAccount는 해당 계정의 삭제되지 않은 캐릭터만 반환한다', async () => {
    await repo.insert(makeCharacter({ _id: 'c1', name: '가', accountId: 'acc-1' }))
    await repo.insert(makeCharacter({ _id: 'c2', name: '나', accountId: 'acc-1' }))
    await repo.insert(makeCharacter({ _id: 'c3', name: '다', accountId: 'acc-2' }))

    const result = await repo.findByAccount('acc-1')
    expect(result.map((c) => c._id).sort()).toEqual(['c1', 'c2'])
  })

  it("findByAccount는 status='deleted' 캐릭터(무덤)를 제외한다", async () => {
    await repo.insert(makeCharacter({ _id: 'live', name: '살아있음', accountId: 'acc-9' }))
    await repo.insert(
      makeCharacter({
        _id: 'dead',
        name: '무덤',
        accountId: 'acc-9',
        status: 'deleted',
        deletedAt: new Date(),
      }),
    )

    const result = await repo.findByAccount('acc-9')
    expect(result.map((c) => c._id)).toEqual(['live'])
  })

  it('findByAccount는 캐릭터가 없는 계정에 대해 빈 배열을 반환한다', async () => {
    const result = await repo.findByAccount('acc-empty')
    expect(result).toEqual([])
  })

  it('init()은 name unique 인덱스와 accountId 인덱스를 모두 보장한다', async () => {
    const indexes = await db.collection('characters').indexes()
    const keys = indexes.map((idx) => JSON.stringify(idx.key))
    expect(keys).toContain(JSON.stringify({ name: 1 }))
    expect(keys).toContain(JSON.stringify({ accountId: 1 }))
    const nameIndex = indexes.find((idx) => JSON.stringify(idx.key) === JSON.stringify({ name: 1 }))
    expect(nameIndex?.unique).toBe(true)
  })

  it('존재하지 않는 id updateById는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.updateById('missing', { gold: 10 })).rejects.toThrow(DocumentNotFoundError)
  })

  it('softDelete는 문서를 물리 보존하되 status=deleted+deletedAt로 표시하고 findByAccount에서 제외한다 (양방향 무덤)', async () => {
    const doc = makeCharacter({ _id: 'sd1', name: '자살자', accountId: 'acc-sd' })
    await repo.insert(doc)

    await repo.softDelete(doc._id)

    // 물리 존재 측: findById는 여전히 문서를 돌려주되 status=deleted + deletedAt 세팅(하드 삭제와 구별).
    const found = await repo.findById(doc._id)
    expect(found).not.toBeNull()
    expect(found?.status).toBe('deleted')
    expect(found?.deletedAt).toBeInstanceOf(Date)
    // 논리 부재 측: findByAccount는 무덤 캐릭터를 제외한다(재로그인 차단 불변식).
    const list = await repo.findByAccount('acc-sd')
    expect(list.map((c) => c._id)).not.toContain('sd1')
  })

  it('존재하지 않는 id softDelete는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.softDelete('missing')).rejects.toThrow(DocumentNotFoundError)
  })

  it('존재하지 않는 id deleteById는 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.deleteById('missing')).rejects.toThrow(DocumentNotFoundError)
  })

  it('findById는 vitals·experience·spells 없는 v1 문서를 backfill 체인(V5∘V4∘V3∘V2)으로 승격해 parse 통과시킨다', async () => {
    // repo.insert는 최신 스키마로 거부하므로 untyped 컬렉션에 raw v1 문서를 직접 주입한다.
    await db.collection<RawCharacterDoc>('characters').insertOne({
      _id: 'v1-load',
      name: '옛전사',
      class: 3,
      race: 2,
      stats: [10, 10, 10, 10, 10],
      gold: 100,
      currentRoom: 1,
      schemaVersion: 1,
      accountId: 'acc-v1',
      status: 'active',
    })

    const found = await repo.findById('v1-load')
    expect(found).not.toBeNull()
    expect(found?.level).toBe(1)
    expect(found?.hpCurrent).toBe(seedVitals(3, 1).hpCurrent)
    expect(found?.mpCurrent).toBe(seedVitals(3, 1).mpCurrent)
    // V3 스텝: level=1이라 experience 0으로 시딩. V5 스텝: 빈 spell store 시딩 + 최신 버전(5)으로 스탬프.
    expect(found?.experience).toBe(0)
    expect(found?.spells).toEqual(new Array<number>(16).fill(0))
    expect(found?.realm).toEqual([0, 0, 0, 0])
    expect(found?.schemaVersion).toBe(5)
  })

  it('findByAccount도 v1 문서를 backfill로 승격해 반환한다 (parse 이전 승격)', async () => {
    await db.collection<RawCharacterDoc>('characters').insertOne({
      _id: 'v1-acc',
      name: '옛사제',
      class: 4,
      race: 1,
      stats: [10, 10, 10, 10, 10],
      gold: 100,
      currentRoom: 1,
      schemaVersion: 1,
      accountId: 'acc-v1b',
      status: 'active',
    })

    const list = await repo.findByAccount('acc-v1b')
    expect(list).toHaveLength(1)
    expect(list[0]?.hpCurrent).toBe(seedVitals(4, 1).hpCurrent)
    expect(list[0]?.level).toBe(1)
    expect(list[0]?.experience).toBe(0)
    expect(list[0]?.schemaVersion).toBe(5)
  })

  it('★판별: level=50 v2 문서를 load하면 level·vitals를 보존하고 experience를 정합 시딩한다', async () => {
    // 실데이터는 전부 level 1이라 level>1 문서라야 마이그레이션 클로버(level=1 리셋·vitals 재시딩)가
    // 드러난다. V2 가드/스탬프가 CURRENT(3)에 매이면 이 v2 문서가 V2로 흘러 level=1로 클로버된다.
    await db.collection<RawCharacterDoc>('characters').insertOne({
      _id: 'v2-lv50',
      name: '고렙전사',
      class: 3,
      race: 2,
      stats: [10, 10, 10, 10, 10],
      gold: 100,
      currentRoom: 1,
      hpCurrent: 777,
      mpCurrent: 333,
      level: 50,
      schemaVersion: 2,
      accountId: 'acc-v2',
      status: 'active',
    })

    const found = await repo.findById('v2-lv50')
    expect(found?.level).toBe(50) // 보존 — 1로 클로버 금지
    expect(found?.hpCurrent).toBe(777) // vitals 재시딩 금지
    expect(found?.mpCurrent).toBe(333)
    expect(found?.experience).toBe(neededExp(49)) // level L 도달 최소 누적 = neededExp(L-1)
    expect(found?.schemaVersion).toBe(5)
  })

  it('v3 문서를 load하면 V4·V5가 schemaVersion=5로 스탬프하되 기존 필드는 보존한다 (statusEffects 미시딩)', async () => {
    // statusEffects·buffs는 선택 필드라 미시딩. V4는 버전만 3→4, V5는 spells·realm 시딩 + 4→5.
    // vitals·level·experience는 불변.
    await db.collection<RawCharacterDoc>('characters').insertOne({
      _id: 'v3-load',
      name: '삼세대',
      class: 3,
      race: 2,
      stats: [10, 10, 10, 10, 10],
      gold: 100,
      currentRoom: 1,
      hpCurrent: 60,
      mpCurrent: 45,
      level: 12,
      experience: 34567,
      schemaVersion: 3,
      accountId: 'acc-v3',
      status: 'active',
    })

    const found = await repo.findById('v3-load')
    expect(found?.schemaVersion).toBe(5)
    expect(found?.level).toBe(12)
    expect(found?.hpCurrent).toBe(60)
    expect(found?.experience).toBe(34567)
    expect(found?.statusEffects).toBeUndefined()
    expect(found?.buffs).toBeUndefined()
    expect(found?.spells).toEqual(new Array<number>(16).fill(0))
  })
})
