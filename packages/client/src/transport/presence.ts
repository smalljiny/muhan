// world:presence 델타를 방 상태에 반영하는 순수 함수 — 점유자 목록 갱신과 원본 문장 알림 조립.
// 문장은 원본처럼 조사를 계산하지 않는 고정 문장이다: 원본은 플레이어 이름 뒤에 항상 `님`을 붙이므로
// 받침 유무와 상관없이 `<이름>님이 …`가 된다. exited는 원본이 알리지 않아 문장이 없다.

import type { ServerEvent } from 'shared/protocol'
import type { RoomState } from './wsClient.js'

/** 방 입·퇴장 통지 이벤트. */
export type PresenceEvent = Extract<ServerEvent, { type: 'world:presence' }>

/** 방 상태가 유지하는 최근 알림 문장 수 상한. */
export const NOTICE_LIMIT = 20

/** 통지를 원본 문장으로 만든다. 문장이 없는 변화(exited)는 null이다. announce 여부는 보지 않는다. */
export function formatPresenceNotice(event: PresenceEvent): string | null {
  const name = event.subject.name
  switch (event.change.change) {
    case 'moved-out':
      return `${name}님이 ${event.change.direction}쪽으로 갔습니다.`
    case 'moved-in':
    case 'entered':
      return `${name}님이 도착하였습니다.`
    case 'exited':
      return null
  }
}

/** 변화에 따라 점유자 목록을 고친다 — announce와 상관없이 항상 반영한다. */
function nextOccupants(
  occupants: RoomState['occupants'],
  event: PresenceEvent,
): RoomState['occupants'] {
  const { characterId, name } = event.subject
  const present = occupants.some((o) => o.characterId === characterId)
  switch (event.change.change) {
    case 'moved-in':
    case 'entered':
      return present ? occupants : [...occupants, { characterId, name }]
    case 'moved-out':
    case 'exited':
      return present ? occupants.filter((o) => o.characterId !== characterId) : occupants
  }
}

/** announce: true인 통지만 문장을 붙이고 최근 NOTICE_LIMIT개만 남긴다. */
function nextNotices(notices: RoomState['notices'], event: PresenceEvent): RoomState['notices'] {
  if (!event.change.announce) return notices
  const sentence = formatPresenceNotice(event)
  if (sentence === null) return notices
  return [...notices, sentence].slice(-NOTICE_LIMIT)
}

/**
 * 통지를 방 상태에 불변 반영한다. roomId 일치 여부는 호출자(dispatch)가 거른다 — 이 함수는 받은
 * 통지가 현재 방의 것이라고 가정한다.
 */
export function applyPresence(room: RoomState, event: PresenceEvent): RoomState {
  return {
    ...room,
    occupants: nextOccupants(room.occupants, event),
    notices: nextNotices(room.notices, event),
  }
}
