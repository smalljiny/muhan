import { describe, it, expect } from 'vitest'
import { getDirectionHints, type ExitEdge, type RoomNode } from './worldGraph.js'

// 방향 힌트 검증용 최소 RoomNode를 만든다. exits만 의미가 있으므로 나머지는 빈 기본값.
function makeRoom(exitNames: string[]): RoomNode {
  const exits: ExitEdge[] = exitNames.map((name, i) => ({
    name,
    targetRoomId: i + 100,
    flags: [0, 0, 0, 0],
    key: 0,
    ltime: 0,
    interval: 60,
  }))
  return {
    roomId: 1,
    name: '테스트방',
    shortDesc: '단문',
    longDesc: '장문',
    exits,
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

describe('getDirectionHints', () => {
  it('기본 6방향(동/서/남/북/위/밑) 출구를 cardinal로 분류한다', () => {
    const room = makeRoom(['동', '서', '남', '북', '위', '밑'])
    const hints = getDirectionHints(room)
    expect(hints.cardinal.map((e) => e.name).sort()).toEqual(
      ['남', '동', '밑', '북', '서', '위'].sort(),
    )
    expect(hints.other).toEqual([])
  })

  it('명명 출구와 대각 출구를 other로 분류한다', () => {
    const room = makeRoom(['거실', '남서', '북동', '밖', '문'])
    const hints = getDirectionHints(room)
    expect(hints.cardinal).toEqual([])
    expect(hints.other.map((e) => e.name).sort()).toEqual(
      ['거실', '남서', '북동', '밖', '문'].sort(),
    )
  })

  it('혼합 출구를 cardinal과 other로 분리한다', () => {
    const room = makeRoom(['동', '거실', '북', '남서'])
    const hints = getDirectionHints(room)
    expect(hints.cardinal.map((e) => e.name).sort()).toEqual(['동', '북'].sort())
    expect(hints.other.map((e) => e.name).sort()).toEqual(['거실', '남서'].sort())
  })

  it('출구가 없으면 빈 cardinal·other를 반환한다', () => {
    const room = makeRoom([])
    expect(getDirectionHints(room)).toEqual({ cardinal: [], other: [] })
  })

  it('순수 함수 — 같은 입력에 같은 출력, 입력을 변형하지 않는다', () => {
    const room = makeRoom(['동', '거실'])
    const snapshot = JSON.stringify({
      exits: room.exits,
      flags: room.flags,
      roomId: room.roomId,
    })

    const first = getDirectionHints(room)
    const second = getDirectionHints(room)
    expect(first).toEqual(second)

    // 입력 room·exits가 변형되지 않았다.
    expect(JSON.stringify({ exits: room.exits, flags: room.flags, roomId: room.roomId })).toBe(
      snapshot,
    )
    // 좌표를 합성하지 않는다.
    expect('x' in first).toBe(false)
    expect('y' in first).toBe(false)
    expect('z' in first).toBe(false)
  })
})
