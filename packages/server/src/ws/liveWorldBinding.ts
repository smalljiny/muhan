import type { RoomNode } from 'shared'
import type { LiveCharacterEntry } from '../world/liveCharacterEntry.js'
import { projectRoomView, type RoomView } from '../world/roomView.js'
import type { SessionLiveWorld } from './fsm/sessionFsm.js'

/**
 * 라이브 월드 진입 seam의 셸측 배선(Story 4) — `SessionContext.liveWorld`를 조립하는 단위.
 *
 * FSM(sessionFsm.ts)은 3층 경계를 지켜 registry·월드 그래프를 직접 만지지 않고 주입된 콜백만 쓴다.
 * 이 모듈이 그 콜백을 실 `LiveCharacterEntry`(hydrate/place)와 월드 그래프(roomSummary)로 배선한다.
 * 라이브 월드 의존이 주입될 때만 구성하고, 미주입이면 `buildSession`이 `liveWorld`를 undefined로 둔다(T4.5).
 */

/**
 * buildSession에 주입되는 라이브 월드 의존 — 진입 코어(entry)·방 해소자(월드 그래프)·점유자 이름 해소자.
 *
 * `resolveCharacterName`은 방 점유자 characterId를 표시 이름으로 바꾸는 seam이다(라이브 레지스트리 조회).
 * 미접속·미해소 id에는 `undefined`를 돌려주며, 그런 점유자는 방 뷰에서 빠진다. 이동 seam(MoveHandlerDeps)과
 * **같은 클로저 인스턴스**를 공유해야 진입·이동 페이로드가 분기하지 않는다(liveWorldWiring 단일 공유 불변식 #3).
 */
export interface LiveWorldBinding {
  readonly entry: LiveCharacterEntry
  readonly resolveRoom: (roomId: number) => RoomNode | undefined
  readonly resolveCharacterName: (characterId: string) => string | undefined
}

/**
 * roomId → world:room 방 뷰 파생기를 만든다. 투영 규칙(숨김 아이템·크리처·비밀 출구 제외, 점유자 이름
 * 해소)은 전부 `projectRoomView`가 소유하고 이 함수는 방 해소만 얹는다 — 이동 경로(handlers/move.ts)가
 * 같은 투영을 직접 호출하므로 진입·이동 페이로드가 구조적으로 같다.
 *
 * exits는 반드시 exit **이름**(ExitEdge.name)이다 — `world:room.exits`는 이름 목록이지 인덱스가 아니다
 * (tryMove selector 계약, tryMove.ts:145). 미해소 방은 undefined를 돌려 enterCommand가 world:room을 생략하게 한다.
 */
export function buildRoomSummary(
  resolveRoom: (roomId: number) => RoomNode | undefined,
  resolveCharacterName: (characterId: string) => string | undefined,
): (roomId: number) => RoomView | undefined {
  return (roomId) => {
    const room = resolveRoom(roomId)
    if (room === undefined) return undefined
    return projectRoomView(room, resolveCharacterName)
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
    roomSummary: buildRoomSummary(binding.resolveRoom, binding.resolveCharacterName),
  }
}
