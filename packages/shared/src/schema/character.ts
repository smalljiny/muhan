import { z } from 'zod'

/**
 * 캐릭터 영속 문서 — 저장의 단일 출처.
 *
 * accountId로 소유 계정(account 문서)을 역참조한다(다대일 FK). 자격증명·권한 인벤토리
 * 배열은 담지 않는다 — 인벤토리는 object.owner(단일 소유권)로부터 파생되므로 여기에 별도
 * 배열을 두지 않고, 인증 자격증명은 account/Firebase가 소유한다.
 * status·deletedAt은 soft-delete 상태를 담는다(하드 삭제 없이 'deleted'로 표시).
 */
export const characterSchema = z.strictObject({
  _id: z.string().min(1),
  name: z.string().min(1),
  class: z.int(),
  race: z.int(),
  // 능력치 5종 고정 튜플 (오라클 순서 유지).
  stats: z.tuple([z.int(), z.int(), z.int(), z.int(), z.int()]),
  gold: z.int().min(0),
  // 현재 방 번호(자연키). data/world 방 로드 경로 번호와 동일 체계.
  currentRoom: z.int().min(0),
  schemaVersion: z.int(),
  // 소유 계정 id(account._id = Firebase UID)로의 필수 FK.
  accountId: z.string().min(1),
  // soft-delete 상태. 삭제 시 'deleted'로 표시하고 문서는 보존한다.
  status: z.enum(['active', 'deleted']).default('active'),
  // soft-delete 시각. active 문서에는 없다(선택).
  deletedAt: z.coerce.date().optional(),
})

export type Character = z.infer<typeof characterSchema>
