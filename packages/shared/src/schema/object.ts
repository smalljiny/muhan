import { z } from 'zod'

/**
 * 오브젝트 소유자 — 단일 소유권의 출처.
 *
 * 판별 유니온으로 소유 주체를 구조적으로 못박는다. 캐릭터 인벤토리·은행 보관은
 * 이 owner를 역참조해 파생하며, 별도의 권한 배열을 두지 않는다.
 */
export const objectOwnerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('character'), id: z.string().min(1) }),
  z.strictObject({ type: z.literal('bank'), id: z.string().min(1) }),
])

/**
 * 영속 오브젝트 인스턴스 문서 — 템플릿(objmon)이 아니라 개별 인스턴스.
 *
 * objnum은 템플릿 참조, owner는 단일 소유권. 런타임에 변하는 값(shotscur=현재 사용/충전
 * 횟수)만 인스턴스에 담고, 변하지 않는 템플릿 스탯(ndice·armor 등)은 objnum으로 조회한다.
 */
export const objectSchema = z.strictObject({
  _id: z.string().min(1),
  objnum: z.int(),
  // 오라클 type: int8 0..14.
  type: z.int().min(0).max(14),
  owner: objectOwnerSchema,
  // 착용/보관 슬롯 번호. 슬롯에 없으면 null.
  slot: z.int().nullable(),
  equipped: z.boolean(),
  value: z.int().min(0),
  // 런타임 가변 필드 — 현재 남은 사용/충전 횟수.
  shotscur: z.int(),
  schemaVersion: z.int(),
})

export type ObjectOwner = z.infer<typeof objectOwnerSchema>
export type ObjectInstance = z.infer<typeof objectSchema>
