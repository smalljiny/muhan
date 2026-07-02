import type { Collection, Db } from 'mongodb'
import { roomStateSchema, type RoomState } from 'shared'
import { DocumentNotFoundError } from './types.js'

const COLLECTION_NAME = 'roomStates'

/**
 * 저장 문서 타입 — roomState shape에 Mongo `_id`(숫자 roomId)를 더한 것.
 *
 * RoomState 자체에는 `_id`가 없어(roomId가 자연키) Collection<RoomState>의 InferIdType이
 * ObjectId로 추론된다. 숫자 `_id`를 쓰려면 저장 문서 타입을 명시해야 한다(any 회피).
 */
type RoomStateDoc = RoomState & { _id: number }

/**
 * 방 런타임 상태 영속 저장소.
 *
 * IRepository<T>를 구현하지 않는다 — 그 계약은 문자열 `_id`를 전제하지만 roomState는
 * `_id`가 없고 roomId(숫자)가 자연키다. 따라서 roomId-키 메서드(findByRoomId·upsert·
 * deleteByRoomId)를 제공한다.
 *
 * 저장 모델: Mongo 문서 = { _id: roomId, ...roomStateShape }. roomState를 그대로 두고
 * `_id`에 roomId를 더해 저장한다(roomId 필드도 함께 남아 자연키가 문서에 중복 표현되지만
 * 조회 필터·역직렬화가 단순해진다). 조회 시 `_id`를 분리하고 나머지를 roomStateSchema.parse로
 * 경계 검증해 roomStateSchema shape(=`_id` 없음)에 맞춰 되돌린다.
 */
export class WorldRepository {
  // 생성자 주입: Db는 외부에서 주입받는다.
  constructor(private readonly db: Db) {}

  private get collection(): Collection<RoomStateDoc> {
    return this.db.collection<RoomStateDoc>(COLLECTION_NAME)
  }

  async findByRoomId(roomId: number): Promise<RoomState | null> {
    const doc = await this.collection.findOne({ _id: roomId })
    if (doc === null) return null
    // 저장 문서에서 Mongo _id를 분리하고 나머지를 경계 검증한다.
    const { _id, ...rest } = doc
    void _id
    return roomStateSchema.parse(rest)
  }

  /**
   * roomId를 키로 upsert한다. updateOne($set, upsert:true)로 삽입/갱신을 통합한다 —
   * `_id`를 $set 본문에 넣지 않아 immutable-_id 에러를 피한다.
   */
  async upsert(state: RoomState): Promise<void> {
    // 저장 경계 검증 — 유효하지 않은 방 상태를 쓰기 전에 거부한다.
    const validated = roomStateSchema.parse(state)
    await this.collection.updateOne(
      { _id: validated.roomId },
      { $set: validated },
      { upsert: true },
    )
  }

  async deleteByRoomId(roomId: number): Promise<void> {
    const result = await this.collection.deleteOne({ _id: roomId })
    if (result.deletedCount === 0) throw new DocumentNotFoundError(COLLECTION_NAME, String(roomId))
  }
}
