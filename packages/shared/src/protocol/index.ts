/**
 * 와이어 프로토콜 배럴 — 봉투·payload Zod 계약과 z.infer 파생 타입의 단일 출처.
 *
 * 영속 스키마(schema/)와 별개 모듈이다. 모든 프로토콜 타입은 z.infer로만 파생하며,
 * DOM 전역(Event·Command)과 충돌하지 않도록 ClientCommand·ServerEvent로 한정 명명한다.
 */
export {
  noArgsPayloadSchema,
  targetOrdinalPayloadSchema,
  targetSecondaryPayloadSchema,
  freeTextPayloadSchema,
  type NoArgsPayload,
  type TargetOrdinalPayload,
  type TargetSecondaryPayload,
  type FreeTextPayload,
} from './payloads.js'
export { clientCommandSchema, type ClientCommand } from './commands.js'
export { serverEventSchema, errorCodeSchema, type ServerEvent, type ErrorCode } from './events.js'
export { PROTOCOL_VERSION } from './version.js'
