import { loadWorldFile } from 'shared'
import type { RoomNode } from 'shared'
import type { WorldTickSlot } from './worldClock.js'
import { fromTemplate, defaultCreatureRng, type CreatureRng } from './creatureFactory.js'
import type { SpawnTemplateIndex, InstanceIdAllocator } from './spawn.js'

/**
 * invasion 침공 슬롯 — 데이터 정의 이벤트로 방/몹 범위에 대량 스폰하고 전역 방송한다
 * (플랜 T4.3·T4.4, A9 §2.3 update_monster/_two update.c:755·784, 결정 D2).
 *
 * 원본은 방/몹 번호 범위를 소스에 하드코딩(방 8000~8300·3601~3630, 몹 732~755·265~299, 4000·5000초)
 * 했다 — 이것은 형상이므로 신규 스택에서 `data/world/events.json`(hand-authored, converter 산출물
 * 아님) 데이터 정의로 승격한다. 침공이라는 게임 이벤트 자체(주기적 몹 물결 + 전역 알림)는 콘텐츠다.
 *
 * 이벤트마다 `intervalSec=periodSec`인 `WorldTickSlot` 하나를 만들어 반환한다 — 서로 다른 주기의
 * 멀티플렉싱은 WorldClock이 슬롯별 `tickSec % intervalSec` 게이트로 이미 담당하므로(worldClock.ts
 * 프레임워크 책임) 슬롯 내부에서 gcd·재게이팅을 재구현하지 않는다. 발화 시 count회 반복하며 방/몹을
 * mrand로 뽑아(주입 seam) 팩토리 (b)로 물질화하고, 선택 방이 그래프에 없으면 스킵한다. 방송은 전역
 * 방송 실 배선(E7 미배선) 대신 주입 seam(기본 로컬 no-op)으로 넘긴다.
 */

/** 침공 이벤트 정의(events.json 스키마). */
export interface InvasionEvent {
  /** 이벤트 식별자. */
  readonly id: string
  /** 발화 주기(실초). */
  readonly periodSec: number
  /** 스폰 대상 방 번호 범위(mrand 선택). */
  readonly roomRange: { readonly min: number; readonly max: number }
  /** 스폰 몹 번호 범위(mrand 선택). */
  readonly mobRange: { readonly min: number; readonly max: number }
  /** 발화당 스폰 반복 횟수. */
  readonly count: number
  /** 발화 시 방송 메시지. */
  readonly broadcast: string
}

/** 부팅 시 events.json을 읽는다(조립 지점 seam). */
export function loadInvasionEvents(worldRoot?: string): InvasionEvent[] {
  return loadWorldFile<InvasionEvent[]>('events.json', worldRoot)
}

/** 침공 방/몹 선택 mrand(min,max) seam. */
export type InvasionRng = (min: number, max: number) => number

/** 결정적 기본 rng — 항상 범위 최솟값을 고른다(단위 테스트 결정적 통과). */
export const defaultInvasionRng: InvasionRng = (min) => min

/** 방송 seam — 전역 방송 실 배선(E7) 전까지 로컬 fan-out/로그로 남긴다. */
export type SpawnBroadcast = (message: string) => void

/** 결정적 기본 방송 — no-op. E7이 전역 방송으로 대체 주입한다. */
export const defaultSpawnBroadcast: SpawnBroadcast = () => undefined

/** invasion 슬롯 의존성(전역 금지 — 인자 주입). */
export interface InvasionDeps {
  /** 침공 이벤트 목록(events.json). */
  readonly events: readonly InvasionEvent[]
  /** 방 번호 → 방 노드 조회(그래프에 없으면 undefined → 스킵). */
  resolveRoom(roomId: number): RoomNode | undefined
  /** 몹번호 → 템플릿 인덱스(팩토리 (b) 조회). */
  readonly templates: SpawnTemplateIndex
  /** 방별 monotonic idx 발급기(D7). */
  readonly alloc: InstanceIdAllocator
  /** 방/몹 선택 mrand seam(기본 min 선택). */
  readonly rng?: InvasionRng
  /** carry/gold 랜덤화 seam(기본 결정적 identity). */
  readonly creatureRng?: CreatureRng
  /** 방송 seam(기본 no-op). */
  readonly broadcast?: SpawnBroadcast
}

/**
 * 침공 슬롯들을 생성한다 — 이벤트당 `WorldTickSlot` 1개(`intervalSec=periodSec`). WorldClock이
 * 슬롯별 modulo 게이트로 도래 시점을 걸러 주므로 이 슬롯은 발화 시점을 알 필요가 없다(gcd 불요).
 */
export function createInvasion(deps: InvasionDeps): WorldTickSlot[] {
  const rng = deps.rng ?? defaultInvasionRng
  const creatureRng = deps.creatureRng ?? defaultCreatureRng
  const broadcast = deps.broadcast ?? defaultSpawnBroadcast

  return deps.events.map((event) => ({
    name: `invasion:${event.id}`,
    intervalSec: event.periodSec,
    run(): void {
      for (let i = 0; i < event.count; i += 1) {
        const room = deps.resolveRoom(rng(event.roomRange.min, event.roomRange.max))
        if (room === undefined) continue // 선택 방이 그래프에 없으면 스킵
        const mob = rng(event.mobRange.min, event.mobRange.max)
        const idx = deps.alloc.next(room)
        const creature = fromTemplate(mob, room.roomId, idx, creatureRng, deps.templates)
        if (creature === undefined) continue
        room.creatures.push(creature)
      }
      // 방송은 주기 도래 시 나간다(원본은 루프 후 broadcast). 전역 방송 실 배선은 E7 seam.
      broadcast(event.broadcast)
    },
  }))
}
