/**
 * 영속 스키마 배럴 — 다섯 도메인 문서 스키마와 z.infer 파생 타입의 단일 출처.
 *
 * 도메인 타입은 전부 z.infer로만 파생한다(수기 type/interface 병행 선언 금지).
 */
export { accountSchema, type Account } from './account.js'
export { characterSchema, type Character } from './character.js'
export {
  objectSchema,
  objectOwnerSchema,
  type ObjectInstance,
  type ObjectOwner,
} from './object.js'
export { bankAccountSchema, MAX_BANK_GOLD, type BankAccount } from './bankAccount.js'
export {
  roomStateSchema,
  exitStateSchema,
  respawnStateSchema,
  type RoomState,
  type ExitState,
  type RespawnState,
} from './roomState.js'
