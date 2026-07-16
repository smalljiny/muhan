import { z } from 'zod'

/**
 * 계정 영속 문서 — 인증 주체의 단일 출처.
 *
 * _id는 Firebase UID(외부 인증 발급 자연키)다. 한 계정이 여러 캐릭터를 소유하며,
 * 캐릭터는 accountId로 이 문서를 역참조한다. 자격증명(비밀번호 해시 등)은 여기에 담지
 * 않는다 — 인증은 Firebase가 소유하고, 이 문서는 role·status 등 게임 측 권한 상태만 담는다.
 */
export const accountSchema = z.strictObject({
  // Firebase UID(외부 인증 발급 자연키).
  _id: z.string().min(1),
  email: z.email().optional(),
  // 권한 등급 — player < builder < dm < admin (Story 9 rank 순서).
  role: z.enum(['player', 'builder', 'dm', 'admin']).default('player'),
  status: z.enum(['active', 'banned']).default('active'),
  createdAt: z.coerce.date(),
})

export type Account = z.infer<typeof accountSchema>
