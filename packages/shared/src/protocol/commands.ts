import { z } from 'zod'
import { freeTextPayloadSchema } from './payloads.js'

/**
 * client→server 명령 봉투 — 판별 유니온의 단일 출처.
 *
 * top-level `type` 리터럴로 명령을 판별한다(objectOwnerSchema 관용구와 동일). 각 variant는
 * 리터럴 discriminator를 둔 strictObject다. debug:echo는 자유 텍스트 payload building block의
 * shape를 새 strictObject에 spread해 재사용하되, 리터럴 discriminator·strict를 확실히 보존한다.
 */
export const clientCommandSchema = z.discriminatedUnion('type', [
  // 핸드셰이크 개시 — client가 자신이 아는 프로토콜 버전을 실어 보낸다.
  z.strictObject({
    type: z.literal('system:ready'),
    protocolVersion: z.int(),
  }),
  // 진단용 echo 요청 — text를 그대로 되돌려 받는다. id는 client가 응답을 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('debug:echo'),
    ...freeTextPayloadSchema.shape,
    id: z.string().optional(),
  }),
  // 세션 prompt 응답 — promptId가 지목한 질문에 value로 답한다. id는 응답을 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('session:reply'),
    promptId: z.string().min(1),
    value: z.string().min(1),
    id: z.string().optional(),
  }),
  // 캐릭터 선택 — characterId로 입장할 캐릭터를 지목한다. id는 응답을 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('session:selectCharacter'),
    characterId: z.string().min(1),
    id: z.string().optional(),
  }),
])

export type ClientCommand = z.infer<typeof clientCommandSchema>
