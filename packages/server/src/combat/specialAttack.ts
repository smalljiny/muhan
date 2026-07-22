import type { CreatureInstance } from 'shared'
import { dice, type CombatRng } from './dice.js'
import {
  F_ISSET,
  MPOISS,
  MBRETH,
  MBRWP1,
  MBRWP2,
  MENEDR,
  MDISEA,
  MDISIT,
  MBLNDR,
  PRFIRE,
  PRCOLD,
} from '../world/hexFlags.js'

/**
 * specialAttack — 몬스터 특수공격 6종(브레스·에너지드레인·독·질병·실명·장비용해)의 오라클 확률
 * 게이트·효과를 재현하는 순수 함수 이식(update.c:387~480, 플랜 Story 4).
 *
 * 순수 함수 seam: 전역 상태·Date.now·Math.random 없이 모든 굴림을 ctx.rng(주입 CombatRng)로만 굴리고,
 * defender를 변형하지 않으며 effect 서술(marker) 객체를 새로 반환한다. 라이브 defender status·
 * AttackOutcome 표면화는 Story 9(resolveAttack 배선) 소관이다.
 *
 * byte-fidelity 함정:
 *   - `(lv+3)/4`는 C 정수 나눗셈이라 Math.trunc로 브레스/드레인 주사위 개수 q를 산출한다.
 *   - rng 소비 순서는 오라클 if 단축평가를 재현한다 — 플래그가 세팅됐을 때만 해당 게이트 rng를 굴린다.
 *     순서: MBRETH 게이트 → (발동 시 브레스 dice) / (else 분기면 MENEDR 게이트 → 발동 시 드레인 dice) →
 *     MPOISS → MDISEA → MBLNDR → MDISIT. 이 순서를 Story 9 배선에서도 보존한다.
 *   - breath와 energy-drain은 상호배제(XOR)다 — 브레스가 발동하면 else 분기에 진입하지 않아 MENEDR을
 *     굴리지 않는다.
 *   - status는 boolean 마커만 반환한다(Story 3 grant 헬퍼는 Character/statusEffects 타입이라 여기 적용
 *     대상이 아니다). MDISIT 장비용해·lower_prof는 굴림만 하고 효과는 미이식(Non-goal)이다.
 */

/** 특수공격 시전자 — 레벨스케일 주사위 q·특수공격 M-flag 판독에 필요한 최소 필드(CreatureInstance 부분집합). */
export type SpecialAttacker = Pick<CreatureInstance, 'level' | 'flags'>

/** 방어자 최소 인터페이스 — 브레스 반감용 저항 P-flag(PRCOLD/PRFIRE)와 exp드레인 흡수 상한. */
export interface SpecialAttackDefender {
  /** 저항 P-flag 판독용 hex flags(PRCOLD/PRFIRE). */
  readonly flags: string
  /** 에너지드레인 흡수 상한 — 흡수량은 이 값을 넘지 못한다(update.c). */
  readonly experience: number
}

/** rng seam만 담는 최소 컨텍스트(ResolveContext 전체를 요구하지 않는다). */
export interface SpecialAttackContext {
  readonly rng: CombatRng
}

/** 브레스 4타입 식별자 — MBRWP1/MBRWP2 2비트 조합의 결과. */
export type BreathType = 'spit' | 'gas' | 'cold' | 'fire'

/**
 * 특수공격 결과 marker — defender를 변형하지 않는 effect 서술이다. 라이브 적용(status 부여·exp 차감·
 * 장비용해)은 Story 9가 이 마커를 읽어 수행한다.
 */
export interface SpecialAttackResult {
  /** 브레스 발동 시 데미지, 미발동이면 null. */
  readonly breathDamage: number | null
  /** 브레스 타입, 미발동이면 null. */
  readonly breathType: BreathType | null
  /** 에너지드레인 흡수량(0=미발동 또는 흡수 불가). */
  readonly expDrain: number
  /** 독 부여 마커(gas 브레스 또는 MPOISS 게이트). */
  readonly poison: boolean
  /** 질병 부여 마커(MDISEA 게이트). */
  readonly disease: boolean
  /** 실명 부여 마커(MBLNDR 게이트). */
  readonly blind: boolean
  /** MDISIT 장비용해 성공 굴림 마커(효과는 Story 9/유예). */
  readonly dissolveItemRolled: boolean
}

/**
 * 브레스 4타입 데미지 산출 — MBRWP1/MBRWP2 2비트로 분기한다(update.c). q는 레벨스케일 주사위 개수.
 * 냉기/화염은 defender 저항 P-flag(PRCOLD/PRFIRE)면 주사위 면수를 반감(4→2)한다.
 */
function breathHit(
  b1: boolean,
  b2: boolean,
  q: number,
  defenderFlags: string,
  rng: CombatRng,
): { type: BreathType; damage: number; poison: boolean } {
  if (b1 && !b2) return { type: 'spit', damage: dice(q, 3, 0, rng), poison: false }
  if (b1 && b2) return { type: 'gas', damage: dice(q, 2, 1, rng), poison: true }
  if (!b1 && b2) {
    const s = F_ISSET(defenderFlags, PRCOLD) ? 2 : 4
    return { type: 'cold', damage: dice(q, s, 0, rng), poison: false }
  }
  const s = F_ISSET(defenderFlags, PRFIRE) ? 2 : 4
  return { type: 'fire', damage: dice(q, s, 0, rng), poison: false }
}

/**
 * 몬스터 특수공격 해석 — 오라클 게이트 순서·임계를 재현해 effect 마커를 반환한다. 입력 미변형.
 */
export function resolveSpecialAttack(
  attacker: SpecialAttacker,
  defender: SpecialAttackDefender,
  ctx: SpecialAttackContext,
): SpecialAttackResult {
  const { rng } = ctx
  const { flags } = attacker
  const q = Math.trunc((attacker.level + 3) / 4) // (lv+3)/4 C 정수 나눗셈.

  let breathDamage: number | null = null
  let breathType: BreathType | null = null
  let expDrain = 0
  let poison = false

  // (1) MBRETH 브레스 게이트 rng(1,30)<5 — 단축평가: MBRETH 미세팅이면 rng 미굴림.
  if (F_ISSET(flags, MBRETH) && rng(1, 30) < 5) {
    const hit = breathHit(F_ISSET(flags, MBRWP1), F_ISSET(flags, MBRWP2), q, defender.flags, rng)
    breathType = hit.type
    breathDamage = hit.damage
    poison = hit.poison
  } else if (F_ISSET(flags, MENEDR) && rng(1, 100) < 10) {
    // (2) 브레스 미발동(else) 시에만 MENEDR 게이트 — breath↔drain XOR 상호배제.
    const drain = dice(q, 5, q * 5, rng)
    expDrain = Math.max(0, Math.min(drain, defender.experience)) // 흡수량은 방어자 exp 상한.
  }

  // (3~6) 독립 post-damage 게이트 — 각 플래그가 세팅됐을 때만 rng를 굴린다(단축평가).
  if (F_ISSET(flags, MPOISS) && rng(1, 100) <= 15) poison = true
  const disease = F_ISSET(flags, MDISEA) && rng(1, 100) <= 10
  const blind = F_ISSET(flags, MBLNDR) && rng(1, 100) <= 10
  const dissolveItemRolled = F_ISSET(flags, MDISIT) && rng(1, 100) <= 15

  return { breathDamage, breathType, expDrain, poison, disease, blind, dissolveItemRolled }
}
