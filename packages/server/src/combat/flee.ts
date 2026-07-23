import { bonusOf } from 'shared'
import type { CombatRng } from './dice.js'
import { F_ISSET, PWIMPY, PFEARS } from '../world/hexFlags.js'
import { PALADIN } from './constants.js'

/**
 * flee — 플레이어 도주 결정(update.c:534~551)의 순수 함수 이식. boolean(도주 여부)만 반환한다. 실제 방
 * 이동(flee 액션)은 movement seam(#99) 유예다 — 이 함수는 "도주할지"만 결정하고 어디로 도주할지는
 * 배선하지 않는다.
 *
 * 오라클은 death → PWIMPY → PFEARS의 else-if 체인이다(death 검사는 배선 소관). PWIMPY가 세팅되면 PFEARS
 * 분기는 평가되지 않는다(else-if).
 *   - PWIMPY: hpCurrent<=wimpyValue면 도주(굴림 없음). wimpyValue는 오라클 carry[0](WIMPYVALUE 필드).
 *   - PFEARS: ff 공식 굴림 후 ff<rng(1,100)이면 도주.
 *
 * ── PFEARS 우선순위 버그 수정(loud divergence) ──
 * 오라클(update.c:544~546):
 *   ff = 40 + (1- (hpcur/hpmax))*40 + bonus[constitution]*3 + (class == PALADIN) ? -10 : 0;
 * C 연산자 우선순위상 `+`가 `?:`보다 강해 `(40 + ... + (class==PALADIN)) ? -10 : 0`으로 파싱된다. 괄호
 * 안 합은 항상 nonzero(≥40)라 truthy → ff=-10 상시 → `if(ff < mrand(1,100))`가 항상 참 → PFEARS 플레이어는
 * 사실상 매 라운드 무조건 도주한다(게임플레이를 무의미하게 만드는 명백한 버그). 이 이식은 삼항을 괄호로
 * 묶은 **의도된 공식**으로 재현한다(괄호만 수정, 게임플레이 방향·상수는 불변):
 *   ff = 40 + (1 - trunc(hpcur/hpmax))*40 + bonusOf(constitution)*3 + (class === PALADIN ? -10 : 0)
 * 이로써 hp비율·건강(con)·팔라딘 보정이 실제로 도주 확률에 영향을 준다. cp·Story 5 독공식 정정과 같은
 * 선례의 loud divergence다.
 *
 * ── 정수 나눗셈 유지 ──
 * `(hpcur/hpmax)`는 C 정수 나눗셈이라 hpCurrent<hpMax면 0, hpCurrent==hpMax면 1이다(그 사이 비율 없음).
 * Math.trunc로 재현해 hp항이 40 또는 0만 되게 한다 — 부드러운 비율로 float화하지 않는다.
 */

/** 도주 판정 대상 플레이어 최소 shape. PWIMPY/PFEARS는 hex flags로 F_ISSET 판독. */
export interface FleePlayer {
  /** 도주 모드 flag 판독용 hex flags(PWIMPY/PFEARS). */
  readonly flags: string
  readonly hpCurrent: number
  readonly hpMax: number
  /** PFEARS ff 공식 con 항 — bonusOf(constitution)*3. */
  readonly constitution: number
  /** PFEARS ff 공식 팔라딘 항 — class===PALADIN이면 -10. */
  readonly class: number
  /** PWIMPY 임계 — 오라클 carry[0](WIMPYVALUE). hpCurrent<=wimpyValue면 도주. */
  readonly wimpyValue: number
}

/**
 * 도주 결정 — PWIMPY(굴림 없음) → PFEARS(ff 공식 + rng(1,100)) else-if 체인. 어느 flag도 없으면 false.
 * 입력 미변형.
 */
export function decideFlee(player: FleePlayer, rng: CombatRng): boolean {
  if (F_ISSET(player.flags, PWIMPY)) {
    return player.hpCurrent <= player.wimpyValue
  }
  if (F_ISSET(player.flags, PFEARS)) {
    const hpTerm = (1 - Math.trunc(player.hpCurrent / player.hpMax)) * 40 // 정수 나눗셈 → 40 또는 0.
    const paladinTerm = player.class === PALADIN ? -10 : 0 // 삼항 괄호 수정(우선순위 버그).
    const ff = 40 + hpTerm + bonusOf(player.constitution) * 3 + paladinTerm
    return ff < rng(1, 100)
  }
  return false
}
