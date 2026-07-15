import type { CreatureInstance, RoomNode } from 'shared'
import type { WorldTickSlot } from './worldClock.js'
import type { ActiveSet } from './activeSet.js'
import { isDue, scheduleNextAction } from './nextAction.js'
import {
  runAutonomic,
  neverFireRng,
  type AutonomicRng,
  type AutonomicResult,
} from './autonomic.js'
import { F_ISSET, MAGGRE, MGAGGR, MEAGGR } from './hexFlags.js'

/**
 * 크리처 tick 슬롯 — WorldClock(1Hz)에 얹혀 활성 방의 next-action 도래 크리처만 autonomic 처리한다(플랜 T3.3·T3.4).
 *
 * 매 초 `activeSet.activeRooms()`를 순회하고, 방마다 도래(`isDue`) 크리처에 대해:
 *   1. `runAutonomic`(§3.1~3.4, 순수)으로 새 상태·부수효과 서술자를 계산한다.
 *   2. 방 상태를 적용한다(carve-out) — 크리처 상태 교체, scavenge 아이템 이동, wander-out 제거.
 *   3. wander-out으로 소멸하지 않았으면 §3.5 조기종료 게이트를 평가하고, 통과(적 있거나 공격형)한
 *      크리처에 대해서만 `onCombatTick` seam을 호출한다(E4-2 기본 no-op, 전투·어그로는 E6).
 *   4. next-action을 `now+cadence`로 재스케줄한다.
 *
 * clock seam은 WorldClock이 소유하므로 이 슬롯은 tick 트리거를 알지 못한다(gameTime 선례). `now`는
 * WorldClock이 넘기는 tickSec다 — activeSet의 activatedAt도 동일 clock(tickSec) 기준으로 세팅돼야
 * 재생 소급 baseline 비교가 성립한다(Story 6 조립 지점이 activate()를 tickSec로 호출).
 */

/** 전투 디스패치 seam — §3.5 게이트 통과 크리처에 대해 호출된다. E4-2 기본 no-op, E6이 대체. */
export type OnCombatTick = (creature: CreatureInstance, room: RoomNode) => void

/** 기본 전투 디스패치 — 아무 것도 하지 않는다(E6이 실 전투로 대체). */
export const defaultOnCombatTick: OnCombatTick = () => undefined

/** creatureTick 슬롯 의존성. */
export interface CreatureTickDeps {
  /** 활성 방·활성화 시각 조회 seam(activeSet). */
  readonly activeSet: Pick<ActiveSet, 'activeRooms' | 'activatedAt'>
  /** scavenge/wander 확률 굴림 seam(기본 neverFireRng — 결정적 비발화). */
  readonly rng?: AutonomicRng
  /** §3.5 게이트 통과 크리처 전투 디스패치(기본 no-op). */
  readonly onCombatTick?: OnCombatTick
}

/** 공격형 크리처인지 — MAGGRE(무차별)·MGAGGR(선 공격)·MEAGGR(악 공격) 중 하나. */
function isAggressive(flags: string): boolean {
  return F_ISSET(flags, MAGGRE) || F_ISSET(flags, MGAGGR) || F_ISSET(flags, MEAGGR)
}

/**
 * autonomic 결과를 방 상태에 적용한다(carve-out — tick 계층이 소유하는 in-place 변형).
 * 원본(`original`) 크리처 객체를 방 배열에서 찾아 교체/제거한다.
 */
function applyResult(room: RoomNode, original: CreatureInstance, result: AutonomicResult, now: number): void {
  const idx = room.creatures.indexOf(original)
  if (result.wanderOut) {
    // wander-out: 방·활성 시뮬레이션에서 크리처 소멸(원본 free_crt). 활성집합은 방 단위라 별도 처리 불요.
    if (idx >= 0) room.creatures.splice(idx, 1)
    return
  }
  const updated = result.creature
  // scavenge: 방 바닥 아이템을 크리처 인벤토리로 이동(새 배열로 교체 — 원본 aliasing 회피).
  if (result.scavenge !== undefined) {
    const [item] = room.items.splice(result.scavenge.itemIndex, 1)
    if (item !== undefined) updated.inventory = [...updated.inventory, item]
  }
  scheduleNextAction(updated, now)
  if (idx >= 0) room.creatures[idx] = updated
}

export function createCreatureTick(deps: CreatureTickDeps): WorldTickSlot {
  const rng = deps.rng ?? neverFireRng
  const onCombatTick = deps.onCombatTick ?? defaultOnCombatTick

  return {
    name: 'creatureTick',
    intervalSec: 1,
    run(tickSec: number): void {
      const now = tickSec
      for (const room of deps.activeSet.activeRooms()) {
        const activatedAt = deps.activeSet.activatedAt(room.roomId) ?? now
        // 스냅샷 순회 — wander-out이 room.creatures를 변형하므로 원본 배열을 직접 순회하지 않는다.
        for (const creature of [...room.creatures]) {
          if (!isDue(creature, now)) continue
          const result = runAutonomic(creature, { now, activatedAt, room, rng })
          applyResult(room, creature, result, now)
          if (result.wanderOut) continue // 소멸한 크리처는 전투 디스패치 대상이 아니다.
          // §3.5 조기종료 게이트 — 적 없고 비공격형이면 전투 디스패치 없이 종료.
          const updated = result.creature
          if (updated.enemies.length === 0 && !isAggressive(updated.flags)) continue
          onCombatTick(updated, room)
        }
      }
    },
  }
}
