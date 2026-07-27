import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode } from 'shared'
import type { LiveCharacter } from '../world/liveCharacterRegistry.js'
import type { LiveCharacterEntry } from '../world/liveCharacterEntry.js'
import { buildRoomSummary, buildSessionLiveWorld } from './liveWorldBinding.js'

/**
 * buildRoomSummary — world:room emit용 방 요약 파생 단위 스펙.
 *
 * exits는 반드시 exit **이름**(ExitEdge.name)이어야 한다(인덱스 아님 — tryMove selector 계약).
 * 미해소 방은 undefined를 반환해 enterCommand가 world:room을 건너뛴다.
 */
function makeRoom(roomId: number, exitNames: string[]): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: exitNames.map((name) => ({
      name,
      targetRoomId: roomId + 1,
      flags: [],
      key: 0,
      ltime: 0,
      interval: 60,
    })),
    items: [],
    flags: [],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

describe('buildRoomSummary', () => {
  it('해소된 방을 { roomId, exits: 이름배열 }로 요약한다 (인덱스 아닌 이름)', () => {
    const rooms = new Map<number, RoomNode>([[50, makeRoom(50, ['북', '남'])]])
    const summary = buildRoomSummary((id) => rooms.get(id))

    expect(summary(50)).toEqual({ roomId: 50, exits: ['북', '남'] })
  })

  it('출구가 없는 방은 빈 exits 배열을 준다', () => {
    const rooms = new Map<number, RoomNode>([[7, makeRoom(7, [])]])
    const summary = buildRoomSummary((id) => rooms.get(id))

    expect(summary(7)).toEqual({ roomId: 7, exits: [] })
  })

  it('미해소 방(resolveRoom undefined)은 undefined를 반환한다', () => {
    const summary = buildRoomSummary(() => undefined)

    expect(summary(9999)).toBeUndefined()
  })
})

describe('buildSessionLiveWorld', () => {
  it('hydrate/place는 진입 코어에 위임하고 roomSummary는 월드 그래프에서 파생한다', async () => {
    const character = { _id: 'char-1', currentRoom: 12 } as unknown as Character
    const live: LiveCharacter = { character }
    const hydrate = vi.fn(() => Promise.resolve(live))
    const place = vi.fn()
    const entry: LiveCharacterEntry = { hydrate, place, release: vi.fn() }
    const rooms = new Map<number, RoomNode>([[12, makeRoom(12, ['위'])]])

    const liveWorld = buildSessionLiveWorld({ entry, resolveRoom: (id) => rooms.get(id) })

    await expect(liveWorld.hydrate('char-1')).resolves.toBe(live)
    expect(hydrate).toHaveBeenCalledWith('char-1')
    liveWorld.place(live)
    expect(place).toHaveBeenCalledWith(live)
    expect(liveWorld.roomSummary(12)).toEqual({ roomId: 12, exits: ['위'] })
  })
})
