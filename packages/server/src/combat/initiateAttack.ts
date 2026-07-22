import type { Combatant, PlayerCombatant } from './combatant.js'
import { resolveAttack, fireDeath, type ResolveContext, type AttackOutcome } from './resolveAttack.js'
import { checkTargetImmunityPre, checkTargetImmunityPost, checkPvpGate } from './pvp.js'
import { registerEnemy } from './enmity.js'

/**
 * initiateAttack — 플레이어 오프너의 오라클 충실 이식(command5.c attack_crt 진입부 :146-209).
 *
 * 오프너 = 개시 게이트(Story 6) → resolveAttack 1회(Story 5/8) → 적대 등록(Story 7)의 순수 합성이다.
 * 자체 스탯/피해/게이트 재구현 없이 세 하위 모듈을 소비한다. 게이트가 막으면 resolveAttack를 호출하지
 * 않고, 통과하면 근접 1타를 굴린 뒤 대상 크리처가 공격자를 적으로 등록한다(다음 틱부터 combatTick 반격
 * 구동, add_enm_crt).
 *
 * attacker를 PlayerCombatant로 타입 고정한다 — 오라클 attack 명령은 플레이어 전용이고, 몬스터 개시는
 * combatTick 경로다. WS 명령 파싱·라우팅·권한·attacker LT_ATTCK 타이머 세팅은 범위 밖이다. 게이트가
 * 계산한 쿨다운 증분(무적 0·PvP +3)은 cooldownIncrement로만 표면화하며, 실 타이머 세팅은 WS 명령
 * 계층 소관이다. 소비자는 combatTick 반격과 동일한 베이스(`ATTACK_COOLDOWN_INTERVAL`, 실명이면
 * `ATTACK_COOLDOWN_BLIND`)에 이 증분을 더해 `nextAttackAt`을 세팅한다(`now + base + cooldownIncrement`).
 */

/** 오프너 컨텍스트 — resolveAttack 컨텍스트에 PvP check_war 판정 seam을 얹는다. */
export interface InitiateContext extends ResolveContext {
  /** PvP 게이트 check_war 판정 결과(주입 seam). defender가 플레이어일 때만 소비. 기본 false. */
  readonly checkWarResult?: boolean
}

/** 오프너 결과 — 성공이면 공격 결과·쿨다운 증분, 게이트 실패면 사유. */
export type InitiateResult =
  | { readonly ok: true; readonly outcome: AttackOutcome; readonly cooldownIncrement: number }
  | { readonly ok: false; readonly reason: string }

/**
 * 플레이어 오프너 — 개시 게이트 → resolveAttack 1회 → death 발화(fire-free ripple) → 적대 등록.
 *
 * defender가 크리처면 무적 게이트를 pre/post 2단계로 적용한다(Story 10 T10.3): MUNKIL(pre)은 registerEnemy
 * 전에 거부(aggro 미등록), MMGONL/MENONL(post)은 registerEnemy 후에 거부(aggro 등록·물리 공격만 실패).
 * defender가 플레이어면 checkPvpGate(3중 게이트)를 적용한다. 게이트 통과 시 근접 1타를 굴린다.
 *
 * ★ T10.1 ripple: resolveAttack가 fire-free가 되면서(Story 10) 오프너 킬의 death 발화 책임이 여기로
 * 이양됐다 — `if(outcome.died) fireDeath`를 직접 호출하지 않으면 오프너 킬이 loot/exp/death를 silently
 * 드롭한다. 단타 semantics는 관측상 즉시 발화로 동일하다(오라클 die() 후 return).
 */
export function initiateAttack(
  attacker: PlayerCombatant,
  defender: Combatant,
  ctx: InitiateContext,
): InitiateResult {
  // PvP 경로(플레이어 defender) — 3중 게이트만 적용, 적대 등록 없음. 오라클도 add_enm_crt를 MONSTER
  // 분기 안에만 두어 PvP 오프너는 적대를 등록하지 않는다(지속 PvP 라운드는 범위 밖 — 오프너 1타만).
  if (defender.kind === 'player') {
    const gate = checkPvpGate({
      attacker: { flags: attacker.state.flags, level: attacker.state.level },
      defender: { flags: defender.state.flags },
      room: ctx.room,
      checkWarResult: ctx.checkWarResult ?? false,
    })
    if (!gate.ok) return { ok: false, reason: gate.reason }

    const outcome = resolveAttack(attacker, defender, ctx)
    if (outcome.died) fireDeath(defender, ctx) // T10.1 ripple — fire-free 이양.
    return { ok: true, outcome, cooldownIncrement: gate.cooldownIncrement }
  }

  // 크리처 경로 — 무적 게이트 2단계 분해(T10.3).
  //
  // pre-단계(MUNKIL): registerEnemy 전에 거부한다 — 절대 해칠 수 없는 대상은 aggro조차 등록하지 않는다
  // (오라클 command5.c:146, add_enm_crt(:153) 이전).
  const pre = checkTargetImmunityPre({ defender: { flags: defender.instance.flags } })
  if (!pre.ok) return { ok: false, reason: pre.reason }

  // 적대 등록을 피해 해석보다 먼저 수행한다 — 오라클 순서(add_enm_crt command5.c:153 → 다중공격/피해
  // :207+)를 복원한다. resolveAttack은 `enemies`를 읽지 않으므로(HP·flags·스탯·ledger만) 순서 이동은
  // 행위 불변이다. 대상 크리처가 공격자를 적으로 등록해 다음 틱부터 combatTick이 반격을 구동한다.
  registerEnemy(defender.instance, attacker.state.characterId)

  // post-단계(MMGONL/MENONL): registerEnemy 후에 거부한다 — 오라클 add_enm_crt(:153)가 MMGONL(:160)·
  // MENONL(:167) 거부 앞이라, MMGONL/MENONL 크리처를 물리 공격하면 타격은 거부돼도 aggro는 등록돼
  // 몬스터가 이후 틱에 반격한다(criterion 3). Story 6의 단일 번들 게이트가 못 하던 인터리브를 재현한다.
  const post = checkTargetImmunityPost({
    attacker: { class: attacker.state.class, weapon: attacker.state.weapon },
    defender: { flags: defender.instance.flags },
  })
  if (!post.ok) return { ok: false, reason: post.reason }

  const outcome = resolveAttack(attacker, defender, ctx)
  if (outcome.died) fireDeath(defender, ctx) // T10.1 ripple — 오프너 킬 death 발화.
  return { ok: true, outcome, cooldownIncrement: post.cooldownIncrement }
}
