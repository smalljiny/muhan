import type { Collection, Db, Filter } from 'mongodb'
import { bankAccountSchema, type BankAccount, type ObjectInstance } from 'shared'
import type { IRepository } from './types.js'
import type { ObjectRepository } from './objectRepository.js'

const COLLECTION_NAME = 'bankAccounts'

// 부분 갱신 검증 스키마 — updateById마다 재구성하지 않도록 모듈 스코프에서 1회 파생한다.
// gold가 patch에 있으면 partial parse가 int 0..300_000_000 경계를 검증한다(불변식 6).
const bankAccountPatchSchema = bankAccountSchema.partial()

/**
 * 은행 계좌 영속 저장소.
 *
 * BankAccount의 `_id`(문자열)를 Mongo `_id`로 매핑한다. 보관 오브젝트(holdings)는 계좌
 * 문서에 배열로 저장하지 않고, ObjectRepository.findByOwner({type:'bank'})로 역참조해
 * 파생한다(hydrateHoldings). 은행 보관 오브젝트의 owner.id 관례는 은행 계좌의 `_id`다 —
 * hydrateHoldings가 bankAccountId로 조회하는 값과 저장 시 object.owner.id가 일치한다.
 *
 * Gold-integrity guard(불변식 6): 경계 스키마(gold int 0..300_000_000)가 insert와
 * updateById(partial parse) 양쪽에서 범위 밖 gold를 거부한다. 별도 임계값을 중복 정의하지
 * 않고 스키마를 단일 출처로 삼는다.
 *
 * 인덱스 수명주기는 이 저장소가 소유한다 — init()이 owner unique 인덱스(계좌 1:1)를 보장한다.
 */
export class BankRepository implements IRepository<BankAccount> {
  // 생성자 주입: Db와 ObjectRepository(holdings hydration용)를 외부에서 주입받는다.
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectRepository,
  ) {}

  private get collection(): Collection<BankAccount> {
    return this.db.collection<BankAccount>(COLLECTION_NAME)
  }

  /**
   * owner unique 인덱스를 보장한다(캐릭터당 계좌 1개). createIndex는 멱등이다.
   */
  async init(): Promise<void> {
    await this.collection.createIndex({ owner: 1 }, { unique: true })
  }

  async findById(id: string): Promise<BankAccount | null> {
    const doc = await this.collection.findOne({ _id: id } as Filter<BankAccount>)
    if (doc === null) return null
    return bankAccountSchema.parse(doc)
  }

  async insert(doc: BankAccount): Promise<void> {
    // 저장 경계 검증 — gold 범위(불변식 6) 포함 유효성을 강제한다.
    const validated = bankAccountSchema.parse(doc)
    await this.collection.insertOne(validated)
  }

  async updateById(id: string, patch: Partial<Omit<BankAccount, '_id'>>): Promise<void> {
    // 부분 갱신도 경계 검증한다 — gold가 있으면 int 0..300_000_000를 강제(불변식 6).
    const validated = bankAccountPatchSchema.parse(patch)
    await this.collection.updateOne({ _id: id }, { $set: validated })
  }

  async deleteById(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id })
  }

  /**
   * 은행 보관 오브젝트 뷰 — object.owner={type:'bank', id: bankAccountId}를 역참조한다.
   * owner.id 관례는 은행 계좌의 `_id`(bankAccountId)다.
   */
  async hydrateHoldings(bankAccountId: string): Promise<ObjectInstance[]> {
    return this.objects.findByOwner({ type: 'bank', id: bankAccountId })
  }
}
