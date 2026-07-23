import { SPELL_NO, type Character } from 'shared'
import { hasFlag } from '../world/door.js'
import { F_SET, PRFIRE, PRMAGI, PRCOLD, PSSHLD } from '../world/hexFlags.js'
import { RPMEXT } from '../world/roomFlags.js'
import { isBuffActive, computeBuffDur, grantBuff } from './spellDuration.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import type { SpellDispatch } from './dispatch.js'

/**
 * buffEffects — G5 저항 버프 effect(resistBuff family 4주문, magic5-7.c resist_fire/magic/cold·earth_shield).
 *
 * ## 범위 (Story 7 = resistBuff 4주문 {SRFIRE, SRMAGI, SRCOLD, SSSHLD})
 * 각 effect는 대상(수혜 Character)의 buffs 필드에 `{until}`을 기록하고(G4 grantBuff 소비), 활성 버프를
 * P-flag hex로 투영한다(projectResistFlags). SBRWAT(수생술)는 catalog family=buff라 Story 9 소관이며
 * 이 모듈에 포함되지 않는다(결정 요약 #1 — G5는 정확히 4주문).
 *
 * ## 저항 플래그 이중 표현 (statusEffects 투영 계약 승계)
 * 오라클은 저항을 두 곳에 쓴다: F_SET(crt, PRFIRE)(플래그) + lasttime[LT_RFIRE].interval(타이머). 이 포트의
 * Character에는 combat flags 필드가 없으므로(flags는 라이브 PlayerCombatState 소관), 타이머는 buffs `{until}`로
 * 영속하고 플래그는 projectResistFlags가 활성 버프에서 fresh hex로 투영한다 — combat/statusEffects.ts의
 * grant* + projectStatusFlags 계약을 그대로 승계한다. #84 저항 감산은 creature-only(MRMAGI intrinsic 비트)라
 * 플레이어 수혜자의 저항-read는 미배선(유예) — 이 모듈은 투영 표면만 노출한다.
 *
 * ## dur = computeBuffDur (G4 표준 공식 소비, 마나·게이트는 gate.ts 소관)
 * until = ctx.now + computeBuffDur(spellNo, {intBonus, level, casterClass, gated, rpmext}). 마나(A6 §2 =12)·
 * knowledge·spell_fail 게이트는 시전 진입(gate.ts S4)이 소유하므로 effect는 마나를 소비하지 않는다 —
 * offensiveSpell이 데미지 전용이듯 이 모듈은 effect 전용이다.
 *
 * ## 순수 함수·immutability
 * resistBuff는 입력 Character·buffs를 변형하지 않고 새 Character를 반환한다(grantBuff 위임). projectResistFlags는
 * ZERO_FLAGS에서 F_SET한 fresh hex를 반환한다(입력 불변).
 */

/** 8바이트(16자) 0 기반 flag hex. PSSHLD=38이 byte 4에 안착하도록 full-width에서 시작한다. */
const ZERO_FLAGS = '0000000000000000'

/**
 * resistBuff family 4주문 → 대응 저항 P-flag 비트(mtype.h 전사):
 *   SRFIRE(22)→PRFIRE(30, magic5.c:607) · SRMAGI(24)→PRMAGI(32, magic6.c:49) ·
 *   SRCOLD(43)→PRCOLD(36, magic7.c:49) · SSSHLD(45)→PSSHLD(38, magic7.c:252).
 */
const RESIST_FLAG_BY_SPELL: ReadonlyMap<number, number> = new Map([
  [SPELL_NO.SRFIRE, PRFIRE],
  [SPELL_NO.SRMAGI, PRMAGI],
  [SPELL_NO.SRCOLD, PRCOLD],
  [SPELL_NO.SSSHLD, PSSHLD],
])

/**
 * resistBuff family 주문번호(등록 단일 출처). RESIST_FLAG_BY_SPELL 키에서 파생해 두 구조의 drift를
 * 차단한다(Map 삽입순서=등록순서). SBRWAT는 family=buff라 미포함(Story 9).
 */
export const RESIST_SPELLS: readonly number[] = [...RESIST_FLAG_BY_SPELL.keys()]

/**
 * BuffEffectRequest — self/ally 대상 버프 effect 요청. Story 9 self-buff(fly·light·detect 등 Character에
 * buffs를 기록하는 계열)가 이 셰이프를 재사용한다. Story 8 디버프는 적 creature(CreatureInstance의
 * charmedUntil·MCHARM 등) 대상이라 Character 표현이 없어 offensive Combatant in-place 패러다임을 따르며
 * 이 셰이프를 쓰지 않는다.
 *   caster: dur 산출 입력(intBonus·level·class) 소스.
 *   target: 버프 수혜 Character(buffs 저장 대상).
 *   ctx: 시전 컨텍스트(now 틱·gated·room RPMEXT).
 */
export interface BuffEffectRequest {
  readonly caster: Caster
  readonly target: Character
  readonly ctx: CastContext
}

/** 버프 effect 핸들러 형태 — spellNo를 캡처하고 요청만 받아 새 Character를 반환한다. */
export type BuffEffectHandler = (req: BuffEffectRequest) => Character

/**
 * resistBuff — 저항 버프 effect. until = ctx.now + computeBuffDur(...)를 buffs에 기록한 새 Character를 반환한다.
 * rpmext는 시전 방 RPMEXT 플래그로 판정한다(magic5-7.c `F_ISSET(parent_rom, RPMEXT)`).
 */
export function resistBuff(req: BuffEffectRequest, spellNo: number): Character {
  const { caster, target, ctx } = req
  const dur = computeBuffDur(spellNo, {
    intBonus: caster.intBonus,
    level: caster.level,
    casterClass: caster.class,
    gated: ctx.gated,
    rpmext: hasFlag(ctx.room.flags, RPMEXT),
  })
  return grantBuff(target, spellNo, ctx.now + dur)
}

/**
 * projectResistFlags — 활성(만료 안 된) 저항 버프 → combat flag hex 뷰 투영(projectStatusFlags 승계).
 * 각 resistBuff 주문이 활성이면 대응 P-flag(PRFIRE/PRMAGI/PRCOLD/PSSHLD)를 세팅한다. 만료 버프는 제외한다.
 * 반환 hex는 F_ISSET로 판독 가능하다(#84 저항 감산 소비 관용 무파괴).
 */
export function projectResistFlags(character: Character, now: number): string {
  let hex = ZERO_FLAGS
  for (const [spellNo, bit] of RESIST_FLAG_BY_SPELL) {
    if (isBuffActive(character, spellNo, now)) hex = F_SET(hex, bit)
  }
  return hex
}

/**
 * registerResistBuffs — resistBuff family 4주문을 자체 SpellDispatch 인스턴스에 등록한다(Story 6 패턴,
 * offensiveDispatch 재사용 금지). RESIST_SPELLS(4종 단일 출처)만 순회하므로 SBRWAT는 안착하지 않는다.
 */
export function registerResistBuffs(dispatch: SpellDispatch<BuffEffectHandler>): void {
  for (const spellNo of RESIST_SPELLS) {
    dispatch.register(spellNo, (req) => resistBuff(req, spellNo))
  }
}
