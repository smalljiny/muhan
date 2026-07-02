import type { Collection, Db, Filter } from 'mongodb'
import { characterSchema, type Character, type ObjectInstance } from 'shared'
import type { IRepository } from './types.js'
import type { ObjectRepository } from './objectRepository.js'

const COLLECTION_NAME = 'characters'

// 부분 갱신 검증 스키마 — updateById마다 재구성하지 않도록 모듈 스코프에서 1회 파생한다.
// strictObject의 .partial()은 존재 필드만 검증하고 unknown 키는 여전히 거부한다.
const characterPatchSchema = characterSchema.partial()

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
   * name unique 인덱스를 보장한다. createIndex는 멱등이라 반복 호출해도 안전하다.
   */
  async init(): Promise<void> {
    await this.collection.createIndex({ name: 1 }, { unique: true })
  }

  async findById(id: string): Promise<Character | null> {
    const doc = await this.collection.findOne({ _id: id } as Filter<Character>)
    if (doc === null) return null
    return characterSchema.parse(doc)
  }

  async insert(doc: Character): Promise<void> {
    const validated = characterSchema.parse(doc)
    await this.collection.insertOne(validated)
  }

  async updateById(id: string, patch: Partial<Omit<Character, '_id'>>): Promise<void> {
    const validated = characterPatchSchema.parse(patch)
    await this.collection.updateOne({ _id: id }, { $set: validated })
  }

  async deleteById(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id })
  }

  /**
   * 캐릭터 인벤토리 뷰 — object.owner={type:'character', id}를 역참조해 소유 오브젝트를 파생한다.
   * 캐릭터 문서에 권한 배열을 두지 않는 단일 소유권 모델의 조회 경로다.
   */
  async hydrateInventory(characterId: string): Promise<ObjectInstance[]> {
    return this.objects.findByOwner({ type: 'character', id: characterId })
  }
}
