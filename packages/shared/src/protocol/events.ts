import { z } from 'zod'
import { freeTextPayloadSchema } from './payloads.js'

/**
 * 오류 코드 열거 — error 이벤트가 싣는 기계 판독용 사유의 단일 출처.
 *
 * handshake_required(핸드셰이크 전 명령 수신), unknown_type(미지 discriminator),
 * bad_payload(payload 형식 위반), internal(서버 내부 오류).
 */
export const errorCodeSchema = z.enum([
  'handshake_required',
  'unknown_type',
  'bad_payload',
  'internal',
])

/**
 * server→client 이벤트 봉투 — 판별 유니온의 단일 출처.
 *
 * top-level `type` 리터럴로 이벤트를 판별한다(objectOwnerSchema 관용구와 동일). 각 variant는
 * 리터럴 discriminator를 둔 strictObject다. debug:echo:result는 자유 텍스트 payload building block의
 * shape를 새 strictObject에 spread해 재사용하되, 리터럴 discriminator·strict를 확실히 보존한다.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  // 핸드셰이크 응답 — server가 자신의 프로토콜 버전을 실어 되돌린다.
  z.strictObject({
    type: z.literal('system:hello'),
    protocolVersion: z.int(),
  }),
  // 월드/세션 리로드 통지 — client에게 재연결·재동기를 지시한다. reason은 사람용 사유.
  z.strictObject({
    type: z.literal('system:reload'),
    reason: z.string().min(1),
  }),
  // 진단용 echo 응답 — 요청 text를 되돌린다. correlationId는 요청 id와 짝짓는 상관 키.
  z.strictObject({
    type: z.literal('debug:echo:result'),
    ...freeTextPayloadSchema.shape,
    correlationId: z.string().optional(),
  }),
  // 오류 통지 — code는 기계 판독, message는 사람용. correlationId는 유발 명령과의 상관 키.
  z.strictObject({
    type: z.literal('error'),
    code: errorCodeSchema,
    message: z.string().min(1),
    correlationId: z.string().optional(),
  }),
])

export type ErrorCode = z.infer<typeof errorCodeSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
