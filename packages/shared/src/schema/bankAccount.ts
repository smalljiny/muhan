import { z } from 'zod'

/**
 * 은행 계좌 gold 상한(3억). 불변식 6, 오라클 은행 잔고 한도(bank.c:314 유래).
 *
 * 이 값이 불변식 6의 단일 출처다 — 스키마 `.max()`와 BankTransactionService의 CAS 가드
 * (`$lte: MAX_BANK_GOLD - amount`)가 모두 이 상수를 소비해, 상한이 두 곳에서 분열하지 않게 한다.
 */
export const MAX_BANK_GOLD = 300_000_000

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
  gold: z.int().min(0).max(MAX_BANK_GOLD),
  schemaVersion: z.int(),
})

export type BankAccount = z.infer<typeof bankAccountSchema>
