import type { Collection, Db, Filter } from 'mongodb'
import { accountSchema, type Account } from 'shared'
import { DocumentNotFoundError } from './types.js'

const COLLECTION_NAME = 'accounts'

// role·status 값 검증 스키마 — 스키마 shape에서 default를 벗겨 파생한다(단일 출처 유지).
// accountSchema.partial()을 쓰면 안 되는 이유: role/status에 걸린 .default가 patch에 없는
// 필드에도 재적용돼 $set이 반대 필드를 기본값으로 덮어쓴다(예: setStatus가 role을 'player'로
// 되돌리는 silent lost-write). removeDefault로 default를 제거해 넘긴 값만 검증한다.
const roleSchema = accountSchema.shape.role.removeDefault()
const statusSchema = accountSchema.shape.status.removeDefault()

/** upsert 입력 — 최초 인증 시점에 확보 가능한 자연키(_id=Firebase UID)와 선택적 email만 받는다. */
export type AccountUpsertInput = {
  _id: string
  email?: string
}

/**
 * 계정 영속 저장소.
 *
 * Account의 `_id`(Firebase UID 문자열)를 Mongo `_id`로 그대로 매핑한다. 최초 인증 시
 * upsert로 account를 승격하고(role=player·status=active), 이후 권한 변경은 updateRole·
 * setStatus가 담당한다.
 *
 * 경계 검증: upsert 반환 직후·findById 직후 accountSchema.parse로, 부분 갱신(updateRole·
 * setStatus)은 default를 벗긴 roleSchema·statusSchema.parse로 검증한다.
 */
export class AccountRepository {
  // 생성자 주입: Db만 외부에서 주입받는다(서비스 로케이터·전역 싱글턴 미사용).
  constructor(private readonly db: Db) {}

  private get collection(): Collection<Account> {
    return this.db.collection<Account>(COLLECTION_NAME)
  }

  /**
   * accounts 인덱스 수명주기를 보장한다. createIndex는 멱등이라 반복 호출해도 안전하다.
   *
   * _id가 Firebase UID 자연키이므로 Mongo가 _id에 유일 인덱스를 자동 보장한다 —
   * 별도 unique 인덱스는 불필요하다. email 인덱스는 소비자(로그인 조회 경로)로 미룬다.
   */
  async init(): Promise<void> {
    // 자연키(_id) 유일성은 Mongo 기본 _id 인덱스로 충족되므로 여기서 만들 인덱스가 없다.
  }

  /**
   * 최초 인증 시 account 승격 경로. 존재하지 않으면 defaults로 생성하고, 이미 있으면
   * role·status·createdAt을 보존한다($setOnInsert는 insert 때만 기록되므로 멱등).
   */
  async upsert(input: AccountUpsertInput): Promise<Account> {
    // $setOnInsert에 insert 시 accountSchema를 만족할 모든 필드를 담는다. email은 주어졌을 때만.
    const setOnInsert: Partial<Account> = {
      role: 'player',
      status: 'active',
      createdAt: new Date(),
      ...(input.email !== undefined ? { email: input.email } : {}),
    }
    const doc = await this.collection.findOneAndUpdate(
      { _id: input._id },
      { $setOnInsert: setOnInsert },
      { upsert: true, returnDocument: 'after' },
    )
    // upsert+returnDocument:'after'는 항상 문서를 돌려주지만 드라이버 타입은 nullable이다.
    if (doc === null) throw new DocumentNotFoundError(COLLECTION_NAME, input._id)
    return accountSchema.parse(doc)
  }

  async findById(id: string): Promise<Account | null> {
    const doc = await this.collection.findOne({ _id: id } as Filter<Account>)
    if (doc === null) return null
    return accountSchema.parse(doc)
  }

  async updateRole(id: string, role: Account['role']): Promise<void> {
    const patch = { role: roleSchema.parse(role) }
    const result = await this.collection.updateOne({ _id: id }, { $set: patch })
    if (result.matchedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }

  // status='banned'를 기록하는 저장 경로는 여기 있으나, 연결 게이트(validateSessionCookie·
  // gameAuthPreValidation)는 아직 banned를 강제하지 않는다 — ban을 세팅하는 admin 명령이 A13
  // (RBAC 명령 배선)로 유예됐기 때문이다. A13에서 ban 명령을 붙일 때 validateSessionCookie에
  // 접속 시점 banned 거부(또는 주기적 검사)를 함께 추가한다(assertRole defer와 동일 선). 지금은
  // 어떤 경로도 banned를 세팅하지 않아 트리거 불가한 잠복 갭이다.
  async setStatus(id: string, status: Account['status']): Promise<void> {
    const patch = { status: statusSchema.parse(status) }
    const result = await this.collection.updateOne({ _id: id }, { $set: patch })
    if (result.matchedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }
}
