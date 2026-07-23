import { SPELL_NO } from 'shared'
import { dice } from '../combat/dice.js'
import type { Combatant } from '../combat/combatant.js'
import {
  F_ISSET,
  MPERMT,
  MNOCHA,
  MRMAGI,
  MRBEFD,
  MFEARS,
  MSILNC,
  MBLIND,
  MCHARM,
  MBEFUD,
} from '../world/hexFlags.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import type { SpellDispatch } from './dispatch.js'
import { computeDebuffDur } from './spellDuration.js'

/**
 * debuffEffects — G6 디버프 effect 6주문(fear/silence/charm/befuddle/blind/drain_exp,
 * magic3.c befuddle·magic7.c drain_exp·magic8.c blind/fear/silence/charm).
 *
 * ## 대상 = 적 creature (Combatant), offensiveSpell 패러다임 (HANDOFF A)
 * 디버프는 charm/befuddle/silence/blind/fear가 **적 CreatureInstance** 상태(MCHARM/MFEARS/… 플래그,
 * charmedUntil/befuddledUntil 타이머)에 안착한다 — 매혹된 몬스터엔 Character 표현이 없다. 따라서 이
 * 모듈은 buffEffects.ts의 Character-return BuffEffectRequest가 아니라 offensiveSpell의
 * OffensiveSpellRequest(target=Combatant) 셰이프를 미러링한다.
 *
 * ## pure-report DebuffOutcome (defer-write seam, realmGrowth 선례)
 * 핸들러는 순수 함수다 — target creature를 변형하지 않고 DebuffOutcome을 반환한다. 실 write
 * (instance.charmedUntil/befuddledUntil = now+dur, flags F_SET, experience -= loss)는 #99 라이브 조립이
 * 소비한다(offensiveSpell.realmGrowth가 성장량만 보고하고 realm write를 유예하는 것과 동형). 근거:
 * fear/silence/blind는 CreatureInstance에 대응 타이머 필드가 없고(charmedUntil/befuddledUntil만 존재),
 * charmedUntil/befuddledUntil의 라이브 writer도 아직 배선되지 않았다(autonomic이 read/scrub만 한다).
 * dur은 **상대 초**로 보고한다(ctx.now 비의존 — #99가 now+dur을 계산).
 *
 * ## dur 모델
 *   - fear/silence/charm: computeDebuffDur(G4, Story 5) 소비. 대상 MRMAGI면 함수 내부에서 dur/2
 *     (A6 §7 PRMAGI→dur/2, magic8.c). silence는 3600 고정(굴림·int 항 없음).
 *   - befuddle: computeDebuffDur가 SBEFUD에 throw하므로 **별도 계산**(HANDOFF B, magic3.c:766-778).
 *     CAST dur = bonus[int] + dice(2,6,0); 대상 MRMAGI||MRBEFD면 dur=3(단축), 아니면 MAX(5,dur).
 *     이 shortening 모델이 befuddle의 "저항 반영"이다(dur/2가 아님).
 *   - blind: dur 미부여(OpenQ #3-b — magic8.c의 dur 변수 선언·미사용 = 개안술 전까지 영구 실명).
 *     포팅 원칙(동작 충실 재현)에 따라 원본 충실(영구=타이머 없음)을 택한다. 결정을 이 주석·테스트로 고정.
 *   - drain_exp: 즉발(타이머·플래그 없음). expLoss = MIN(dice(L4,L4,1)*30, 대상 exp), L4=trunc((lvl+3)/4).
 *
 * ## 반탄·면역 (Completion Criterion 3·4)
 *   - charm: caster.level < target.level(엄격 <) 또는 MNOCHA면 완전 반탄(applied=false, 효과 미부여,
 *     magic8.c:751). 동레벨은 성공.
 *   - fear: 대상 MPERMT면 완전 면역(applied=false, magic8.c:388).
 *
 * ## 범위 밖 (deferred — offensiveSpell의 "effect는 재게이트 안 함" 분리 승계)
 *   - MUNKIL 차단(5개 오라클 함수 공통) → 타깃팅 게이트 소관.
 *   - caster-class 게이트(silence/blind class<SUB_DM·drain_exp class<DM) → gate.ts 소관.
 *   - drain_exp lower_prof(무기 숙련 감소) → 유예(경험치 감소만, Story 본문).
 *   - befuddle 2차 봉쇄(LT_SPELL=MIN(9,dur)·PLAYER LT_ATTCK) → 라이브 배선 디테일 유예.
 *   - player 대상(PvP P-flag 계열) → offensiveSpell player-resist 분기처럼 전 계열 유예(applied=false).
 */

/**
 * DebuffOutcome — pure-report. 선택 필드 존재로 자기표현한다:
 *   - applied=false: 반탄/면역/player-defer(효과 미부여).
 *   - flag: 부여할 효과 플래그 비트(fear/silence/charm/befuddle/blind). drain_exp는 없음.
 *   - dur: 타이머 상대 초(fear/silence/charm/befuddle). blind/drain_exp는 없음(타이머 미부여).
 *   - expLoss: drain_exp 경험치 감소량(그 외 없음).
 */
export interface DebuffOutcome {
  readonly applied: boolean
  readonly flag?: number
  readonly dur?: number
  readonly expLoss?: number
}

/** 디버프 effect 요청 — offensiveSpell 미러(caster=dur/loss 입력·target=Combatant creature·ctx=굴림 seam). */
export interface DebuffEffectRequest {
  readonly caster: Caster
  readonly target: Combatant
  readonly ctx: CastContext
}

/** 디버프 effect 핸들러 형태 — spellNo를 캡처하고 요청만 받아 DebuffOutcome을 반환한다. */
export type DebuffEffectHandler = (req: DebuffEffectRequest) => DebuffOutcome

/** 미부여 결과 — 반탄/면역/player-defer 공용. */
const NOT_APPLIED: DebuffOutcome = { applied: false }

/** 대상 creature가 MRMAGI(마법저항)를 보유하는지 — computeDebuffDur의 dur/2 게이트 입력(magic8.c). */
function targetHasPrmagi(target: Combatant): boolean {
  return target.kind === 'creature' && F_ISSET(target.instance.flags, MRMAGI)
}

/**
 * stdDebuffDur — fear/silence/charm 공통 dur 산출(A6 §7 표준 디버프 공식, MRMAGI면 함수 내부 dur/2).
 * 세 핸들러의 computeDebuffDur 호출 boilerplate를 묶는다. befuddle(shortening)·blind(타이머 없음)·
 * drain_exp(즉발)는 별도 dur 경로라 이 헬퍼를 쓰지 않는다.
 *
 * 호출자는 roll-then-guard 순서를 지켜 이 헬퍼를 MPERMT/level/MNOCHA 가드보다 **앞에서** 호출한다 —
 * 오라클이 dur mrand를 반탄/면역 판정 前 최상단에서 소비하기 때문이다.
 */
function stdDebuffDur(req: DebuffEffectRequest, spellNo: number): number {
  return computeDebuffDur(
    spellNo,
    { intBonus: req.caster.intBonus, targetHasPrmagi: targetHasPrmagi(req.target) },
    req.ctx.rng,
  )
}

/**
 * fear — SFEARS dur(MRMAGI면 함수 내부 dur/2) + MFEARS 플래그. 대상 MPERMT면 완전 면역(applied=false).
 *
 * ## 굴림 순서 (roll-then-guard, magic8.c + offensiveSpell 선례)
 * 오라클은 `dur = 600 + mrand(1,30)*10 + …`을 함수 최상단에서 **무조건** 굴린다(대상 판정·MPERMT 면역
 * 前). 즉 MPERMT 면역이어도 mrand 굴림은 소비된다. 이 포트도 dur을 먼저 굴린 뒤 MPERMT 가드를 적용해
 * 굴림 소비 수를 오라클과 일치시킨다 — offensiveSpell의 dice→(hp<1 no-op) roll-then-guard와 동형.
 */
function fearEffect(req: DebuffEffectRequest): DebuffOutcome {
  const { target } = req
  if (target.kind !== 'creature') return NOT_APPLIED
  const dur = stdDebuffDur(req, SPELL_NO.SFEARS)
  if (F_ISSET(target.instance.flags, MPERMT)) return NOT_APPLIED
  return { applied: true, flag: MFEARS, dur }
}

/** silence — SSILNC dur(3600 고정·MRMAGI면 dur/2) + MSILNC 플래그. */
function silenceEffect(req: DebuffEffectRequest): DebuffOutcome {
  if (req.target.kind !== 'creature') return NOT_APPLIED
  const dur = stdDebuffDur(req, SPELL_NO.SSILNC)
  return { applied: true, flag: MSILNC, dur }
}

/**
 * charm — caster.level<target.level(엄격 <) 또는 MNOCHA면 완전 반탄, 아니면 SCHARM dur + MCHARM 플래그.
 *
 * ## 굴림 순서 (roll-then-guard, magic8.c + offensiveSpell 선례)
 * 오라클은 `dur = 300 + mrand(1,30)*10 + …`을 반탄 판정 前 최상단에서 굴린다 — 반탄되어도 mrand 굴림은
 * 소비된다. fear와 동일하게 dur을 먼저 굴린 뒤 반탄 가드를 적용해 굴림 소비 수를 오라클과 일치시킨다.
 */
function charmEffect(req: DebuffEffectRequest): DebuffOutcome {
  const { caster, target } = req
  if (target.kind !== 'creature') return NOT_APPLIED
  const dur = stdDebuffDur(req, SPELL_NO.SCHARM)
  if (caster.level < target.instance.level || F_ISSET(target.instance.flags, MNOCHA)) {
    return NOT_APPLIED
  }
  return { applied: true, flag: MCHARM, dur }
}

/**
 * befuddle — HANDOFF B shortening 모델(computeDebuffDur 미사용, magic3.c:766-778).
 * CAST dur = bonus[int] + dice(2,6,0); dice는 저항 여부와 무관하게 굴린다. 대상 MRMAGI||MRBEFD면
 * dur=3(단축), 아니면 dur=MAX(5,dur). MBEFUD 플래그 부여.
 */
function befuddleEffect(req: DebuffEffectRequest): DebuffOutcome {
  const { caster, target, ctx } = req
  if (target.kind !== 'creature') return NOT_APPLIED
  let dur = caster.intBonus + dice(2, 6, 0, ctx.rng)
  if (F_ISSET(target.instance.flags, MRMAGI) || F_ISSET(target.instance.flags, MRBEFD)) {
    dur = 3
  } else {
    dur = Math.max(5, dur)
  }
  return { applied: true, flag: MBEFUD, dur }
}

/**
 * blind — MBLIND 플래그만 부여하고 타이머를 걸지 않는다(OpenQ #3-b, magic8.c dur 미사용).
 * 원본 충실: 개안술(rm_blind, Story 10)로 명시 해제하기 전까지 영구 실명. dur 필드 미부여.
 */
function blindEffect(req: DebuffEffectRequest): DebuffOutcome {
  if (req.target.kind !== 'creature') return NOT_APPLIED
  return { applied: true, flag: MBLIND }
}

/**
 * drain_exp — 즉발(타이머·플래그 없음). expLoss = MIN(dice(L4,L4,1)*30, 대상 exp), L4=trunc((lvl+3)/4)
 * (magic7.c:490). 대상 experience는 선택 필드라 ?? 0(offensiveSpell 선례). 실 experience write는 #99 seam.
 */
function drainExpEffect(req: DebuffEffectRequest): DebuffOutcome {
  const { caster, target, ctx } = req
  if (target.kind !== 'creature') return NOT_APPLIED
  const l4 = Math.trunc((caster.level + 3) / 4)
  const raw = dice(l4, l4, 1, ctx.rng) * 30
  const expLoss = Math.min(raw, target.instance.experience ?? 0)
  return { applied: true, expLoss }
}

/**
 * DEBUFF_HANDLERS — debuff family 정확히 6주문 {SBEFUD, SDREXP, SFEARS, SBLIND, SSILNC, SCHARM}
 * (결정 요약 #2 — curse/SCURSE는 catalog 미등록이라 제외). Map 삽입순서=등록순서.
 */
const DEBUFF_HANDLERS: ReadonlyMap<number, DebuffEffectHandler> = new Map([
  [SPELL_NO.SFEARS, fearEffect],
  [SPELL_NO.SSILNC, silenceEffect],
  [SPELL_NO.SCHARM, charmEffect],
  [SPELL_NO.SBEFUD, befuddleEffect],
  [SPELL_NO.SBLIND, blindEffect],
  [SPELL_NO.SDREXP, drainExpEffect],
])

/** debuff family 주문번호(등록 단일 출처) — DEBUFF_HANDLERS 키에서 파생해 drift를 차단한다. */
export const DEBUFF_SPELLS: readonly number[] = [...DEBUFF_HANDLERS.keys()]

/**
 * registerDebuffs — debuff family 6주문을 자체 SpellDispatch 인스턴스에 등록한다(Story 6 패턴,
 * offensive/buff dispatch 재사용 금지 — 핸들러 타입 이질성). DEBUFF_HANDLERS(6종 단일 출처)만 순회한다.
 */
export function registerDebuffs(dispatch: SpellDispatch<DebuffEffectHandler>): void {
  for (const [spellNo, handler] of DEBUFF_HANDLERS) {
    dispatch.register(spellNo, handler)
  }
}
