import { bonusOf, class_stats } from 'shared'
import type { CombatRng, DiceSpec } from './dice.js'
import { mdice } from './dice.js'
import { F_ISSET, PFEARS, PBLIND, MBEFUD } from '../world/hexFlags.js'
import { BARBARIAN, CLERIC, MAGE, INVINCIBLE } from './constants.js'
import type { Combatant, PlayerCombatant, CreatureCombatant } from './combatant.js'

/**
 * attackStats — 명중 임계·피해 분기·PALADIN 정렬 보정의 오라클 충실 이식(command5.c / update.c).
 *
 * byte-fidelity 최우선 함정: 모든 `/`는 C 정수 나눗셈(0 방향 절사) = Math.trunc(절대 Math.floor 아님).
 * 음수 피제수(음수 armor의 armor/8, armor>70의 (70−armor)/5)에서 floor와 갈려 명중/피해가 뒤집힌다.
 *
 * thaco/armor/bonus는 stats-core가 이미 파생·노출한 값을 소비한다(재정의 없음). base만 반환하며
 * MAX(1,·)·크리티컬·불발·PALADIN 시퀀싱은 Story 8 파이프가 조립한다(applyPaladinAlignment는 순수 헬퍼).
 */

/**
 * 명중 임계 — command5.c:231-236(플레이어) / update.c:373-383(몬스터).
 *   n = attacker.thaco − trunc(defender.armor/8)
 *   플레이어: PFEARS면 +2, PBLIND면 +5(명중 어려워짐).
 *   몬스터: max(1, n) 하한(PALADIN 정렬 보정은 명중이 아니라 피해에 적용 — 여기 없음).
 * 명중 판정은 호출부가 `mrand(1, HIT_ROLL_MAX) >= n`으로 수행한다(임계만 반환).
 */
export function hitThreshold(attacker: Combatant, defender: Combatant): number {
  let n = attacker.thaco - Math.trunc(defender.armor / 8)
  if (attacker.kind === 'player') {
    if (F_ISSET(attacker.flags, PFEARS)) n += 2
    if (F_ISSET(attacker.flags, PBLIND)) n += 5
    return n
  }
  return Math.max(1, n)
}

/**
 * 플레이어 base 피해 — command5.c:237-262. base 분기 → MAGE/CLERIC override 2단계(평탄화 금지).
 * MAX(1,·)·PALADIN·크리티컬은 여기서 제외(Story 8 시퀀싱). 오라클의 self 주사위는 클래스 성장
 * 주사위(class_stats[class])다(플레이어도 creature 구조체 — mdice(ply_ptr)가 자기 ndice/sdice/pdice 판독).
 */
export function playerBaseDamage(attacker: PlayerCombatant, rng: CombatRng): number {
  const { state } = attacker
  const strBonus = bonusOf(state.effectiveStrength)
  const selfDice: DiceSpec = class_stats[state.class] ?? class_stats[0]!

  // 1단계 — base 분기(무기 착용 / 바바리안·초인 초과 / 그 외).
  let n: number
  if (state.weapon !== null) {
    n = mdice(state.weapon, rng) + strBonus + Math.trunc(state.weapon.proficiency / 10)
  } else if (state.class === BARBARIAN || state.class > INVINCIBLE) {
    n = mdice(selfDice, rng) + strBonus + Math.trunc((state.level + 3) / 4)
  } else {
    n = mdice(selfDice, rng) + strBonus
  }

  // 2단계 — MAGE/CLERIC override(분기 아님, 교체). 숙련·성장 항을 벗기고 mdice를 재굴림한다.
  if (state.class === MAGE || state.class === CLERIC) {
    n = state.weapon !== null ? mdice(state.weapon, rng) + strBonus : mdice(selfDice, rng) + strBonus
  }

  return n
}

/**
 * 몬스터 피해 — update.c:439-447(자체 완결: 크리티컬·PALADIN 없음).
 *   n = mdice(self) − trunc((70 − defender.armor)/5); if(n<1) n=1; if(MBEFUD) n = trunc(n/3).
 * 순서 고정: clamp(min 1) 이후 MBEFUD 나눗셈.
 */
export function monsterDamage(
  attacker: CreatureCombatant,
  defender: Combatant,
  rng: CombatRng,
): number {
  const { instance } = attacker
  let n = mdice(instance, rng) - Math.trunc((70 - defender.armor) / 5)
  if (n < 1) n = 1
  if (F_ISSET(instance.flags, MBEFUD)) n = Math.trunc(n / 3)
  return n
}

/**
 * PALADIN 정렬 보정 — command5.c:266-278. MAX(1,n) 이후·크리티컬 이전에 적용하는 순수 헬퍼.
 * Story 8 파이프가 시퀀싱한다(Story 5는 base만 반환하고 이 헬퍼를 노출만).
 *   alignment<0 → trunc(n/2)(악행 페널티), alignment>250 → n + mrand(1,3)(선행 보너스), 그 외 → n.
 *
 * known divergence — 현 `alignment` 값역은 [0,2](생성 인터뷰 1|2 + backfill sentinel 0)라 두 분기가
 * 모두 거짓이고 PALADIN 정렬 보정은 실 데이터에서 미발화한다(항상 n 반환). 오라클 임계값을 보존해
 * E6 성향 시스템(-1000..+1000, #123)에서 코드 변경 없이 발화하게 둔다 — `magic/learning.ts`의
 * study 정렬 게이트 주석과 같은 성격이다.
 */
export function applyPaladinAlignment(n: number, alignment: number, rng: CombatRng): number {
  if (alignment < 0) return Math.trunc(n / 2)
  if (alignment > 250) return n + rng(1, 3)
  return n
}
