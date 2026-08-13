import type { Collection, Db, Filter } from 'mongodb'
import { objectSchema, type ObjectInstance, type ObjectOwner } from 'shared'
import { DocumentNotFoundError, type IRepository } from './types.js'

const COLLECTION_NAME = 'objects'

// 부분 갱신 검증 스키마 — updateById 호출마다 재구성하지 않도록 모듈 스코프에서 1회 파생한다.
// strictObject의 .partial()은 존재 필드만 검증하고 unknown 키는 여전히 거부한다.
const objectPatchSchema = objectSchema.partial()

/**
 * 영속 오브젝트 인스턴스 저장소.
 *
 * ObjectInstance의 `_id`(합성 문자열)를 Mongo `_id`로 그대로 매핑한다 — 별도 매핑 계층
 * 없이 Mongo 문서가 곧 ObjectInstance다. 단일 소유권은 `owner`(discriminated union)로
 * 표현하며, `findByOwner`가 이를 역참조해 소유 집합을 조회한다.
 *
 * 경계 검증: 저장(insert) 직전과 조회(findById·findByOwner) 직후 objectSchema.parse로
 * 검증한다. 손상된 DB 문서가 조용히 새어 나가지 않고 시끄럽게 드러나게 한다.
 *
 * 인덱스 수명주기는 이 저장소가 소유한다 — init()이 owner 복합 인덱스를 보장한다.
 */
export class ObjectRepository implements IRepository<ObjectInstance> {
  // 생성자 주입: Db는 외부에서 주입받는다(전역·서비스 로케이터 미사용).
  constructor(private readonly db: Db) {}

  private get collection(): Collection<ObjectInstance> {
    return this.db.collection<ObjectInstance>(COLLECTION_NAME)
  }

  /**
   * owner 복합 인덱스를 보장한다. createIndex는 멱등이라 반복 호출해도 안전하다.
   * 인덱스 수명주기를 저장소가 자체 소유한다.
   *
   * `_id`를 뒤에 붙이는 이유는 `findByOwner`의 `sort({ _id: 1 })`을 인덱스가 그대로 제공하게
   * 하기 위해서다 — 없으면 IXSCAN 뒤에 blocking in-memory SORT 스테이지가 붙는다.
   *
   * 구 인덱스 `{owner.type, owner.id}`는 신 인덱스의 순수 prefix라 잉여지만 **여기서 드롭하지
   * 않는다**. 부팅 경로의 `dropIndex`는 (a) 롤링 배포 중 구버전 인스턴스가 다시 만들고 신버전이
   * 다시 지우는 thrash를 만들고, (b) 컬렉션 락을 잡는 DDL을 부팅 임계 경로에 두며, (c) 오퍼레이터가
   * 진단용으로 만든 인덱스를 조용히 지운다. 정리는 1회성 마이그레이션 소관이다.
   */
  async init(): Promise<void> {
    await this.collection.createIndex({ 'owner.type': 1, 'owner.id': 1, _id: 1 })
  }

  async findById(id: string): Promise<ObjectInstance | null> {
    const doc = await this.collection.findOne({ _id: id } as Filter<ObjectInstance>)
    if (doc === null) return null
    // 조회 경계 검증 — 손상 문서를 즉시 드러낸다.
    return objectSchema.parse(doc)
  }

  /**
   * 소유 오브젝트 집합을 `_id` 오름차순으로 조회한다.
   *
   * 이 정렬은 인벤 서수(`비법서 2 연마`)의 **계약**이다. 근거·오라클 divergence는
   * `world/liveCharacterEntry.ts` 헤더가 단독으로 소유한다.
   */
  async findByOwner(owner: ObjectOwner): Promise<ObjectInstance[]> {
    // dot-notation 필터: discriminated union에 대한 Filter<T> 타이핑이 dotted path를
    // 좁게 추론하지 못해 경계에서 narrow하게 캐스팅한다(any 아님).
    const filter = {
      'owner.type': owner.type,
      'owner.id': owner.id,
    } as Filter<ObjectInstance>
    const docs = await this.collection.find(filter).sort({ _id: 1 }).toArray()
    return docs.map((doc) => objectSchema.parse(doc))
  }

  async insert(doc: ObjectInstance): Promise<void> {
    // 저장 경계 검증 — 유효하지 않은 문서를 쓰기 전에 거부한다. 입력은 변형하지 않는다.
    const validated = objectSchema.parse(doc)
    // _id가 string으로 선언돼 InferIdType이 string으로 좁혀지므로 캐스팅 없이 삽입된다.
    await this.collection.insertOne(validated)
  }

  async updateById(id: string, patch: Partial<Omit<ObjectInstance, '_id'>>): Promise<void> {
    // 부분 갱신도 경계 검증한다($set 전체 필드 교체 시맨틱과 정합).
    const validated = objectPatchSchema.parse(patch)
    const result = await this.collection.updateOne({ _id: id }, { $set: validated })
    // matchedCount(NOT modifiedCount)로 판정 — 멱등 갱신(matched=1, modified=0)은 성공이다.
    if (result.matchedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }

  async deleteById(id: string): Promise<void> {
    const result = await this.collection.deleteOne({ _id: id })
    if (result.deletedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }
}
