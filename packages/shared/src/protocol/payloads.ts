import { z } from 'zod'

/**
 * 명령 인자 패턴 building block — 와이어 명령 payload의 단일 출처.
 *
 * 무한의 명령 어휘는 인자 구조로 4가지 패턴에 수렴한다. 각 패턴을 독립 스키마로 못박아
 * command 봉투가 재사용하게 한다. 다단 대화(prompt/response) payload는 T2 경계이므로 여기 두지 않는다.
 */

/** (a) 무인자 — 대상·텍스트 없이 동작만 발동하는 명령(예: 둘러보기). */
export const noArgsPayloadSchema = z.strictObject({})

/** (b) 대상 + 서수 — 같은 이름의 대상이 여럿일 때 ordinal로 n번째를 지목한다(생략 시 첫 번째). */
export const targetOrdinalPayloadSchema = z.strictObject({
  target: z.string().min(1),
  ordinal: z.int().optional(),
})

/** (c) 대상 + 보조 대상 — 두 대상을 엮는 명령(예: 상자에 열쇠 사용). */
export const targetSecondaryPayloadSchema = z.strictObject({
  target: z.string().min(1),
  secondary: z.string().min(1),
})

/** (d) 자유 텍스트 — 임의 문자열 한 덩어리를 싣는 명령(예: 말하기·echo). */
export const freeTextPayloadSchema = z.strictObject({
  text: z.string().min(1),
})

export type NoArgsPayload = z.infer<typeof noArgsPayloadSchema>
export type TargetOrdinalPayload = z.infer<typeof targetOrdinalPayloadSchema>
export type TargetSecondaryPayload = z.infer<typeof targetSecondaryPayloadSchema>
export type FreeTextPayload = z.infer<typeof freeTextPayloadSchema>
