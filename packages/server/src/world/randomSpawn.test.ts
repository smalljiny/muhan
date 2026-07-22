import { describe, it, expect } from 'vitest'
import type { RoomNode } from 'shared'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock } from './worldClock.js'
import {
  createRandomSpawn,
  defaultSpawnRng,
  RANDOM_SPAWN_INTERVAL_SEC,
  RPLWAN,
  type SpawnRng,
} from './randomSpawn.js'
import { buildSpawnTemplateIndex, createInstanceIdAllocator, type SpawnTemplate } from './spawn.js'
import { setFlag } from './door.js'

function template(over: Partial<SpawnTemplate & { id: number }> = {}): SpawnTemplate & { id: number } {
  return {
    id: 13,
    name: '배회몹',
    level: 2,
    hpmax: 10,
    mpmax: 0,
    dexterity: 14,
    gold: 50,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '0000000000000000',
    numwander: 1,
    ...over,
  }
}

function makeRoom(over: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 50,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set(['p1']),
    creatures: [],
    permMon: [],
    random: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    traffic: 50,
    ...over,
  }
}

/** 결정적 발화 rng — traffic 게이트 통과(roll100=1), 첫 후보(0), 그룹 크기=max. */
function firingRng(over: Partial<SpawnRng> = {}): SpawnRng {
  return { roll100: () => 1, pickIndex: () => 0, groupSize: (max) => max, ...over }
}

const idx = () => buildSpawnTemplateIndex([template()])

describe('createRandomSpawn — 슬롯 계약', () => {
  it("name='randomSpawn', intervalSec=20", () => {
    const slot = createRandomSpawn({ rooms: () => [], templates: idx(), alloc: createInstanceIdAllocator() })
    expect(slot.name).toBe('randomSpawn')
    expect(slot.intervalSec).toBe(RANDOM_SPAWN_INTERVAL_SEC)
    expect(slot.intervalSec).toBe(20)
  })
})

describe('traffic 게이트', () => {
  it('roll100 > traffic면 스폰하지 않는다', () => {
    const room = makeRoom({ traffic: 50 })
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ roll100: () => 51 }), // 51 > 50 → 스킵
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(0)
  })

  it('roll100 ≤ traffic면 후보를 스폰한다', () => {
    const room = makeRoom({ traffic: 50 })
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ roll100: () => 50 }), // 50 ≤ 50 → 통과
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.name).toBe('배회몹')
    expect(room.creatures[0]?.templateId).toBe(13)
  })

  it('기본 rng는 조용하다(traffic 게이트 항상 실패)', () => {
    const room = makeRoom({ traffic: 100 })
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(0)
    expect(defaultSpawnRng.roll100()).toBe(101)
  })

  it('기본 rng 스텁은 결정적이다(pickIndex=0·groupSize=1)', () => {
    expect(defaultSpawnRng.pickIndex(10)).toBe(0)
    expect(defaultSpawnRng.groupSize(5)).toBe(1)
  })
})

describe('후보 선택', () => {
  it('random[pickedIndex]가 0(빈 슬롯)이면 스킵한다', () => {
    const room = makeRoom({ random: [0, 13, 0, 0, 0, 0, 0, 0, 0, 0] })
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ pickIndex: () => 0 }), // random[0]=0 → 스킵
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(0)
  })

  it('알 수 없는 템플릿 몹번호는 스킵한다', () => {
    const room = makeRoom({ random: [999, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng(),
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(0)
  })
})

describe('그룹 크기', () => {
  it('RPLWAN 방은 방 플레이어 수만큼(mrand(1,count_ply))', () => {
    const room = makeRoom({ occupants: new Set(['p1', 'p2', 'p3']) })
    setFlag(room.flags, RPLWAN)
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ groupSize: (max) => max }), // max=occupants.size=3
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(3)
  })

  it('RPLWAN 아니고 numwander>1이면 mrand(1,numwander)', () => {
    const room = makeRoom()
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: buildSpawnTemplateIndex([template({ numwander: 3 })]),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ groupSize: (max) => max }), // max=3
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(3)
  })

  it('RPLWAN 아니고 numwander≤1이면 1마리', () => {
    const room = makeRoom()
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: buildSpawnTemplateIndex([template({ numwander: 1 })]),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ groupSize: (max) => max }),
    })
    slot.run(20)
    expect(room.creatures).toHaveLength(1)
  })
})

describe('스폰 크리처 타이머 초기화', () => {
  it('nextActionAt=now+cadence·lastScavengeAt·lastWanderAt=now', () => {
    const room = makeRoom()
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(), // dex 14 → cadence 3
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng(),
    })
    slot.run(100)
    const c = room.creatures[0]
    expect(c?.nextActionAt).toBe(103) // 100 + cadence(14)=3
    expect(c?.lastScavengeAt).toBe(100)
    expect(c?.lastWanderAt).toBe(100)
  })
})

describe('D7 monotonic idx + rng seam', () => {
  it('그룹 스폰이 monotonic idx를 발급한다(충돌 없음)', () => {
    const room = makeRoom()
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: buildSpawnTemplateIndex([template({ numwander: 3 })]),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng({ groupSize: (max) => max }),
    })
    slot.run(20)
    const ids = room.creatures.map((c) => c.instanceId)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['50:c0', '50:c1', '50:c2'])
  })

  it('carry/gold 랜덤화가 주입 creatureRng seam으로 위임된다', () => {
    const room = makeRoom()
    const slot = createRandomSpawn({
      rooms: () => [room],
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
      rng: firingRng(),
      creatureRng: () => 9,
    })
    slot.run(20)
    expect(room.creatures[0]?.gold).toBe(9)
  })
})

describe('WorldClock 통합(FakeClock 구동)', () => {
  it('20초마다 발화한다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const room = makeRoom()
    world.register(
      createRandomSpawn({
        rooms: () => [room],
        templates: idx(),
        alloc: createInstanceIdAllocator([room]),
        rng: firingRng(),
      }),
    )
    world.start()
    clock.tick(19)
    expect(room.creatures).toHaveLength(0) // 아직 20초 미도래
    clock.tick(1) // tickSec 20
    expect(room.creatures).toHaveLength(1)
  })
})
