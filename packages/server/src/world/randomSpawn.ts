import type { RoomNode } from 'shared'
import type { WorldTickSlot } from './worldClock.js'
import { fromTemplate, defaultCreatureRng, type CreatureRng } from './creatureFactory.js'
import { scheduleNextAction } from './nextAction.js'
import { hasFlag } from './door.js'
import type { SpawnTemplate, SpawnTemplateIndex, InstanceIdAllocator } from './spawn.js'

/**
 * random 배회 진입 슬롯 — 20초 폴링으로 플레이어 점유 방에 확률적으로 몹을 진입시킨다
 * (플랜 T4.2, A9 §2.2 update_random update.c:114).
 *
 * 원본 update_random 충실:
 *   1. 플레이어 점유 방을 중복 제거하며 순회(`rooms()` seam = activeSet.activeRooms — 점유 방만
 *      보유하고 방당 1회).
 *   2. `mrand(1,100) > traffic`이면 스킵(traffic이 곧 진입 확률%).
 *   3. `random[mrand(0,9)]` 단일 슬롯을 뽑아 0(빈 슬롯)이면 스킵(재시도 없음). 팩토리 (b) 조회.
 *   4. 그룹 크기: RPLWAN(방 flag 23)이면 mrand(1, 방 플레이어수), 아니면 numwander>1이면
 *      mrand(1, numwander), 아니면 1.
 *   5. 각 마리: 팩토리 (b) 물질화 + 타이머 초기화(nextActionAt=now+cadence, scavenge/wander 게이트
 *      = now) + monotonic idx(D7) → room.creatures push.
 *
 * clock seam은 WorldClock이 소유한다(creatureTick·gameTime 선례). 확률·그룹 크기 mrand 굴림은 주입
 * `SpawnRng` seam이며 기본 stub은 결정적으로 비발화(traffic 게이트 항상 실패)라 미배선 부팅이 조용하다.
 */

/** random 폴링 주기(실초). 원본 Random_update_interval 20초 미러. */
export const RANDOM_SPAWN_INTERVAL_SEC = 20

/** 방 flag 비트: player-dependent monster wanders(원본 mtype.h RPLWAN=23). */
export const RPLWAN = 23

/** random 스폰 확률·후보·그룹 크기 굴림 seam(mrand 대체). */
export interface SpawnRng {
  /** mrand(1,100) — traffic 게이트(`roll100() > traffic`이면 스킵). */
  roll100(): number
  /** mrand(0, len-1) — random[] 후보 슬롯 인덱스 선택. */
  pickIndex(len: number): number
  /** mrand(1, max) — 그룹 크기. */
  groupSize(max: number): number
}

/**
 * 결정적 기본 rng — traffic 게이트를 항상 실패시킨다(roll100=101 > 최대 traffic 100). 조립 지점이
 * 실 확률 굴림으로 대체할 때까지 미배선 부팅을 조용하게 유지한다(neverFireRng 철학과 정합).
 */
export const defaultSpawnRng: SpawnRng = {
  roll100: () => 101,
  pickIndex: () => 0,
  groupSize: () => 1,
}

/** random 스폰 슬롯 의존성(전역 금지 — 인자 주입). */
export interface RandomSpawnDeps {
  /** 플레이어 점유 방(중복 제거) 조회 seam — activeSet.activeRooms 주입. */
  rooms(): RoomNode[]
  /** 몹번호 → 템플릿 인덱스(팩토리 (b) 조회 + numwander 그룹 크기). */
  readonly templates: SpawnTemplateIndex
  /** 방별 monotonic idx 발급기(D7). */
  readonly alloc: InstanceIdAllocator
  /** 확률·후보·그룹 크기 굴림 seam(기본 결정적 비발화). */
  readonly rng?: SpawnRng
  /** carry/gold 랜덤화 seam(기본 결정적 identity). */
  readonly creatureRng?: CreatureRng
}

/** 그룹 크기 산정(A9 §2.2 4단계). RPLWAN→플레이어수, else numwander>1, else 1. */
function groupSize(room: RoomNode, template: SpawnTemplate, rng: SpawnRng): number {
  if (hasFlag(room.flags, RPLWAN)) return rng.groupSize(room.occupants.size)
  if (template.numwander > 1) return rng.groupSize(template.numwander)
  return 1
}

export function createRandomSpawn(deps: RandomSpawnDeps): WorldTickSlot {
  const rng = deps.rng ?? defaultSpawnRng
  const creatureRng = deps.creatureRng ?? defaultCreatureRng

  return {
    name: 'randomSpawn',
    intervalSec: RANDOM_SPAWN_INTERVAL_SEC,
    run(now: number): void {
      for (const room of deps.rooms()) {
        // (2) traffic 게이트 — mrand(1,100) > traffic이면 진입 없음.
        if (rng.roll100() > room.traffic) continue
        // (3) 단일 후보 슬롯 선택 — 빈 슬롯(0)이면 이번 주기 스폰 없음(재시도 없음).
        const misc = room.random[rng.pickIndex(10)] ?? 0
        if (misc === 0) continue
        const template = deps.templates.get(misc)
        if (template === undefined) continue
        // (4) 그룹 크기.
        const num = groupSize(room, template, rng)
        // (5) 각 마리 물질화 + 타이머 초기화 + monotonic idx.
        for (let l = 0; l < num; l += 1) {
          const idx = deps.alloc.next(room)
          const creature = fromTemplate(misc, room.roomId, idx, creatureRng, deps.templates)
          if (creature === undefined) continue
          // 스폰 시각 기준 타이머 초기화(원본 update.c:154 — LT_ATTCK/MSCAV/MWAND.ltime = t).
          scheduleNextAction(creature, now) // nextActionAt = now + cadence(dex)
          creature.lastScavengeAt = now
          creature.lastWanderAt = now
          room.creatures.push(creature)
        }
      }
    },
  }
}
