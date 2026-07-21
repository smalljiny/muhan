import type { Combatant, PlayerCombatant } from './combatant.js'
import { resolveAttack, type ResolveContext, type AttackOutcome } from './resolveAttack.js'
import { checkTargetImmunity, checkPvpGate } from './pvp.js'
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
 * 플레이어 오프너 — 개시 게이트 → resolveAttack 1회 → 적대 등록.
 *
 * defender가 크리처면 checkTargetImmunity(무적 게이트), 플레이어면 checkPvpGate(3중 게이트)를 적용한다.
 * 게이트 실패 시 resolveAttack를 호출하지 않고 사유를 반환한다. 통과 시 근접 1타를 굴린 뒤, 대상이
 * 크리처면 registerEnemy로 적대를 등록한다. 대상이 플레이어면 PlayerCombatState에 enemies[] 모델이 없어
 * 등록을 생략한다(지속 PvP 라운드는 E6a-1 범위 밖 — 오프너 1타만).
 */
export function initiateAttack(
  attacker: PlayerCombatant,
  defender: Combatant,
  ctx: InitiateContext,
): InitiateResult {
  const gate =
    defender.kind === 'creature'
      ? checkTargetImmunity({
          attacker: { class: attacker.state.class, weapon: attacker.state.weapon },
          defender: { flags: defender.instance.flags },
        })
      : checkPvpGate({
          attacker: { flags: attacker.state.flags, level: attacker.state.level },
          defender: { flags: defender.state.flags },
          room: ctx.room,
          checkWarResult: ctx.checkWarResult ?? false,
        })

  if (!gate.ok) return { ok: false, reason: gate.reason }

  // 적대 등록을 피해 해석보다 먼저 수행한다 — 오라클 순서(add_enm_crt command5.c:153 → 다중공격/피해
  // :207+)를 복원하고, 오프너 1타가 크리처를 죽였을 때 death seam이 발화된 인스턴스에 뒤늦게 등록하는
  // 기묘함을 없앤다. resolveAttack은 `enemies`를 읽지 않으므로(HP·flags·스탯·ledger만) 순서 이동은
  // 행위 불변이다.
  //
  // 대상 크리처가 공격자를 적으로 등록해 다음 틱부터 combatTick이 반격을 구동한다(add_enm_crt).
  // 대상이 플레이어(PvP)면 enemies[] 모델이 없어 등록 생략 — 오라클도 add_enm_crt를 MONSTER 분기
  // 안에만 두어 PvP 오프너는 적대를 등록하지 않으므로 이는 충실하다(지속 PvP 라운드는 범위 밖).
  //
  // 발산(#91 fidelity basket): 오라클 add_enm_crt(command5.c:153)는 MUNKIL 거부(:148) 뒤·MMGONL(:160)·
  // MENONL(:165) 거부 앞에 위치해, MMGONL/MENONL 크리처를 물리 공격하면 타격이 거부돼도 적대는 등록돼
  // 몬스터가 이후 틱에 반격한다. 포트의 checkTargetImmunity(Story 6)는 세 무적 플래그를 단일 무조건-거부
  // 게이트로 번들해 이 인터리브를 재현 못 한다 — MMGONL/MENONL 크리처는 물리 오프너에 무반응. 게이트
  // 분해(MUNKIL=pre / MMGONL·MENONL=post 등록)는 Story 6 변경이라 별도 패치.
  if (defender.kind === 'creature') registerEnemy(defender.instance, attacker.state.characterId)

  const outcome = resolveAttack(attacker, defender, ctx)

  return { ok: true, outcome, cooldownIncrement: gate.cooldownIncrement }
}
