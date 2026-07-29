import type { CombatRng } from './dice.js'
import { F_ISSET, MAGGRE, MGAGGR, MEAGGR, MDINVI, PHIDDN, PINVIS, PDMINV } from '../world/hexFlags.js'

/**
 * aggro — 몬스터 선공 타깃선정·민첩 회피(update.c:587~608)의 순수 함수 이식. 타깃선정은 오라클
 * lowest_piety(player.c:1314, MAGGRE용)·low_piety_alg(player.c:1473, MGAGGR/MEAGGR용)를 재현한다.
 *
 * 순수 함수 seam: 전역 상태·Date.now·Math.random 없이 모든 굴림을 주입 CombatRng로만 굴리고, 입력을
 * 변형하지 않는다. 실제 선공 등록(add_enm_crt)·live dispatch·실 이동은 배선 소관이다(이 모듈은 어느
 * 플레이어에게 적개심을 걸지·이번 라운드 회피됐는지만 결정한다).
 *
 * ── 가중 랜덤 선택(argmin 아님) ──
 * "lowest_piety"는 오칭이다 — 최저 piety를 뽑는 게 아니라 weight=MAX(1,C−piety)로 가중 랜덤한다(piety가
 * 낮을수록 뽑힐 확률이 크지만 결정적이지 않다). weight 상수 2개를 분리 유지한다(통합 금지):
 *   - MAGGRE(lowest_piety): C=25.
 *   - alg 변종(low_piety_alg): C=30.
 * pick=rng(1,totalWeight); 자격 플레이어를 리스트 순서로 누적 walk하며 cumulative>=pick인 첫 플레이어 선택.
 *
 * ── 레벨 게이트 통일(의도적 divergence) ──
 * 오라클 low_piety_alg는 레벨 게이트 `((player.level+3)/4) < lvl`을 첫 패스(weight-sum)에만 적용하고
 * pick 패스엔 누락한다(두 패스 자격 조건 desync 버그 — pick 패스에서 레벨 미달 플레이어가 다시 자격을
 * 얻어 walk 누적이 첫 패스 total과 어긋날 수 있다). 이 이식은 eligible set을 1회 계산(모든 필터+레벨
 * 게이트 포함)한 뒤 weight-sum·pick 둘 다 이 단일 집합에서 파생한다. 레벨 게이트는 alg 변종에만 적용된다
 * (MAGGRE lowest_piety에는 레벨 게이트 없음).
 */

/** 선공 후보 플레이어 최소 shape. 자격 flag(PHIDDN/PINVIS/PDMINV)는 hex flags로 F_ISSET 판독. */
export interface AggroPlayer {
  readonly id: string
  /**
   * alg 변종 레벨 게이트용 — 자격은 trunc((level+3)/4) >= trunc((attacker.level+3)/4)(공격자 tier 이상).
   * Story의 shape 목록은 이 필드를 illustrative하게 누락했으나, 오라클 low_piety_alg가 후보 level에
   * 게이트하므로(player.c:1490 `((cp->crt->level+3)/4) < lvl`) 필수다.
   */
  readonly level: number
  /** 가중치 산출 — weight=MAX(1,C−piety). C는 MAGGRE=25, alg 변종=30. */
  readonly piety: number
  /** alg 변종 alignment 필터 — 양수=선(good), 음수=악(evil). */
  readonly alignment: number
  /** 민첩 회피 판정 — target.dexterity>attacker.dexterity면 회피 굴림. */
  readonly dexterity: number
  /** 자격 flag 판독용 hex flags(PHIDDN/PINVIS/PDMINV). */
  readonly flags: string
}

/** 공격자 크리처 최소 shape. 공격형 M-flag(MAGGRE/MGAGGR/MEAGGR)·MDINVI(투명 탐지)·dex를 판독. */
export interface AggroAttacker {
  readonly level: number
  readonly dexterity: number
  readonly flags: string
}

/**
 * 선공 결정 — target은 적개심을 걸 플레이어(없으면 null), evaded는 타깃을 골랐으나 이번 라운드 민첩
 * 회피된 경우 true. evaded일 때 target은 null이다(회피 시 오라클은 enmity 등록 없이 skip).
 */
export interface AggroResult {
  readonly target: AggroPlayer | null
  readonly evaded: boolean
}

/** trunc((level+3)/4) — C 정수 나눗셈 레벨 tier. */
function levelTier(level: number): number {
  return Math.trunc((level + 3) / 4)
}

/**
 * 가중 랜덤 타깃선정. attacker에 세팅된 공격형 flag로 모드를 정한다:
 *   - MAGGRE: lowest_piety 모드(weight C=25, alignment/레벨 필터 없음).
 *   - else(MGAGGR/MEAGGR): low_piety_alg 모드(weight C=30, alignment 필터 + 레벨 게이트).
 * 자격 플레이어가 없으면 rng를 굴리지 않고 null을 반환한다(오라클 `if(!total) return 0`).
 */
export function selectAggroTarget(
  attacker: AggroAttacker,
  players: readonly AggroPlayer[],
  rng: CombatRng,
): AggroPlayer | null {
  const invis = F_ISSET(attacker.flags, MDINVI) // 공격자 투명 탐지 → PINVIS 플레이어 자격 부여.
  const isMaggre = F_ISSET(attacker.flags, MAGGRE)
  const weightConst = isMaggre ? 25 : 30
  // MAGGRE > alg 변종 우선순위(오라클 `if(MAGGRE) ... else ...`). alg: MGAGGR→-1(선인만), MEAGGR→+1(악인만).
  const alg = isMaggre ? 0 : F_ISSET(attacker.flags, MGAGGR) ? -1 : 1
  const attackerTier = levelTier(attacker.level)

  const eligible = players.filter((p) => {
    if (F_ISSET(p.flags, PHIDDN)) return false
    if (F_ISSET(p.flags, PINVIS) && !invis) return false
    if (F_ISSET(p.flags, PDMINV)) return false
    if (alg === 0) return true // MAGGRE — alignment/레벨 필터 없음.
    if (levelTier(p.level) < attackerTier) return false // alg 변종 레벨 게이트(단일 eligible set).
    // known divergence — 현 alignment 값역 [0,2](생성 1|2 + backfill sentinel 0)에서는 두 조건이
    // 항상 참이라 MGAGGR·MEAGGR 몹이 아무도 선공하지 않는다. 오라클 임계값을 보존해 E6 성향
    // 시스템(-1000..+1000, #123)에서 코드 변경 없이 발화하게 둔다(magic/learning.ts 주석 참조).
    if (alg === -1 && p.alignment < 100) return false // MGAGGR: 선인(alignment>=100)만.
    if (alg === 1 && p.alignment > -100) return false // MEAGGR: 악인(alignment<=-100)만.
    return true
  })

  const weightOf = (p: AggroPlayer): number => Math.max(1, weightConst - p.piety)
  const totalWeight = eligible.reduce((sum, p) => sum + weightOf(p), 0)
  if (totalWeight === 0) return null

  const pick = rng(1, totalWeight)
  let cumulative = 0
  for (const p of eligible) {
    cumulative += weightOf(p)
    if (cumulative >= pick) return p
  }
  return null // 도달 불가(pick<=totalWeight) — 방어적 반환.
}

/**
 * 민첩 회피 — target.dexterity>attacker.dexterity && rng(1,10)<4(30% 회피). dex 열세면 short-circuit으로
 * rng를 굴리지 않는다(오라클 `att->dex > crt->dex && mrand(1,10)<4` 단축평가 순서 보존).
 */
export function dexEvades(attacker: AggroAttacker, target: AggroPlayer, rng: CombatRng): boolean {
  return target.dexterity > attacker.dexterity && rng(1, 10) < 4
}

/**
 * 선공 해석 — 공격형 flag가 없으면 굴림 없이 무-타깃. 타깃선정(pick 굴림) 후 민첩 회피(회피 굴림)를
 * 오라클 순서대로 적용한다. 회피되면 이번 라운드 skip(target null, evaded true) — enmity 미등록.
 */
export function resolveAggro(
  attacker: AggroAttacker,
  players: readonly AggroPlayer[],
  rng: CombatRng,
): AggroResult {
  const aggressive =
    F_ISSET(attacker.flags, MAGGRE) ||
    F_ISSET(attacker.flags, MGAGGR) ||
    F_ISSET(attacker.flags, MEAGGR)
  if (!aggressive) return { target: null, evaded: false }

  const target = selectAggroTarget(attacker, players, rng)
  if (!target) return { target: null, evaded: false }

  if (dexEvades(attacker, target, rng)) return { target: null, evaded: true }
  return { target, evaded: false }
}
