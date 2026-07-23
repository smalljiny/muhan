import { SPELL_NO, type Character } from 'shared'
import { dice } from '../combat/dice.js'
import { hasFlag } from '../world/door.js'
import { RPMEXT } from '../world/roomFlags.js'
import { clearPoison, clearDisease, clearBlind } from '../combat/statusEffects.js'
import { CLERIC, PALADIN, INVINCIBLE } from '../combat/constants.js'
import type { Combatant } from '../combat/combatant.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import type { SpellDispatch } from './dispatch.js'

/**
 * instantEffects — G7 즉발(타이머 없는) 비-offensive effect 16주문(A6 §2·§6, magic2-8.c).
 *
 * ## 세 handler 셰이프 (핸들러 타입 이질성 — Story 6 rationale, 단일 타입 강제 금지)
 * 즉발 16주문은 데이터 홈이 셋으로 갈린다 — 억지 통일 대신 handler 타입으로 분할한다:
 *   - **report(InstantEffectHandler → InstantOutcome)**: 회복 5 + 즉발 seam 8 = 13. 회복은 hp(라이브
 *     combat)를, seam은 room/item/world를 건드리므로 실 write를 유예하고 pure-report한다(Story 8 debuff
 *     선례). 회복량은 caster 파생(int/piety/class/level/rng)이라 target hp를 읽지 않는다.
 *   - **cure(CureEffectHandler → Character)**: statusEffects 해제 3(SCUREP/SRMDIS/SRMBLD). statusEffects는
 *     Character에 영속하므로(combat Combatant엔 없음) Character→Character 순수 변환이다(buffEffects 셰이프).
 * 두 셰이프는 반환 타입이 달라 **각자 SpellDispatch 인스턴스**에 등록한다(offensive/buff/debuff 재사용 금지).
 *
 * ## 회복 = pure-report HealOutcome (hpmax 미read, in-place write 유예)
 * PlayerCombatState에 hpMax 필드가 없어 완치(hpcur=hpmax)를 amount로 환산할 수 없다 — SFHEAL은 toFull=true
 * 변형으로 보고하고(오라클 `hpcur=hpmax` 리터럴 충실), 나머지는 healed 스칼라를 보고한다. 실 hp write·hpmax
 * clamp는 소비처가 담당한다(Story 11 몬스터 self-cast는 creature.hpmax로 clamp) — combatant.ts를 건드리지 않는다.
 *
 * ## 마나 미소비 (gate.ts 소관)
 * A6 §2 마나값(vigor 2·mend 4·heal 20·rm_disease 12 …)은 시전 게이트(gate.ts S4)가 소비한다. 이 모듈은
 * effect 전용이라 caster.mpCurrent를 감소시키지 않는다(offensiveSpell·buffEffects 선례). restore의 마나
 * **회복**(mrand(1,100)<60 → mpmax)은 effect라 restoredMana로 보고한다(게이트 소비와 별개).
 *
 * ## 즉발 seam (#106 live-wiring 유예)
 * teleport/recall/summon(room 이동)·enchant/object_send(item)·track/locate_player(world query)·
 * remove_curse(item OCURSE + PFEARS)는 라이브 command/world write가 필요해 범위 밖(#106/#86)이다. effect의
 * 의도만 { kind:'seam', effect } 라벨로 보고하고 실 write를 유예한다(DebuffOutcome defer-write 선례).
 * remove_curse는 catalog cure family지만 statusEffects(poison/disease/blind) 어느 필드도 아닌 item OCURSE·
 * PFEARS를 해제하므로 cure 3(필드 해제)이 아닌 seam으로 분류한다(A6 §6 즉발, magic6.c:216).
 */

// ── 회복 결과 (pure-report) ───────────────────────────────────────────────────

/**
 * HealOutcome — 회복 pure-report. toFull=true면 완치(hpcur=hpmax, SFHEAL) — 소비처가 target hpmax로 채운다.
 * toFull=false면 healed 스칼라를 소비처가 `hp = min(hpmax, hp+healed)`로 적용한다. restoredMana(restore
 * 한정)는 마나 완전 회복(mpcur=mpmax) 발동 여부다.
 */
export type HealOutcome =
  | { readonly toFull: true; readonly restoredMana?: boolean }
  | { readonly toFull: false; readonly healed: number; readonly restoredMana?: boolean }

/**
 * InstantOutcome — report dispatch(회복 + seam) 반환. kind로 자기표현한다:
 *   - 'heal': HealOutcome(회복량·완치·마나회복).
 *   - 'seam': #106/#86 유예 즉발의 의도 라벨(teleport/recall/…/remove_curse).
 */
export type InstantOutcome =
  | { readonly kind: 'heal'; readonly heal: HealOutcome }
  | { readonly kind: 'seam'; readonly effect: SeamEffect }

/**
 * SeamEffect — 즉발 seam 8종의 의도 라벨(literal union). #106/#86 소비처가 오타 문자열에 컴파일 실패하도록
 * string이 아닌 리터럴로 좁힌다. 값은 각 오라클 함수명(teleport/recall/summon/enchant/object_send/track/
 * locate_player/remove_curse)을 그대로 쓴다.
 */
export type SeamEffect =
  | 'teleport'
  | 'recall'
  | 'summon'
  | 'enchant'
  | 'object_send'
  | 'track'
  | 'locate_player'
  | 'remove_curse'

/**
 * InstantEffectRequest — report effect 요청. 회복량은 caster·pietyBonus 파생이고 target hp를 읽지 않으나,
 * target(Combatant)은 "이 주문을 누구에게 걸었는가"의 참조로 담는다(Story 11 self-cast가 이 target에 hp를
 * 적용). pietyBonus는 Caster 6필드 계약에 없어(piety 미노출) 별도 필드로 전달한다 — 소비처가 bonusOf(piety)를
 * 사전 계산한다(offensiveSpell.casterId가 별도 필드인 선례). rpmext·굴림은 ctx(room.flags·rng)에서 읽는다.
 */
export interface InstantEffectRequest {
  readonly caster: Caster
  readonly pietyBonus: number
  readonly target: Combatant
  readonly ctx: CastContext
}

/** report effect 핸들러 형태 — spellNo를 캡처하고 요청만 받아 InstantOutcome을 반환한다. */
export type InstantEffectHandler = (req: InstantEffectRequest) => InstantOutcome

/** cure effect 핸들러 형태 — 대상 Character의 statusEffects 필드를 해제한 새 Character를 반환한다. */
export type CureEffectHandler = (character: Character) => Character

// ── 회복량 산술 (A6 §2, magic2-8.c 전사) ──────────────────────────────────────

/** L4 = trunc((level+3)/4) — 클래스 보너스·굴림 상한 스케일(오라클 `(level+3)/4` 정수 나눗셈). */
function l4Of(level: number): number {
  return Math.trunc((level + 3) / 4)
}

/**
 * vigor(SVIGOR) 회복량 — magic2.c:60-77:
 *   heal = MAX(bonus[int], bonus[piety])
 *        + (CLERIC ? L4 + mrand(1, 1+L4/2) : 0)
 *        + (PALADIN ? L4/2 + mrand(1, 1+L4/4) : 0)
 *        + mrand(1,6);
 *   RPMEXT 방이면 += mrand(1,3); 최종 MAX(1, heal).
 * 클래스 굴림은 CLERIC/PALADIN일 때만 소비된다(비-클래스는 base 1굴림). C의 `+` 피연산자 평가순서는
 * unspecified이나 각 항이 독립 additive draw라 합·roll count/range만 계약이다(순서 무관 — 재배열해도 동값).
 */
function vigorHeal(req: InstantEffectRequest): number {
  const { caster, pietyBonus, ctx } = req
  const rng = ctx.rng
  const l4 = l4Of(caster.level)
  let heal = Math.max(caster.intBonus, pietyBonus)
  if (caster.class === CLERIC) heal += l4 + rng(1, 1 + Math.trunc(l4 / 2))
  if (caster.class === PALADIN) heal += Math.trunc(l4 / 2) + rng(1, 1 + Math.trunc(l4 / 4))
  heal += rng(1, 6)
  if (hasFlag(ctx.room.flags, RPMEXT)) heal += rng(1, 3)
  return Math.max(1, heal)
}

/**
 * mend(SMENDW) 회복량 — magic2.c:502-517:
 *   heal = MAX(bonus[int], bonus[piety])
 *        + ((CLERIC || class>=INVINCIBLE) ? 2*L4 + mrand(1, 1+L4/2) : 0)
 *        + (PALADIN ? L4 + mrand(1, 1+L4/3) : 0)
 *        + dice(2,6,0);
 *   RPMEXT 방이면 += mrand(1,6)+1; 최종 MAX(1, heal). C의 `+` 피연산자 평가순서는 unspecified이나 각
 *   항이 독립 additive draw라 합·roll count/range만 계약이다(순서 무관).
 */
function mendHeal(req: InstantEffectRequest): number {
  const { caster, pietyBonus, ctx } = req
  const rng = ctx.rng
  const l4 = l4Of(caster.level)
  let heal = Math.max(caster.intBonus, pietyBonus)
  if (caster.class === CLERIC || caster.class >= INVINCIBLE) {
    heal += 2 * l4 + rng(1, 1 + Math.trunc(l4 / 2))
  }
  if (caster.class === PALADIN) heal += l4 + rng(1, 1 + Math.trunc(l4 / 3))
  heal += dice(2, 6, 0, rng)
  if (hasFlag(ctx.room.flags, RPMEXT)) heal += rng(1, 6) + 1
  return Math.max(1, heal)
}

/**
 * restore(SRESTO) 회복 — magic3.c:573-577. hp += dice(2,10,0)(clamp 소비처), 이어서 mrand(1,100)<60이면
 * 마나 완전 회복(mpcur=mpmax). 굴림 순서: dice 2굴림 → mrand(1,100) 1굴림. int/piety/클래스 보너스 없음.
 */
function restoreHeal(req: InstantEffectRequest): HealOutcome {
  const rng = req.ctx.rng
  const healed = dice(2, 10, 0, rng)
  const restoredMana = rng(1, 100) < 60
  return { toFull: false, healed, restoredMana }
}

/**
 * room_vigor(SRVIGO) 회복량 — magic8.c:52-56. heal = mrand(1,6) + bonus[piety]; RPMEXT 방이면 += mrand(1,3).
 * 오라클은 방 전체 플레이어에 이 heal을 적용한다(AOE) — per-target 회복량만 보고하고 방 fan-out은
 * 라이브 배선(#106)이 소비한다. MAX(1) 없음(오라클 미적용).
 */
function roomVigorHeal(req: InstantEffectRequest): number {
  const rng = req.ctx.rng
  let heal = rng(1, 6) + req.pietyBonus
  if (hasFlag(req.ctx.room.flags, RPMEXT)) heal += rng(1, 3)
  return heal
}

/**
 * scalarHeal — 스칼라 회복(toFull:false) 핸들러 팩토리. heal 공식 함수(vigorHeal/mendHeal/roomVigorHeal)를
 * 받아 InstantOutcome 래퍼를 씌운다. SFHEAL(toFull)·SRESTO(restoreHeal이 full HealOutcome 반환)는 팩토리
 * 대상이 아니라 그대로 등록한다.
 */
const scalarHeal =
  (fn: (req: InstantEffectRequest) => number): InstantEffectHandler =>
  (req) => ({ kind: 'heal', heal: { toFull: false, healed: fn(req) } })

/** seam — #106/#86 유예 즉발 핸들러 팩토리. effect 라벨만 다른 8개 핸들러의 반복을 순수 data로 접는다. */
const seam =
  (effect: SeamEffect): InstantEffectHandler =>
  () => ({ kind: 'seam', effect })

/**
 * REPORT_HANDLERS — report dispatch 13주문(회복 5 + 즉발 seam 8). Map 삽입순서=등록순서.
 *   회복: SVIGOR(vigor)·SMENDW(mend)·SFHEAL(완치=toFull)·SRESTO(restore)·SRVIGO(room_vigor).
 *   seam: STELEP·SRECAL·SSUMMO(이동)·SENCHA·STRANO(item)·STRACK·SLOCAT(world query)·SREMOV(remove_curse).
 */
const REPORT_HANDLERS: ReadonlyMap<number, InstantEffectHandler> = new Map<number, InstantEffectHandler>([
  [SPELL_NO.SVIGOR, scalarHeal(vigorHeal)],
  [SPELL_NO.SMENDW, scalarHeal(mendHeal)],
  [SPELL_NO.SFHEAL, () => ({ kind: 'heal', heal: { toFull: true } })],
  [SPELL_NO.SRESTO, (req) => ({ kind: 'heal', heal: restoreHeal(req) })],
  [SPELL_NO.SRVIGO, scalarHeal(roomVigorHeal)],
  [SPELL_NO.STELEP, seam('teleport')],
  [SPELL_NO.SRECAL, seam('recall')],
  [SPELL_NO.SSUMMO, seam('summon')],
  [SPELL_NO.SENCHA, seam('enchant')],
  [SPELL_NO.STRANO, seam('object_send')],
  [SPELL_NO.STRACK, seam('track')],
  [SPELL_NO.SLOCAT, seam('locate_player')],
  [SPELL_NO.SREMOV, seam('remove_curse')],
])

/**
 * CURE_HANDLERS — cure dispatch 3주문. clear 헬퍼가 곧 핸들러다(Character→Character).
 *   SCUREP(해독)→clearPoison · SRMDIS(치료)→clearDisease · SRMBLD(개안술)→clearBlind.
 */
const CURE_HANDLERS: ReadonlyMap<number, CureEffectHandler> = new Map<number, CureEffectHandler>([
  [SPELL_NO.SCUREP, clearPoison],
  [SPELL_NO.SRMDIS, clearDisease],
  [SPELL_NO.SRMBLD, clearBlind],
])

/**
 * INSTANT_SPELLS — 즉발 16주문(등록·커버리지 단일 출처). REPORT_HANDLERS(13) + CURE_HANDLERS(3) 키에서
 * 파생해 drift를 차단한다(RESIST_SPELLS·DEBUFF_SPELLS·TIMED_BUFF_SPELLS 선례). Story 7·8·9와의 union이
 * 정확히 비-offensive 36주문을 닫는다(4+6+10+16=36, disjoint — instantEffects.test.ts union 검증).
 */
export const INSTANT_SPELLS: readonly number[] = [...REPORT_HANDLERS.keys(), ...CURE_HANDLERS.keys()]

/**
 * registerInstantEffects — report 13주문(회복 + seam)을 자체 SpellDispatch 인스턴스에 등록한다
 * (Story 6 패턴, offensive/buff/debuff dispatch 재사용 금지). REPORT_HANDLERS(단일 출처)만 순회한다.
 */
export function registerInstantEffects(dispatch: SpellDispatch<InstantEffectHandler>): void {
  for (const [spellNo, handler] of REPORT_HANDLERS) {
    dispatch.register(spellNo, handler)
  }
}

/**
 * registerCureEffects — cure 3주문을 자체 SpellDispatch 인스턴스에 등록한다. 핸들러 타입(Character→
 * Character)이 report(InstantOutcome)와 달라 별도 인스턴스를 쓴다(핸들러 타입 이질성).
 */
export function registerCureEffects(dispatch: SpellDispatch<CureEffectHandler>): void {
  for (const [spellNo, handler] of CURE_HANDLERS) {
    dispatch.register(spellNo, handler)
  }
}
