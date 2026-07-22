/**
 * magic 배럴 — 몹·플레이어 공유 Caster 추상과 주문 디스패치의 공개 표면(#84).
 *
 * 카탈로그(SPELL_CATALOG·spellByNo·OSPELL_GRID)는 shared/magic이 소유하므로 여기서 재노출하지
 * 않는다 — server 모듈은 시전 어댑터(Caster)와 배선(SpellDispatch)만 노출한다.
 */
export { toCaster, type Caster } from './caster.js'
export { SpellDispatch, NOT_IMPLEMENTED, type NotImplemented, type ResolveResult } from './dispatch.js'
export type { CastContext } from './castContext.js'
export {
  evaluateGate,
  applyCastGate,
  type GateResult,
  type GateFailure,
  type CastRequirement,
} from './gate.js'
export { spellFail, spellFailChance, rollsSpellFail } from './spellFail.js'
