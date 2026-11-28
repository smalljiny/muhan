import type { RoomNode, ServerEvent } from 'shared'
import type { EntryLogger } from '../world/liveCharacterEntry.js'
import {
  isPresenceAnnounced,
  type PresenceJoinContext,
  type PresenceLeaveContext,
} from '../world/presence.js'
import type { MoveActor, TryMoveDeps } from '../world/tryMove.js'

/**
 * presence 방송기 — 이동자의 이름·플래그와 방송 문맥으로 `world:presence` 이벤트를 만들어
 * 방의 이동자 이외 점유자에게 `sendToCharacter`로 보낸다.
 *
 * - 수신자는 호출 시점의 `room.occupants`에서 이동자를 뺀 전원이다. 퇴장은 이동자가 아직 출발 방
 *   점유자, 도착은 이미 도착 방 점유자인 상태로 호출된다. 이미 방을 떠난 점유자는 받지 않는다(OQ2).
 * - 바인딩·소켓 유무 판단은 `sendToCharacter`가 맡는다. 방송기는 점유자를 걸러 내지 않는다.
 * - 이름이 해석되지 않는(undefined·빈 문자열) 이동자는 이벤트를 만들지 않는다 — `projectRoomView`가
 *   그런 점유자를 목록에서 빼는 기준과 같다.
 * - `announce`는 이동자 플래그만으로 판정한다(`isPresenceAnnounced`). 받는 사람별 가시성은 #129 몫이라
 *   이벤트 객체를 한 번 만들어 모든 수신자에게 같은 값을 보낸다.
 *
 * 예외 계약: 방송기는 **절대 예외를 밖으로 던지지 않는다**. 호출자(`tryMove`, 진입 코어의
 * `place/release`)는 방송 뒤에 점유 상태 갱신을 이어 가므로, 방송 예외가 새면 갱신이 중간에 끊긴다.
 * 이름·플래그 조회 실패는 이번 방송 전체를 건너뛰고, 수신자별 전송 실패는 그 수신자만 건너뛴 뒤
 * 나머지 수신자에게 계속 보낸다. 어느 쪽이든 `logger.error`로 흔적을 남긴다(무로그 삼킴 금지).
 */

/** 방송기 logger seam — 진입 코어의 `EntryLogger` 관례를 그대로 쓴다(라이브 월드 묶음 logger와 호환). */
export type PresenceBroadcasterLogger = Pick<EntryLogger, 'error'>

export interface PresenceBroadcasterDeps {
  /** 이동자 표시 이름 조회. 미해석이면 undefined. */
  readonly resolveCharacterName: (characterId: string) => string | undefined
  /** 이동자 플래그(hex string) 조회 — PHIDDN·PDMINV 억제 판정 입력. */
  readonly resolveActorFlags: (characterId: string) => string
  /** 한 캐릭터에게 이벤트 전송. 바인딩·소켓이 없으면 조용히 건너뛰는 것은 구현의 몫. */
  readonly sendToCharacter: (characterId: string, event: ServerEvent) => void
  /** 조회·전송 예외를 삼킬 때 흔적을 남긴다. */
  readonly logger: PresenceBroadcasterLogger
}

export interface PresenceBroadcaster {
  readonly broadcastLeave: TryMoveDeps['broadcastLeave']
  readonly broadcastJoin: TryMoveDeps['broadcastJoin']
}

/** `world:presence` 이벤트 타입. */
export type PresenceEvent = Extract<ServerEvent, { type: 'world:presence' }>

/** 이벤트 주체(이동자) 참조. */
export interface PresenceSubject {
  readonly characterId: string
  readonly name: string
}

/**
 * `world:presence` 이벤트를 만드는 순수 헬퍼. `moved-out`에만 `direction`(사용 출구 이름)을 싣고,
 * 나머지 변화에는 `direction` 키를 두지 않는다. `mode`는 이벤트에 싣지 않는다.
 */
export function buildPresenceEvent(
  roomId: number,
  subject: PresenceSubject,
  ctx: PresenceLeaveContext | PresenceJoinContext,
  announce: boolean,
): PresenceEvent {
  return {
    type: 'world:presence',
    roomId,
    subject: { kind: 'player', characterId: subject.characterId, name: subject.name },
    change: toWireChange(ctx, announce),
  }
}

// exited는 스키마가 announce false 리터럴만 허용하므로 인자와 무관하게 false다.
function toWireChange(
  ctx: PresenceLeaveContext | PresenceJoinContext,
  announce: boolean,
): PresenceEvent['change'] {
  switch (ctx.change) {
    case 'moved-out':
      return { change: 'moved-out', direction: ctx.exit.name, announce }
    case 'exited':
      return { change: 'exited', announce: false }
    case 'moved-in':
    case 'entered':
      return { change: ctx.change, announce }
  }
}

/** 절대 던지지 않는 error 로거 — `safeLogError`가 만든다. */
export type SafeLogError = (fields: Record<string, unknown>, msg: string) => void

/**
 * 로깅 자체의 실패도 호출자로 새지 않게 삼키는 error 로거를 만든다. "절대 던지지 않는다" 계약을 진
 * 전송 경로(presence 방송기·라운드 통지기)와 전투 tick 래퍼(몬스터 단위 격리 로그)가 공유한다.
 */
export function safeLogError(logger: PresenceBroadcasterLogger): SafeLogError {
  return (fields, msg) => {
    try {
      logger.error(fields, msg)
    } catch {
      // 의도적으로 무시 — 호출자는 어떤 경우에도 던지지 않는다.
    }
  }
}

export function createPresenceBroadcaster(deps: PresenceBroadcasterDeps): PresenceBroadcaster {
  // 로깅 자체의 실패도 호출자(점유 상태 갱신 경로)로 새지 않게 삼킨다.
  const logError = safeLogError(deps.logger)

  // 이름·플래그 조회 → 이벤트 생성. 조회 실패·이름 미해석이면 undefined(방송 생략).
  const prepare = (
    room: RoomNode,
    actor: MoveActor,
    ctx: PresenceLeaveContext | PresenceJoinContext,
  ): PresenceEvent | undefined => {
    try {
      const name = deps.resolveCharacterName(actor.characterId)
      if (name === undefined || name === '') return undefined
      const announce = isPresenceAnnounced(deps.resolveActorFlags(actor.characterId), ctx.change)
      return buildPresenceEvent(
        room.roomId,
        { characterId: actor.characterId, name },
        ctx,
        announce,
      )
    } catch (err) {
      logError(
        { err, actorId: actor.characterId, roomId: room.roomId, change: ctx.change },
        'presence 방송 준비 실패 — 이번 방송을 건너뛴다',
      )
      return undefined
    }
  }

  // 수신자는 호출 시점 점유자 스냅샷이다(전송 중 재진입으로 Set이 바뀌어도 대상이 흔들리지 않는다).
  // room.occupants는 읽기만 한다. 수신자별 실패는 그 수신자만 건너뛴다.
  const deliver = (room: RoomNode, actor: MoveActor, event: PresenceEvent): void => {
    for (const characterId of [...room.occupants]) {
      if (characterId === actor.characterId) continue
      try {
        deps.sendToCharacter(characterId, event)
      } catch (err) {
        logError(
          {
            err,
            characterId,
            actorId: actor.characterId,
            roomId: room.roomId,
            change: event.change.change,
          },
          'presence 전송 실패 — 이 수신자만 건너뛴다',
        )
      }
    }
  }

  const broadcast = (
    room: RoomNode,
    actor: MoveActor,
    ctx: PresenceLeaveContext | PresenceJoinContext,
  ): void => {
    try {
      const event = prepare(room, actor, ctx)
      if (event !== undefined) deliver(room, actor, event)
    } catch (err) {
      // 최후 방어선 — 위 단계별 catch 밖에서 난 예외(예: 점유자 순회)도 호출자로 새지 않게 한다.
      logError({ err, actorId: actor.characterId, roomId: room.roomId }, 'presence 방송 실패')
    }
  }

  return { broadcastLeave: broadcast, broadcastJoin: broadcast }
}
