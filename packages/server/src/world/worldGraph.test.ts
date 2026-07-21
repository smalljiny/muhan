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
    // D8: scavenge 제외 판정용 object flags(hex string) 전파. 돈주머니는 0300(OPERMT|OHIDDN).
    expect(pouch?.flags).toBe('0300000000000000')
  })

  it('그래프 전체에서 instanceId가 유일하다(중첩 contains 포함)', () => {
    const graph = loadWorldGraph()
    const allIds: string[] = []
    for (const node of graph.values()) allIds.push(...collectInstanceIds(node.items))
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('RoomNode는 라이브 필드 + 스폰 필드만 갖고 raw monsters 필드는 새지 않는다(스코프 가드)', () => {
    const graph = loadWorldGraph()
    const room50 = graph.get(50)
    expect(room50).toBeDefined()
    if (!room50) return

    // raw `monsters`/`perm_mon`는 creatures/permMon 인메모리 필드로 매핑되고 raw 키는 새지 않는다.
    expect(Object.keys(room50).sort()).toEqual(
      [
        'creatures',
        'exits',
        'flags',
        'items',
        'longDesc',
        'name',
        'occupants',
        'permMon',
        'random',
        'roomId',
        'shortDesc',
        'traffic',
      ].sort(),
    )
    const pouch = room50.items.find((i) => i.name === '숨겨진 돈주머니')
    // 아이템에 objnum/type 같은 템플릿 필드가 새지 않았다.
    expect(Object.keys(pouch ?? {}).sort()).toEqual(
      ['contains', 'description', 'flags', 'instanceId', 'name', 'value'].sort(),
    )
  })

  it('방 embedded 몬스터를 creatures[]로 물질화한다(템플릿 재인스턴스화 아님, 방135 좀도둑 2마리)', () => {
    const graph = loadWorldGraph()
    const room135 = graph.get(135)
    expect(room135).toBeDefined()
    if (!room135) return

    expect(room135.creatures.length).toBe(2)
    const thief = room135.creatures[0]
    expect(thief).toBeDefined()
    if (!thief) return
    // embedded 인라인 데이터로 물질화 → templateId=null(템플릿 링크 재구성 아님).
    expect(thief.templateId).toBeNull()
    expect(thief.name).toBe('좀도둑')
    // 빌더 커스터마이즈 스탯(템플릿 123과 다른 embedded 값)이 그대로 실린다.
    expect(thief.hpmax).toBe(7)
    expect(thief.level).toBe(4)
    expect(thief.dexterity).toBe(14)
    expect(thief.gold).toBe(80)
    expect(thief.flags).toBe('0112000000000000')
    expect(thief.instanceId).toBe('135:c0')
    // D6: rooms.json monsters[]의 전투 스탯이 물질화 시점에 인스턴스로 옮겨진다(RawMonster → materialize).
    expect(thief.armor).toBe(90)
    expect(thief.thaco).toBe(17)
    expect(thief.ndice).toBe(1)
    expect(thief.sdice).toBe(5)
    expect(thief.pdice).toBe(0)
  })

  it('rooms.json 번들의 스폰 필드를 RoomNode에 싣는다(방135 traffic·random·permMon)', () => {
    const graph = loadWorldGraph()
    const room135 = graph.get(135)
    expect(room135).toBeDefined()
    if (!room135) return

    expect(room135.traffic).toBe(10)
    expect(room135.random).toEqual([13, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(room135.permMon.length).toBe(10)
    expect(room135.permMon[0]).toEqual({ interval: 100, ltime: 871640363, misc: 123 })
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
