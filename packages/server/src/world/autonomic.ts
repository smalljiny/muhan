import type { CreatureInstance, RoomNode } from 'shared'
import {
  F_ISSET, F_SET, F_CLR,
  MSCAVE, MHASSC, MPERMT, MDMFOL, MBEFUD, MCHARM,
  OPERMT, OHIDDN, OPERM2, ONOTAK, OSCENE,
} from './hexFlags.js'

/**
 * autonomic 순수 함수 — active 크리처 한 마리의 한 "행동 기회"에서 비전투 자율 행동을 계산한다(플랜 T3.2).
 *
 * 원본 update.c:229 update_active의 §3.1(상태이상 만료)·§3.2(재생)·§3.3(scavenge)·§3.4(wander-out)를
 * 이식한다. §3.0 공격 타이머 게이트(LT_ATTCK=nextActionAt)와 §3.5 조기종료·onCombatTick 디스패치는
 * tick 계층(creatureTick)이 소유한다.
 *
 * 순수성: 입력 크리처를 in-place로 변형하지 않고 새 `CreatureInstance`를 반환한다(flags·hpcur·mpcur·
 * 타이머 필드를 담은 새 객체). 방 아이템 이동(scavenge)·크리처 제거(wander-out)는 부수효과 서술자
 * (`scavenge`·`wanderOut`)로 반환하고, 실제 방 상태 적용은 tick 계층의 carve-out이다.
 *
 * 확률 seam: scavenge 15%·wander-out traffic%는 주입 `rng`가 mrand(1,100) 굴림을 대신한다. 결정적
 * stub(`alwaysFireRng`/`neverFireRng`)으로 단위 테스트가 결정적으로 통과한다.
 */

/** mrand(1,max) 굴림 seam. `<=` 임계와 비교되므로 낮은 값=통과, 높은 값=실패. */
export type AutonomicRng = (max: number) => number

/** 항상 최저 굴림(1) — scavenge/wander 확률을 항상 통과시킨다(테스트·강제 발화용). */
export const alwaysFireRng: AutonomicRng = () => 1
/** 항상 최고 굴림(101) — scavenge/wander 확률을 항상 실패시킨다. tick 기본값(결정적 비발화). */
export const neverFireRng: AutonomicRng = () => 101

/** autonomic 처리 컨텍스트. */
export interface AutonomicContext {
  /** 현재 실초 시각(WorldClock tickSec 기준). */
  readonly now: number
  /** 방 활성화(재진입) 실초 시각 — 재생 소급 baseline 클램프에 쓰인다(빈 방=시간 정지). */
  readonly activatedAt: number
  /** 크리처가 속한 방(바닥 아이템·traffic 참조). */
  readonly room: RoomNode
  /** 확률 굴림 seam. */
  readonly rng: AutonomicRng
}

/** autonomic 결과 — 새 크리처 상태 + 방 상태 적용 서술자(부수효과는 tick 계층이 적용). */
export interface AutonomicResult {
  /** 갱신된 크리처 상태(입력과 다른 새 객체). */
  readonly creature: CreatureInstance
  /** scavenge로 회수할 방 아이템 인덱스(없으면 미회수). */
  readonly scavenge?: { readonly itemIndex: number }
  /** true면 wander-out으로 방·활성집합에서 제거·소멸시킨다. */
  readonly wanderOut: boolean
}

/** 재생 주기(초, LT_HEALS.interval=60). */
const REGEN_INTERVAL = 60
/** scavenge/wander 게이트 최소 경과(초). */
const IDLE_GATE = 20
/** scavenge 확률(%). */
const SCAVENGE_CHANCE = 15

/** 바닥 아이템 flags에 scavenge 제외 비트(OPERMT·OHIDDN·OPERM2·ONOTAK·OSCENE)가 하나라도 있으면 true. */
function isScavengeExcluded(itemFlags: string): boolean {
  return (
    F_ISSET(itemFlags, OPERMT) ||
    F_ISSET(itemFlags, OHIDDN) ||
    F_ISSET(itemFlags, OPERM2) ||
    F_ISSET(itemFlags, ONOTAK) ||
    F_ISSET(itemFlags, OSCENE)
  )
}

export function runAutonomic(creature: CreatureInstance, ctx: AutonomicContext): AutonomicResult {
  const { now, activatedAt, room, rng } = ctx

  let flags = creature.flags
  let hpcur = creature.hpcur
  let mpcur = creature.mpcur
  let lastRegenAt = creature.lastRegenAt ?? activatedAt
  // scavenge/wander 20초 게이트는 절대시각 기준이다(원본 update.c:291·312 LT_MSCAV/LT_MWAND.ltime).
  // 재생(§3.2)만 activatedAt으로 클램프해 동결 구간을 소급 배제하며(D3), 이 두 게이트는 클램프하지
  // 않는다 — 프레임 진행(재생·소멸)이 아니라 다음 행동 "타이밍"만 좌우하므로 시간 정지를 깨지 않는다.
  let lastScavengeAt = creature.lastScavengeAt ?? activatedAt
  let lastWanderAt = creature.lastWanderAt ?? activatedAt

  // §3.1 MBEFUD 만료 — 오라클 update.c:258 `if(LT_BEFUD < t) F_CLR(MBEFUD)`, F_ISSET 무가드.
  // 도래시각(befuddledUntil) 미설정 = LT_BEFUD 0(스폰 기본) = 과거 → stale 비트 스크럽. 활성 befud
  // 타이머(미래 시각)가 있을 때만 유지한다(F_CLR은 미set 비트에 no-op이라 무가드가 안전).
  if (creature.befuddledUntil === undefined || creature.befuddledUntil < now) {
    flags = F_CLR(flags, MBEFUD)
  }

  // §3.2 재생 — baseline을 max(다음 도래시각, activatedAt)으로 클램프해 동결 구간을 소급하지 않는다(D3).
  {
    let due = Math.max(lastRegenAt + REGEN_INTERVAL, activatedAt)
    const hpStep = Math.max(1, Math.floor(creature.hpmax / 10))
    const mpStep = Math.max(1, Math.floor(creature.mpmax / 6))
    while (due <= now && (hpcur < creature.hpmax || mpcur < creature.mpmax)) {
      hpcur = Math.min(creature.hpmax, hpcur + hpStep)
      mpcur = Math.min(creature.mpmax, mpcur + mpStep)
      lastRegenAt = due
      due += REGEN_INTERVAL
    }
  }

  // §3.1b MCHARM 만료 — 오라클 update.c:277 `if(t > LT_CHRMD && F_ISSET(MCHARM)) F_CLR(MCHARM)`.
  // 도래시각(charmedUntil) 미설정 = LT_CHRMD 0(스폰 기본) = 과거 → stale MCHARM 스크럽. F_ISSET 가드는
  // 오라클대로 유지(MCHARM일 때만 평가). 활성 charm 타이머(미래)가 있을 때만 유지한다.
  if (F_ISSET(flags, MCHARM) && (creature.charmedUntil === undefined || now > creature.charmedUntil)) {
    flags = F_CLR(flags, MCHARM)
  }

  // §3.3 scavenge — MSCAVE·20초↑ 게이트. 게이트 통과 시 조건 무관하게 타이머 리셋(원본 준수).
  let scavenge: { itemIndex: number } | undefined
  if (F_ISSET(flags, MSCAVE) && now - lastScavengeAt > IDLE_GATE) {
    lastScavengeAt = now
    const first = room.items[0]
    if (rng(100) <= SCAVENGE_CHANCE && first !== undefined && !isScavengeExcluded(first.flags)) {
      scavenge = { itemIndex: 0 }
      flags = F_SET(flags, MHASSC)
    }
  }

  // §3.4 wander-out — 배회 크리처(!MHASSC·!MPERMT·!MDMFOL)·20초↑·rng≤traffic·적 없음이면 소멸.
  // "배회"는 양성 flag가 아니라 이 세 flag의 부재다. scavenge로 방금 세팅된 MHASSC도 여기서 제외된다.
  let wanderOut = false
  const wanders = !F_ISSET(flags, MHASSC) && !F_ISSET(flags, MPERMT) && !F_ISSET(flags, MDMFOL)
  if (wanders && now - lastWanderAt > IDLE_GATE) {
    lastWanderAt = now
    if (rng(100) <= room.traffic && creature.enemies.length === 0) {
      wanderOut = true
    }
  }

  const updated: CreatureInstance = {
    ...creature,
    flags,
    hpcur,
    mpcur,
    lastRegenAt,
    lastScavengeAt,
    lastWanderAt,
  }
  return { creature: updated, scavenge, wanderOut }
}
