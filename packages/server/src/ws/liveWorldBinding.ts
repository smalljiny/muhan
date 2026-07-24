import type { RoomNode } from 'shared'
import type { LiveCharacterEntry } from '../world/liveCharacterEntry.js'
import type { SessionLiveWorld } from './fsm/sessionFsm.js'

/**
 * 라이브 월드 진입 seam의 셸측 배선(Story 4) — `SessionContext.liveWorld`를 조립하는 단위.
 *
 * FSM(sessionFsm.ts)은 3층 경계를 지켜 registry·월드 그래프를 직접 만지지 않고 주입된 콜백만 쓴다.
 * 이 모듈이 그 콜백을 실 `LiveCharacterEntry`(hydrate/place)와 월드 그래프(roomSummary)로 배선한다.
 * 라이브 월드 의존이 주입될 때만 구성하고, 미주입이면 `buildSession`이 `liveWorld`를 undefined로 둔다(T4.5).
 */

/** buildSession에 주입되는 라이브 월드 의존 — 진입 코어(entry)와 방 해소자(월드 그래프). */
export interface LiveWorldBinding {
  readonly entry: LiveCharacterEntry
  readonly resolveRoom: (roomId: number) => RoomNode | undefined
}

/**
 * roomId → world:room 요약 파생기를 만든다. exits는 반드시 exit **이름**(ExitEdge.name)이다 —
 * `world:room.exits`는 이름 목록이지 인덱스가 아니다(tryMove selector 계약, tryMove.ts:145). 미해소 방은
 * undefined를 돌려 enterCommand가 world:room을 생략하게 한다.
 */
export function buildRoomSummary(
  resolveRoom: (roomId: number) => RoomNode | undefined,
): (roomId: number) => { roomId: number; exits: string[] } | undefined {
  return (roomId) => {
    const room = resolveRoom(roomId)
    if (room === undefined) return undefined
    return { roomId: room.roomId, exits: room.exits.map((exit) => exit.name) }
  }
}

/**
 * 주입된 `LiveWorldBinding`에서 SessionContext.liveWorld를 조립한다. hydrate/place는 진입 코어에 위임하고,
 * roomSummary는 월드 그래프에서 파생한다. FSM은 이 객체의 콜백만 호출해 registry·그래프 접근을 셸에 가둔다.
 */
export function buildSessionLiveWorld(binding: LiveWorldBinding): SessionLiveWorld {
  return {
    hydrate: (characterId) => binding.entry.hydrate(characterId),
    place: (live) => binding.entry.place(live),
    roomSummary: buildRoomSummary(binding.resolveRoom),
  }
}
