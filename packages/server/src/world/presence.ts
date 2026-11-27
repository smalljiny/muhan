/**
 * 방 입·퇴장 통지(presence) 문맥 타입과 `announce` 판정 순수 함수.
 *
 * 원본 근거 (`legacy/muhan/src`):
 * - 이동 퇴장 — `command2.c` `move()`: `"%M이 %s쪽으로 갔습니다."`를 출발 방의 다른 플레이어에게
 *   보내며, 이동자가 DM 투명(`PDMINV`)이면 보내지 않는다.
 * - 도착 — `room.c` `add_ply_rom()`: `"%M%j 도착하였습니다."`를 도착 방의 다른 플레이어에게 보내며,
 *   이동자가 DM 투명(`PDMINV`) 또는 은신(`PHIDDN`)이면 보내지 않는다. 이동 도착과 접속 진입이 같은
 *   함수를 지나므로 `moved-in`과 `entered`는 같은 규칙을 따른다.
 * - 접속 종료 — `player.c` `uninit_ply()`: 방 메시지가 없다. 그래서 `exited`는 항상 억제한다.
 *
 * 퇴장은 은신(`PHIDDN`)을 억제하지 않고 도착만 억제한다. 원본 그대로의 비대칭이다(as-shipped).
 *
 * 억제는 이벤트를 막지 않고 `announce`만 `false`로 만든다(점유자 목록 동기화는 항상 수행).
 * 판정은 이동자 플래그만 보고 수신자를 받지 않는다 — 받는 사람별 가시성은 이 모듈의 범위가 아니다.
 */
import type { ExitEdge, RoomNode } from 'shared'
import { F_ISSET, PDMINV, PHIDDN } from './hexFlags.js'
// type-only import라 tryMove.ts와의 순환은 컴파일 시 지워진다.
import type { MoveActor, MoveMode } from './tryMove.js'

/** 점유 변화 종류 — `world:presence` 이벤트의 `change`와 같은 값. */
export type PresenceChange = 'moved-out' | 'moved-in' | 'entered' | 'exited'

/** 퇴장 방송 문맥 — 이동 퇴장(모드·사용 출구 포함) 또는 세션 종료로 인한 점유 해제. */
export type PresenceLeaveContext =
  | { readonly change: 'moved-out'; readonly mode: MoveMode; readonly exit: ExitEdge }
  | { readonly change: 'exited' }

/** 도착 방송 문맥 — 이동 도착(모드·사용 출구 포함) 또는 접속 진입으로 인한 점유. */
export type PresenceJoinContext =
  | { readonly change: 'moved-in'; readonly mode: MoveMode; readonly exit: ExitEdge }
  | { readonly change: 'entered' }

/**
 * 이동자 플래그(hex string)와 변화 종류로 원본 메시지 표시 여부(`announce`)를 판정한다.
 *
 * | change | false가 되는 조건 |
 * |---|---|
 * | moved-out | PDMINV |
 * | moved-in, entered | PDMINV 또는 PHIDDN |
 * | exited | 항상 |
 */
export function isPresenceAnnounced(flags: string, change: PresenceChange): boolean {
  switch (change) {
    case 'moved-out':
      return !F_ISSET(flags, PDMINV)
    case 'moved-in':
    case 'entered':
      return !F_ISSET(flags, PDMINV) && !F_ISSET(flags, PHIDDN)
    case 'exited':
      return false
  }
}

/** 전송이 연결되지 않은 호출자의 기본 퇴장 방송 — no-op. */
export const noopBroadcastLeave = (
  _room: RoomNode,
  _actor: MoveActor,
  _ctx: PresenceLeaveContext,
): void => {}

/** 전송이 연결되지 않은 호출자의 기본 도착 방송 — no-op. */
export const noopBroadcastJoin = (
  _room: RoomNode,
  _actor: MoveActor,
  _ctx: PresenceJoinContext,
): void => {}
