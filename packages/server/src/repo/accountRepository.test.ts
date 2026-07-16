import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Db, Filter } from 'mongodb'
import { accountSchema, type Account } from 'shared'
import { AccountRepository } from './accountRepository.js'
import { DocumentNotFoundError } from './types.js'
import { createMongoTestDb, type MongoTestDb } from './mongoTestDb.testutil.js'

describe('AccountRepository (integration)', () => {
  let harness: MongoTestDb
  let db: Db
  let repo: AccountRepository

  beforeAll(async () => {
    harness = await createMongoTestDb('muhan_account_repo_test')
    db = harness.db
    repo = new AccountRepository(db)
    await repo.init()
  }, 60_000)

  afterAll(async () => {
    await harness.cleanup()
  })

  beforeEach(async () => {
    await db.collection('accounts').deleteMany({})
  })

  it('upsert는 최초 인증 시 role=player·status=active로 계정을 생성한다', async () => {
    const account = await repo.upsert({ _id: 'uid-1' })

    expect(account._id).toBe('uid-1')
    expect(account.role).toBe('player')
    expect(account.status).toBe('active')
    expect(account.createdAt).toBeInstanceOf(Date)
  })

  it('upsert는 멱등하다: 재호출 시 이미 갱신된 role/status/createdAt을 되돌리지 않는다', async () => {
    const first = await repo.upsert({ _id: 'uid-2' })
    // 계정을 승격시킨 뒤 재-upsert해도 $setOnInsert는 insert 때만 쓰이므로 승격이 유지돼야 한다.
    await repo.updateRole('uid-2', 'admin')
    await repo.setStatus('uid-2', 'banned')

    const second = await repo.upsert({ _id: 'uid-2' })

    expect(second.role).toBe('admin')
    expect(second.status).toBe('banned')
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime())
  })

  it('upsert에 email을 주면 저장되고, 주지 않으면 email 필드가 없다', async () => {
    const withEmail = await repo.upsert({ _id: 'uid-3', email: 'a@example.com' })
    expect(withEmail.email).toBe('a@example.com')

    const withoutEmail = await repo.upsert({ _id: 'uid-4' })
    expect(withoutEmail.email).toBeUndefined()

    const rawNoEmail = await db
      .collection<Account>('accounts')
      .findOne({ _id: 'uid-4' } as Filter<Account>)
    expect(rawNoEmail).not.toBeNull()
    expect(rawNoEmail).not.toHaveProperty('email')
  })

  it('findById는 upsert된 계정을 반환하고, 없는 id에는 null을 반환한다', async () => {
    await repo.upsert({ _id: 'uid-5', email: 'b@example.com' })

    const found = await repo.findById('uid-5')
    expect(found?._id).toBe('uid-5')
    expect(found?.email).toBe('b@example.com')

    const missing = await repo.findById('does-not-exist')
    expect(missing).toBeNull()
  })

  it('updateRole은 role을 변경하고 createdAt·status는 보존한다', async () => {
    const created = await repo.upsert({ _id: 'uid-6' })

    await repo.updateRole('uid-6', 'builder')

    const found = await repo.findById('uid-6')
    expect(found?.role).toBe('builder')
    // 부분 패치가 defaults를 재적용해 다른 필드를 덮어쓰지 않아야 한다(silent lost-write 방지).
    expect(found?.status).toBe('active')
    expect(found?.createdAt.getTime()).toBe(created.createdAt.getTime())
  })

  it('setStatus는 status를 변경하고 createdAt·role은 보존한다', async () => {
    await repo.upsert({ _id: 'uid-7' })
    await repo.updateRole('uid-7', 'dm')
    const promoted = await repo.findById('uid-7')

    await repo.setStatus('uid-7', 'banned')

    const found = await repo.findById('uid-7')
    expect(found?.status).toBe('banned')
    expect(found?.role).toBe('dm')
    expect(found?.createdAt.getTime()).toBe(promoted?.createdAt.getTime())
  })

  it('updateRole은 없는 id에 대해 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.updateRole('missing', 'admin')).rejects.toThrow(DocumentNotFoundError)
  })

  it('setStatus는 없는 id에 대해 DocumentNotFoundError를 던진다', async () => {
    await expect(repo.setStatus('missing', 'banned')).rejects.toThrow(DocumentNotFoundError)
  })

  it('경계 검증: upsert가 반환한 문서는 accountSchema를 만족한다', async () => {
    const account = await repo.upsert({ _id: 'uid-8', email: 'c@example.com' })
    expect(accountSchema.safeParse(account).success).toBe(true)
  })

  it('런타임 가드: enum 밖 role/status 값은 write 전에 거부한다(방어심층)', async () => {
    await repo.upsert({ _id: 'uid-9' })
    // 타입 캐스트로 우회한 잘못된 값이 DB에 도달하기 전에 parse 단계에서 던져지는지 확인한다.
    await expect(
      repo.updateRole('uid-9', 'superuser' as Account['role']),
    ).rejects.toThrow()
    await expect(
      repo.setStatus('uid-9', 'frozen' as Account['status']),
    ).rejects.toThrow()
    // 잘못된 write가 삼켜지지 않았으므로 문서는 upsert 기본값을 유지한다.
    const account = await repo.findById('uid-9')
    expect(account?.role).toBe('player')
    expect(account?.status).toBe('active')
  })
})
