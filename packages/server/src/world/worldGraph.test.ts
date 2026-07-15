import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ItemInstance, RoomNode } from 'shared'
import { loadWorldGraph, DEFAULT_EXIT_INTERVAL_SEC } from './worldGraph.js'

// 인메모리 그래프의 모든 instanceId를 중첩 contains까지 훑어 수집한다.
function collectInstanceIds(items: readonly ItemInstance[]): string[] {
  return items.flatMap((item) => [item.instanceId, ...collectInstanceIds(item.contains)])
}

// 2방 fixture worldRoot를 만들어 콜백에 넘기고, 종료 시 정리한다.
// 결정적 단위 테스트용: 실제 데이터에 의존하지 않고 매핑·재귀·dangling을 검증한다.
function withFixtureWorld(rooms: unknown, run: (worldRoot: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'muhan-graph-'))
  writeFileSync(join(dir, 'rooms.json'), JSON.stringify(rooms))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadWorldGraph — 실제 번들', () => {
  it('정본 방 2341개를 Map으로 로드한다', () => {
    const graph = loadWorldGraph()
    expect(graph.size).toBe(2341)
  })

  it('출구 엣지를 {name,targetRoomId,flags,key,ltime:0,interval:기본값}으로 매핑하고 노드로 연결한다', () => {
    const graph = loadWorldGraph()
    const room50 = graph.get(50)
    expect(room50).toBeDefined()
    if (!room50) return

    const east = room50.exits.find((e) => e.name === '동')
    expect(east).toEqual({
      name: '동',
      targetRoomId: 69,
      flags: [0, 0, 0, 0],
      key: 0,
      ltime: 0,
      interval: DEFAULT_EXIT_INTERVAL_SEC,
    })

    // 하나 이상의 출구가 Map의 실존 노드로 해석된다(엣지가 연결됨).
    const resolvable = room50.exits.filter((e) => graph.has(e.targetRoomId))
    expect(resolvable.length).toBeGreaterThan(0)
  })

  it('바닥 아이템을 고유 instanceId를 가진 ItemInstance로 만든다', () => {
    const graph = loadWorldGraph()
    const room50 = graph.get(50)
    expect(room50).toBeDefined()
    if (!room50) return

    const pouch = room50.items.find((i) => i.name === '숨겨진 돈주머니')
    expect(pouch).toBeDefined()
    expect(pouch?.instanceId).toBeTruthy()
    expect(pouch?.value).toBe(2000)
  })

  it('그래프 전체에서 instanceId가 유일하다(중첩 contains 포함)', () => {
    const graph = loadWorldGraph()
    const allIds: string[] = []
    for (const node of graph.values()) allIds.push(...collectInstanceIds(node.items))
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('RoomNode에 monsters 필드가 없고 인메모리 필드만 갖는다(스코프 가드)', () => {
    const graph = loadWorldGraph()
    const room50 = graph.get(50)
    expect(room50).toBeDefined()
    if (!room50) return

    expect(Object.keys(room50).sort()).toEqual(
      ['exits', 'flags', 'items', 'longDesc', 'name', 'occupants', 'roomId', 'shortDesc'].sort(),
    )
    const pouch = room50.items.find((i) => i.name === '숨겨진 돈주머니')
    // 아이템에 objnum/type 같은 템플릿 필드가 새지 않았다.
    expect(Object.keys(pouch ?? {}).sort()).toEqual(
      ['contains', 'description', 'instanceId', 'name', 'value'].sort(),
    )
  })
})

describe('loadWorldGraph — fixture worldRoot 오버라이드', () => {
  const fixtureRooms = [
    {
      id: 1,
      name: '방A',
      flags: [0, 0, 0, 0, 0, 0, 0, 0],
      exits: [
        { name: '북', room: 2, flags: [0, 0, 0, 0], key: 0 }, // 실존 노드로 연결
        { name: '남', room: 9999, flags: [0, 0, 0, 0], key: 7 }, // dangling — 유지되어야 함
      ],
      monsters: [],
      items: [
        {
          name: '상자',
          description: '나무 상자',
          value: 10,
          contains: [{ name: '금화', description: '반짝인다', value: 5, contains: [] }],
        },
      ],
      short_desc: 'A단문',
      long_desc: 'A장문',
    },
    {
      id: 2,
      name: '방B',
      flags: [0, 0, 0, 0, 0, 0, 0, 0],
      exits: [],
      monsters: [],
      items: [],
      short_desc: 'B단문',
      long_desc: 'B장문',
    },
  ]

  it('worldRoot 오버라이드로 격리된 번들을 로드한다', () => {
    withFixtureWorld(fixtureRooms, (root) => {
      const graph = loadWorldGraph(root)
      expect(graph.size).toBe(2)
      const a: RoomNode | undefined = graph.get(1)
      expect(a?.shortDesc).toBe('A단문')
      expect(a?.longDesc).toBe('A장문')
    })
  })

  it('dangling 출구를 드롭하지 않고 targetRoomId를 그대로 유지한다', () => {
    withFixtureWorld(fixtureRooms, (root) => {
      const graph = loadWorldGraph(root)
      const a = graph.get(1)
      expect(a?.exits.length).toBe(2)
      const dangling = a?.exits.find((e) => e.name === '남')
      expect(dangling?.targetRoomId).toBe(9999)
      expect(dangling?.key).toBe(7)
      expect(graph.has(9999)).toBe(false)
    })
  })

  it('컨테이너의 중첩 아이템도 재귀적으로 고유 instanceId를 부여한다', () => {
    withFixtureWorld(fixtureRooms, (root) => {
      const graph = loadWorldGraph(root)
      const a = graph.get(1)
      const box = a?.items.find((i) => i.name === '상자')
      expect(box?.contains.length).toBe(1)
      const coin = box?.contains[0]
      expect(coin?.name).toBe('금화')
      expect(coin?.instanceId).toBeTruthy()
      // 중첩 아이템 id가 부모와 구별된다.
      expect(coin?.instanceId).not.toBe(box?.instanceId)
    })
  })

  it('라이브 필드를 초기화한다 — occupants 빈 Set, flags 복사 배열', () => {
    const rawFlags = [1, 2, 3, 4, 5, 6, 7, 8]
    const raw = [
      {
        id: 1,
        name: '방A',
        flags: rawFlags,
        exits: [],
        monsters: [],
        items: [],
        short_desc: 'A단문',
        long_desc: 'A장문',
      },
    ]
    withFixtureWorld(raw, (root) => {
      const graph = loadWorldGraph(root)
      const a = graph.get(1)
      expect(a?.occupants).toBeInstanceOf(Set)
      expect(a?.occupants.size).toBe(0)
      // flags는 값이 보존되되 raw 배열과 동일 참조가 아니다(복사).
      expect(a?.flags).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      // 부팅 시 flags 배열은 새로 복사되므로 원본과 값은 같아도 별개 인스턴스다.
      expect(a?.flags === rawFlags).toBe(false)
    })
  })
})
