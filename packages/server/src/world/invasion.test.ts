import { describe, it, expect, vi } from 'vitest'
import type { RoomNode } from 'shared'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock } from './worldClock.js'
import {
  createInvasion,
  loadInvasionEvents,
  defaultInvasionRng,
  defaultSpawnBroadcast,
  type InvasionEvent,
} from './invasion.js'
import { buildSpawnTemplateIndex, createInstanceIdAllocator, type SpawnTemplate } from './spawn.js'

function template(over: Partial<SpawnTemplate & { id: number }> = {}): SpawnTemplate & { id: number } {
  return {
    id: 732,
    name: '침공몹',
    level: 5,
    hpmax: 30,
    mpmax: 0,
    dexterity: 14,
    gold: 20,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    flags: '0000000000000000',
    numwander: 1,
    ...over,
  }
}

function makeRoom(roomId: number): RoomNode {
  return {
    roomId,
    name: '침공방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
    ...{},
  }
}

const EVENT1: InvasionEvent = {
  id: 'chaos-invasion',
  periodSec: 4000,
  roomRange: { min: 8000, max: 8300 },
  mobRange: { min: 732, max: 755 },
  count: 3,
  broadcast: '카오스 침공',
}
const EVENT2: InvasionEvent = {
  id: 'muhan-zone-raid',
  periodSec: 5000,
  roomRange: { min: 3601, max: 3630 },
  mobRange: { min: 265, max: 299 },
  count: 2,
  broadcast: '무적존 강탈',
}

/** min을 반환하는 결정적 rng — 방=roomRange.min, 몹=mobRange.min 선택. */
const minRng = (min: number) => min

function graphOf(...rooms: RoomNode[]): Map<number, RoomNode> {
  return new Map(rooms.map((r) => [r.roomId, r]))
}

describe('createInvasion — 이벤트당 슬롯', () => {
  it('이벤트마다 name=invasion:<id>·intervalSec=periodSec 슬롯을 만든다', () => {
    const slots = createInvasion({
      events: [EVENT1, EVENT2],
      resolveRoom: () => undefined,
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator(),
    })
    expect(slots).toHaveLength(2)
    expect(slots[0]?.name).toBe('invasion:chaos-invasion')
    expect(slots[0]?.intervalSec).toBe(4000)
    expect(slots[1]?.name).toBe('invasion:muhan-zone-raid')
    expect(slots[1]?.intervalSec).toBe(5000)
  })

  it('이벤트가 없으면 빈 배열이다', () => {
    const slots = createInvasion({
      events: [],
      resolveRoom: () => undefined,
      templates: buildSpawnTemplateIndex([]),
      alloc: createInstanceIdAllocator(),
    })
    expect(slots).toEqual([])
  })
})

describe('발화 시 스폰·방송', () => {
  it('슬롯 발화 시 count회 스폰하고 방송한다', () => {
    const room = makeRoom(8000) // roomRange.min
    const broadcast = vi.fn()
    const [slot] = createInvasion({
      events: [EVENT1],
      resolveRoom: (id) => graphOf(room).get(id),
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator([room]),
      rng: minRng,
      broadcast,
    })
    slot?.run(0) // 발화 시점 게이팅은 WorldClock 소관 — 슬롯 run은 tickSec를 쓰지 않는다
    expect(room.creatures).toHaveLength(3) // count=3, 방=8000 해석됨
    expect(room.creatures[0]?.templateId).toBe(732) // mobRange.min
    expect(broadcast).toHaveBeenCalledWith('카오스 침공')
  })

  it('이벤트마다 독립 슬롯이 자기 이벤트만 스폰한다', () => {
    const r1 = makeRoom(8000)
    const r2 = makeRoom(3601)
    const slots = createInvasion({
      events: [EVENT1, EVENT2],
      resolveRoom: (id) => graphOf(r1, r2).get(id),
      templates: buildSpawnTemplateIndex([template({ id: 732 }), template({ id: 265, name: '침공몹2' })]),
      alloc: createInstanceIdAllocator([r1, r2]),
      rng: minRng,
    })
    const raid = slots.find((s) => s.name === 'invasion:muhan-zone-raid')
    raid?.run(0) // raid 슬롯만 발화 — chaos 슬롯은 건드리지 않음
    expect(r1.creatures).toHaveLength(0)
    expect(r2.creatures).toHaveLength(2)
  })
})

describe('그래프에 없는 방 스킵', () => {
  it('선택 방이 그래프에 없으면 스폰을 건너뛴다', () => {
    const broadcast = vi.fn()
    const [slot] = createInvasion({
      events: [EVENT1],
      resolveRoom: () => undefined, // 어떤 방도 해석 안 됨
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator(),
      rng: minRng,
      broadcast,
    })
    slot?.run(0)
    expect(broadcast).toHaveBeenCalledWith('카오스 침공') // 방송은 발화 시 나간다
  })

  it('알 수 없는 몹 템플릿은 스폰하지 않는다', () => {
    const room = makeRoom(8000)
    const [slot] = createInvasion({
      events: [EVENT1],
      resolveRoom: (id) => graphOf(room).get(id),
      templates: buildSpawnTemplateIndex([]), // 템플릿 없음
      alloc: createInstanceIdAllocator([room]),
      rng: minRng,
    })
    slot?.run(0)
    expect(room.creatures).toHaveLength(0)
  })
})

describe('D7 monotonic idx + seam 기본값', () => {
  it('스폰이 monotonic idx를 발급한다', () => {
    const room = makeRoom(8000)
    const [slot] = createInvasion({
      events: [EVENT1],
      resolveRoom: (id) => graphOf(room).get(id),
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator([room]),
      rng: minRng,
    })
    slot?.run(0)
    const ids = room.creatures.map((c) => c.instanceId)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['8000:c0', '8000:c1', '8000:c2'])
  })

  it('기본 방송 seam은 no-op이고, 기본 rng는 min을 고른다', () => {
    expect(defaultSpawnBroadcast('x')).toBeUndefined()
    expect(defaultInvasionRng(732, 755)).toBe(732)
  })
})

describe('WorldClock 통합(FakeClock 구동)', () => {
  it('event1이 4000초에 발화한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const room = makeRoom(8000)
    // 발화 시점 게이팅은 WorldClock의 슬롯별 modulo가 담당한다(슬롯 내부 gcd 없음).
    for (const slot of createInvasion({
      events: [EVENT1],
      resolveRoom: (id) => graphOf(room).get(id),
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator([room]),
      rng: minRng,
    })) {
      world.register(slot)
    }
    world.start()
    clock.tick(3999)
    expect(room.creatures).toHaveLength(0)
    clock.tick(1) // tickSec 4000
    expect(room.creatures).toHaveLength(3)
  })
})

describe('loadInvasionEvents — data/world/events.json 스키마', () => {
  it('events.json을 읽어 방 풀·몹 풀·주기·count·방송을 담는다', () => {
    const events = loadInvasionEvents()
    expect(events.length).toBeGreaterThanOrEqual(2)
    const chaos = events.find((e) => e.id === 'chaos-invasion')
    expect(chaos).toBeDefined()
    expect(chaos?.periodSec).toBe(4000)
    expect(chaos?.roomRange).toEqual({ min: 8000, max: 8300 })
    expect(chaos?.mobRange).toEqual({ min: 732, max: 755 })
    expect(chaos?.count).toBe(50)
    expect(chaos?.broadcast).toContain('침공')
    const raid = events.find((e) => e.id === 'muhan-zone-raid')
    expect(raid?.periodSec).toBe(5000)
    expect(raid?.roomRange).toEqual({ min: 3601, max: 3630 })
    expect(raid?.mobRange).toEqual({ min: 265, max: 299 })
    expect(raid?.count).toBe(10)
  })
})
