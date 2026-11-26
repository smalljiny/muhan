import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverEventSchema, type RoomNode, type ServerEvent } from 'shared'
import { F_SET, PDMINV, PHIDDN } from '../world/hexFlags.js'
import { makeExitTo, makeRoom } from '../world/roomFixtures.testutil.js'
import type { PresenceJoinContext, PresenceLeaveContext } from '../world/presence.js'
import {
  buildPresenceEvent,
  createPresenceBroadcaster,
  type PresenceBroadcasterDeps,
} from './presenceBroadcaster.js'

/**
 * presence 방송기 단위 테스트 — 가짜 이름·플래그 조회와 전송 스파이로 검증한다.
 * 바인딩·소켓 유무 판단은 `sendToCharacter`의 몫이므로 여기서는 호출 대상만 단언한다.
 */

const ACTOR_ID = 'char-a'
const OBS_B = 'char-b'
const OBS_C = 'char-c'
const NAMES: Record<string, string> = { [ACTOR_ID]: '가나', [OBS_B]: '다라', [OBS_C]: '마바' }

const EAST = makeExitTo('동', 2)
const MOVED_OUT: PresenceLeaveContext = { change: 'moved-out', mode: 'directional', exit: EAST }
const MOVED_IN: PresenceJoinContext = { change: 'moved-in', mode: 'directional', exit: EAST }
const ENTERED: PresenceJoinContext = { change: 'entered' }
const EXITED: PresenceLeaveContext = { change: 'exited' }

function roomWith(roomId: number, ...ids: string[]): RoomNode {
  return makeRoom({ roomId, occupants: new Set(ids) })
}

function makeHarness(overrides: Partial<PresenceBroadcasterDeps> = {}) {
  const sent: Array<{ to: string; event: ServerEvent }> = []
  const deps = {
    resolveCharacterName: vi.fn((id: string): string | undefined => NAMES[id]),
    resolveActorFlags: vi.fn((_id: string): string => ''),
    sendToCharacter: vi.fn((to: string, event: ServerEvent) => {
      sent.push({ to, event })
    }),
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
  return { deps, sent, broadcaster: createPresenceBroadcaster(deps) }
}

const actor = (currentRoomId = 1) => ({ characterId: ACTOR_ID, currentRoomId })

describe('createPresenceBroadcaster', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('수신자', () => {
    it('퇴장: 출발 방의 이동자 이외 점유자 전원에게 1회씩 보낸다', () => {
      const h = makeHarness()
      const room = roomWith(1, ACTOR_ID, OBS_B, OBS_C)
      h.broadcaster.broadcastLeave(room, actor(), MOVED_OUT)
      expect(h.sent.map((s) => s.to).sort()).toEqual([OBS_B, OBS_C])
    })

    it('도착: 도착 방의 이동자 이외 점유자 전원에게 1회씩 보낸다', () => {
      const h = makeHarness()
      const room = roomWith(2, OBS_B, ACTOR_ID, OBS_C)
      h.broadcaster.broadcastJoin(room, actor(2), MOVED_IN)
      expect(h.sent.map((s) => s.to).sort()).toEqual([OBS_B, OBS_C])
    })

    it('점유자가 이동자뿐이면 보내지 않는다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID), actor(), MOVED_OUT)
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID), actor(2), ENTERED)
      expect(h.deps.sendToCharacter).not.toHaveBeenCalled()
    })

    it('이름이 해석되지 않는 점유자에게도 호출한다(건너뛰기는 sendToCharacter 몫)', () => {
      const h = makeHarness()
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, 'unbound'), actor(2), ENTERED)
      expect(h.sent.map((s) => s.to)).toEqual(['unbound'])
    })

    it('OQ2: 이미 다른 방으로 옮긴 B는 옛 방 통지를 받지 않는다', () => {
      const h = makeHarness()
      // B는 이미 방 3으로 옮겨 옛 방 1의 occupants에 없다.
      const oldRoom = roomWith(1, ACTOR_ID, OBS_C)
      h.broadcaster.broadcastLeave(oldRoom, actor(), MOVED_OUT)
      expect(h.sent.map((s) => s.to)).toEqual([OBS_C])
    })

    it('room.occupants를 변경하지 않는다', () => {
      const h = makeHarness()
      const room = roomWith(1, ACTOR_ID, OBS_B)
      h.broadcaster.broadcastLeave(room, actor(), MOVED_OUT)
      expect([...room.occupants]).toEqual([ACTOR_ID, OBS_B])
    })

    it('같은 이벤트 객체를 모든 수신자에게 보낸다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, OBS_B, OBS_C), actor(2), MOVED_IN)
      expect(h.sent).toHaveLength(2)
      expect(h.sent[0]?.event).toBe(h.sent[1]?.event)
    })
  })

  describe('이벤트 형태', () => {
    it('moved-out: roomId·subject·direction·announce를 싣고 스키마를 통과한다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastLeave(roomWith(7, ACTOR_ID, OBS_B), actor(7), MOVED_OUT)
      const event = h.sent[0]?.event
      expect(event).toEqual({
        type: 'world:presence',
        roomId: 7,
        subject: { kind: 'player', characterId: ACTOR_ID, name: '가나' },
        change: { change: 'moved-out', direction: '동', announce: true },
      })
      expect(() => serverEventSchema.parse(event)).not.toThrow()
    })

    it.each([
      ['moved-in', MOVED_IN],
      ['entered', ENTERED],
    ] as const)('%s: direction 키가 없고 스키마를 통과한다', (change, ctx) => {
      const h = makeHarness()
      h.broadcaster.broadcastJoin(roomWith(9, ACTOR_ID, OBS_B), actor(9), ctx)
      const event = h.sent[0]?.event
      expect(event).toEqual({
        type: 'world:presence',
        roomId: 9,
        subject: { kind: 'player', characterId: ACTOR_ID, name: '가나' },
        change: { change, announce: true },
      })
      expect(event && 'change' in event && 'direction' in event.change).toBe(false)
      expect(() => serverEventSchema.parse(event)).not.toThrow()
    })

    it('exited: direction 없이 announce false로 스키마를 통과한다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B), actor(), EXITED)
      const event = h.sent[0]?.event
      expect(event).toEqual({
        type: 'world:presence',
        roomId: 1,
        subject: { kind: 'player', characterId: ACTOR_ID, name: '가나' },
        change: { change: 'exited', announce: false },
      })
      expect(() => serverEventSchema.parse(event)).not.toThrow()
    })

    it.each([[undefined], ['']])('이동자 이름이 %j이면 보내지 않는다', (name) => {
      const h = makeHarness({ resolveCharacterName: vi.fn(() => name) })
      h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B), actor(), MOVED_OUT)
      h.broadcaster.broadcastJoin(roomWith(1, ACTOR_ID, OBS_B), actor(), ENTERED)
      expect(h.deps.sendToCharacter).not.toHaveBeenCalled()
    })
  })

  describe('announce 억제 (G3)', () => {
    it('재현 1: PHIDDN 이동자의 moved-in은 announce false로 B에게 간다', () => {
      const h = makeHarness({ resolveActorFlags: vi.fn(() => F_SET('', PHIDDN)) })
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, OBS_B), actor(2), MOVED_IN)
      expect(h.sent.map((s) => s.to)).toEqual([OBS_B])
      expect(h.sent[0]?.event).toMatchObject({ change: { change: 'moved-in', announce: false } })
    })

    it('재현 2: PDMINV 이동자의 moved-out은 announce false로 B에게 간다', () => {
      const h = makeHarness({ resolveActorFlags: vi.fn(() => F_SET('', PDMINV)) })
      h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B), actor(), MOVED_OUT)
      expect(h.sent.map((s) => s.to)).toEqual([OBS_B])
      expect(h.sent[0]?.event).toMatchObject({
        change: { change: 'moved-out', direction: '동', announce: false },
      })
    })

    it('PHIDDN 이동자의 moved-out은 announce true다(퇴장 은신 비대칭)', () => {
      const h = makeHarness({ resolveActorFlags: vi.fn(() => F_SET('', PHIDDN)) })
      h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B), actor(), MOVED_OUT)
      expect(h.sent[0]?.event).toMatchObject({ change: { announce: true } })
    })

    it('플래그는 이동자 characterId로 조회한다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, OBS_B), actor(2), ENTERED)
      expect(h.deps.resolveActorFlags).toHaveBeenCalledWith(ACTOR_ID)
    })
  })

  describe('예외 계약 — 방송기는 예외를 밖으로 던지지 않는다', () => {
    let boom: Error
    beforeEach(() => {
      boom = new Error('boom')
    })

    it('한 수신자 전송이 던져도 나머지 수신자에게 보내고 로깅한다', () => {
      const delivered: string[] = []
      const h = makeHarness({
        sendToCharacter: vi.fn((to: string) => {
          if (to === OBS_B) throw boom
          delivered.push(to)
        }),
      })
      const room = roomWith(1, ACTOR_ID, OBS_B, OBS_C)
      expect(() => h.broadcaster.broadcastLeave(room, actor(), MOVED_OUT)).not.toThrow()
      expect(delivered).toEqual([OBS_C])
      expect(h.deps.logger.error).toHaveBeenCalledTimes(1)
      expect(h.deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: boom, characterId: OBS_B }),
        expect.any(String),
      )
    })

    it('이름 조회가 던지면 보내지 않고 로깅한다', () => {
      const h = makeHarness({
        resolveCharacterName: vi.fn(() => {
          throw boom
        }),
      })
      expect(() =>
        h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, OBS_B), actor(2), MOVED_IN),
      ).not.toThrow()
      expect(h.deps.sendToCharacter).not.toHaveBeenCalled()
      expect(h.deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: boom }),
        expect.any(String),
      )
    })

    it('플래그 조회가 던지면 보내지 않고 로깅한다', () => {
      const h = makeHarness({
        resolveActorFlags: vi.fn(() => {
          throw boom
        }),
      })
      expect(() =>
        h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B), actor(), MOVED_OUT),
      ).not.toThrow()
      expect(h.deps.sendToCharacter).not.toHaveBeenCalled()
      expect(h.deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: boom }),
        expect.any(String),
      )
    })

    it('도착 방송에서도 한 수신자 전송 실패가 나머지 전송을 막지 않는다', () => {
      const delivered: string[] = []
      const h = makeHarness({
        sendToCharacter: vi.fn((to: string) => {
          if (to === OBS_B) throw boom
          delivered.push(to)
        }),
      })
      const room = roomWith(2, ACTOR_ID, OBS_B, OBS_C)
      expect(() => h.broadcaster.broadcastJoin(room, actor(2), MOVED_IN)).not.toThrow()
      expect(delivered).toEqual([OBS_C])
    })

    it('전송 실패를 기록하는 logger.error가 던져도 밖으로 새지 않는다', () => {
      const h = makeHarness({
        sendToCharacter: vi.fn(() => {
          throw boom
        }),
      })
      vi.mocked(h.deps.logger.error).mockImplementation(() => {
        throw new Error('logger down')
      })
      expect(() =>
        h.broadcaster.broadcastLeave(roomWith(1, ACTOR_ID, OBS_B, OBS_C), actor(), MOVED_OUT),
      ).not.toThrow()
      expect(h.deps.sendToCharacter).toHaveBeenCalledTimes(2)
    })

    it('정상 경로에서는 로깅하지 않는다', () => {
      const h = makeHarness()
      h.broadcaster.broadcastJoin(roomWith(2, ACTOR_ID, OBS_B), actor(2), ENTERED)
      expect(h.deps.logger.error).not.toHaveBeenCalled()
    })
  })
})

describe('buildPresenceEvent', () => {
  const subject = { characterId: ACTOR_ID, name: '가나' }

  it('moved-out에만 direction(ctx.exit.name)을 싣는다', () => {
    expect(buildPresenceEvent(3, subject, MOVED_OUT, false)).toEqual({
      type: 'world:presence',
      roomId: 3,
      subject: { kind: 'player', characterId: ACTOR_ID, name: '가나' },
      change: { change: 'moved-out', direction: '동', announce: false },
    })
  })

  it('moved-in은 mode·exit을 싣지 않는다', () => {
    expect(buildPresenceEvent(3, subject, MOVED_IN, true)).toEqual({
      type: 'world:presence',
      roomId: 3,
      subject: { kind: 'player', characterId: ACTOR_ID, name: '가나' },
      change: { change: 'moved-in', announce: true },
    })
  })
})
