import type { Collection, Db, Filter } from 'mongodb'
import { characterSchema, type Character, type ObjectInstance } from 'shared'
import { DocumentNotFoundError, type IRepository } from './types.js'
import type { ObjectRepository } from './objectRepository.js'
import {
  backfillCharacterV2,
  backfillCharacterV3,
  backfillCharacterV4,
} from './characterBackfill.js'

const COLLECTION_NAME = 'characters'

// 부분 갱신 검증 스키마 — updateById마다 재구성하지 않도록 모듈 스코프에서 1회 파생한다.
// strictObject의 .partial()은 존재 필드만 검증하고 unknown 키는 여전히 거부한다.
// status의 .default('active')는 먼저 벗긴다(accountRepository와 동일 관례): patch에 status가
// 없을 때 .partial()이라도 default가 재발화해 $set에 status:'active'가 주입되면, 무덤
// (status='deleted') 문서를 부활시키는 silent write가 된다. removeDefault로 넘긴 값만 검증한다.
const characterPatchSchema = characterSchema
  .extend({ status: characterSchema.shape.status.removeDefault() })
  .partial()

/**
 * 캐릭터 영속 저장소.
 *
 * Character의 `_id`(문자열)를 Mongo `_id`로 그대로 매핑한다. 인벤토리는 캐릭터 문서에
 * 권한 배열로 저장하지 않고, ObjectRepository.findByOwner({type:'character'})로 역참조해
 * 파생한다(hydrateInventory) — 단일 소유권의 출처는 object.owner다.
 *
 * 경계 검증: 저장(insert) 직전과 조회(findById) 직후 characterSchema.parse로 검증한다.
 *
 * 인덱스 수명주기는 이 저장소가 소유한다 — init()이 name unique 인덱스를 보장한다
 * (원본 FS 초성 샤딩을 대체하는 이름 유일성 제약).
 */
export class CharacterRepository implements IRepository<Character> {
  // 생성자 주입: Db와 ObjectRepository(인벤토리 hydration용)를 외부에서 주입받는다.
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectRepository,
  ) {}

  private get collection(): Collection<Character> {
    return this.db.collection<Character>(COLLECTION_NAME)
  }

  /**
   * name unique 인덱스와 accountId 인덱스를 보장한다. createIndex는 멱등이라 반복 호출해도 안전하다.
   * accountId 인덱스는 계정별 캐릭터 조회(findByAccount)를 위한 것이며 유일 제약이 아니다
   * (한 계정이 여러 캐릭터를 소유한다).
   */
  async init(): Promise<void> {
    await this.collection.createIndex({ name: 1 }, { unique: true })
    await this.collection.createIndex({ accountId: 1 })
  }

  /**
   * 조회 경로 공통 경계 게이트 — raw 문서를 backfill 합성 체인(V4∘V3∘V2)으로 승격한 뒤 strict parse한다.
   * V2가 v1→v2(vitals·level), V3가 v2→v3(experience), V4가 v3→v4(버전 스탬프; statusEffects는 선택)를
   * 순차 담당한다. "backfill은 parse에 선행한다" 불변식(strict parse가 hpCurrent/mpCurrent/level/experience
   * 없는 구버전 문서를 거부)을 두 load 경로가 공유하는 단일 구조로 강제한다. 신규 조회 쿼리가 backfill을
   * 누락한 채 구버전 문서를 파싱해 런타임 거부되는 사고를 이 게이트로 차단한다.
   */
  private parseCharacterDoc(doc: Record<string, unknown>): Character {
    return characterSchema.parse(
      backfillCharacterV4(backfillCharacterV3(backfillCharacterV2(doc))),
    )
  }

  async findById(id: string): Promise<Character | null> {
    const doc = await this.collection.findOne({ _id: id } as Filter<Character>)
    if (doc === null) return null
    return this.parseCharacterDoc(doc)
  }

  /**
   * 계정별 캐릭터 조회 — accountId FK로 소유 계정의 캐릭터 목록을 파생한다.
   * status='deleted'(무덤) 캐릭터는 제외한다 — 삭제된 캐릭터로 재로그인을 차단하는 불변식.
   * 조회 직후 parseCharacterDoc으로 경계 검증한다(findById와 동일 정책).
   */
  async findByAccount(accountId: string): Promise<Character[]> {
    const docs = await this.collection
      .find({ accountId, status: { $ne: 'deleted' } } as Filter<Character>)
      .toArray()
    return docs.map((doc) => this.parseCharacterDoc(doc))
  }

  async insert(doc: Character): Promise<void> {
    const validated = characterSchema.parse(doc)
    await this.collection.insertOne(validated)
  }

  async updateById(id: string, patch: Partial<Omit<Character, '_id'>>): Promise<void> {
    const validated = characterPatchSchema.parse(patch)
    // matchedCount로 판정 — 멱등 갱신(matched=1, modified=0)은 성공, 0건 매칭은 fail-loud.
    const result = await this.collection.updateOne({ _id: id }, { $set: validated })
    if (result.matchedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }

  async deleteById(id: string): Promise<void> {
    const result = await this.collection.deleteOne({ _id: id })
    if (result.deletedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, id)
  }

  /**
   * 소프트 삭제(자살/suicide) — 문서를 물리적으로 지우지 않고 무덤 상태로 표시한다.
   *
   * status='deleted' + deletedAt 세팅만 하고 문서는 보존한다. findByAccount가 status!=='deleted'로
   * 필터하므로 삭제 캐릭터로의 재로그인이 막히고(원작 SUICD 플래그 대체), findById는 여전히 문서를
   * 돌려줘 감사·복원 여지를 남긴다(하드 삭제와의 차이). 원작 command5.c suicide의 `system("mv")`
   * 무덤 이동 셸은 재현하지 않는다(주입 표면 제거). updateById를 재사용하므로 0건 매칭 시
   * DocumentNotFoundError로 fail-loud한다(존재하지 않는 캐릭터 삭제는 조용히 삼키지 않는다).
   */
  async softDelete(id: string): Promise<void> {
    await this.updateById(id, { status: 'deleted', deletedAt: new Date() })
  }

  /**
   * 캐릭터 인벤토리 뷰 — object.owner={type:'character', id}를 역참조해 소유 오브젝트를 파생한다.
   * 캐릭터 문서에 권한 배열을 두지 않는 단일 소유권 모델의 조회 경로다.
   */
  async hydrateInventory(characterId: string): Promise<ObjectInstance[]> {
    return this.objects.findByOwner({ type: 'character', id: characterId })
  }
}
