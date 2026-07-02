import { z } from 'zod'

/**
 * 은행 계좌 영속 문서.
 *
 * gold 상한 3억(오라클 은행 잔고 한도). 권한 holdings 배열을 두지 않는다 —
 * 은행 보관 오브젝트는 object.owner={type:'bank'}로 역참조해 파생한다.
 */
export const bankAccountSchema = z.strictObject({
  _id: z.string().min(1),
  // 소유 캐릭터 id.
  owner: z.string().min(1),
  gold: z.int().min(0).max(300_000_000),
  schemaVersion: z.int(),
})

export type BankAccount = z.infer<typeof bankAccountSchema>
