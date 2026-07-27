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

/**
 * 채팅 자유 텍스트 필드의 프로토콜 계층 상한(문자 수) — 인바운드 명령(chat:message·chat:emote)과
 * 아웃바운드 전파 봉투(chat:said)가 공유하는 단일 출처. 프레임 상한(MAX_FRAME_BYTES)은 프레임 전체만
 * 막으므로, 채널로 전파되는 채팅 필드는 필드 단위로도 상한을 둔다(DoS 방어 floor). 한 곳에 두어
 * 인바운드·아웃바운드 상한이 구조적으로 같음을 보장한다 — E4/E7가 채널별 정책으로 더 좁힐 수 있다.
 */
export const CHAT_TEXT_MAX = 512
export const CHAT_TARGET_MAX = 64

export type NoArgsPayload = z.infer<typeof noArgsPayloadSchema>
export type TargetOrdinalPayload = z.infer<typeof targetOrdinalPayloadSchema>
export type TargetSecondaryPayload = z.infer<typeof targetSecondaryPayloadSchema>
export type FreeTextPayload = z.infer<typeof freeTextPayloadSchema>
