import { z } from 'zod'

/**
 * 캐릭터 영속 문서 — 저장의 단일 출처.
 *
 * 자격증명·accountId·권한 인벤토리 배열을 담지 않는다. 인벤토리는 후속 스토리에서
 * object.owner(단일 소유권)로부터 파생되므로 여기에 별도 배열을 두지 않는다.
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
})

export type Character = z.infer<typeof characterSchema>
