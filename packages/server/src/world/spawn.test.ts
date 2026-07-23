import { describe, it, expect } from 'vitest'
import type { CreatureInstance, PermMonSlot, RoomNode } from 'shared'
import {
  respawnPermCreatures,
  buildSpawnTemplateIndex,
  createInstanceIdAllocator,
  loadSpawnTemplates,
  type SpawnTemplate,
} from './spawn.js'
import { F_ISSET, F_SET, MPERMT } from './hexFlags.js'

function template(over: Partial<SpawnTemplate & { id: number }> = {}): SpawnTemplate & { id: number } {
  return {
    id: 123,
    name: '고정몹',
    level: 4,
    hpmax: 20,
    mpmax: 0,
    dexterity: 14,
    gold: 100,
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
    experience: 300,
    alignment: 250,
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
    random: [],
    traffic: 0,
    ...over,
  }
}

function permSlot(over: Partial<PermMonSlot> = {}): PermMonSlot {
  return { interval: 100, ltime: 0, misc: 123, ...over }
}

const idx = () => buildSpawnTemplateIndex([template()])

describe('respawnPermCreatures — 입장 lazy 리스폰', () => {
  it('due 슬롯(ltime+interval ≤ now)을 MPERMT 세팅해 재스폰한다', () => {
    const room = makeRoom({ permMon: [permSlot({ ltime: 0, interval: 100 })] })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(spawned).toHaveLength(1)
    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.name).toBe('고정몹')
    expect(room.creatures[0]?.templateId).toBe(123)
    expect(F_ISSET(room.creatures[0]?.flags ?? '', MPERMT)).toBe(true)
  })

  it('not-due 슬롯(ltime+interval > now)은 재스폰하지 않는다', () => {
    const room = makeRoom({ permMon: [permSlot({ ltime: 150, interval: 100 })] })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(spawned).toHaveLength(0)
    expect(room.creatures).toHaveLength(0)
  })

  it('방 내 동명 MPERMT 생존 수(m)만큼 차감한다(n−m 스폰)', () => {
    const living: CreatureInstance = {
      instanceId: '50:c0',
      templateId: 123,
      name: '고정몹',
      level: 4,
      hpmax: 20,
      hpcur: 20,
      mpmax: 0,
      mpcur: 0,
      dexterity: 14,
      gold: 100,
      special: 0,
      armor: 0,
      thaco: 0,
      ndice: 0,
      sdice: 0,
      pdice: 0,
      realm: [0, 0, 0, 0],
      spells: '0'.repeat(32),
      class: 0,
      intelligence: 0,
      piety: 0,
      flags: F_SET('0000000000000000', MPERMT),
      enemies: [],
      inventory: [],
    }
    const room = makeRoom({
      creatures: [living],
      permMon: [permSlot({ ltime: 0, interval: 100 })], // n=1, m=1 → 0 스폰
    })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
    })
    expect(spawned).toHaveLength(0)
    expect(room.creatures).toHaveLength(1)
  })

  it('같은 misc 슬롯 2개가 모두 due면 n=2로 스폰(중복 슬롯 합산)', () => {
    const room = makeRoom({
      permMon: [
        permSlot({ misc: 123, ltime: 0, interval: 100 }),
        permSlot({ misc: 123, ltime: 0, interval: 100 }),
      ],
    })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator([room]),
    })
    expect(spawned).toHaveLength(2)
    expect(room.creatures).toHaveLength(2)
  })

  it('misc 0(빈 슬롯)은 건너뛴다', () => {
    const room = makeRoom({ permMon: [permSlot({ misc: 0 })] })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(spawned).toHaveLength(0)
  })

  it('알 수 없는 템플릿(misc)은 스폰하지 않는다', () => {
    const room = makeRoom({ permMon: [permSlot({ misc: 999, ltime: 0, interval: 100 })] })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(spawned).toHaveLength(0)
  })

  it('permMon이 비면 미리젠하지 않는다(빈 방 미리젠 금지)', () => {
    const room = makeRoom({ permMon: [] })
    const spawned = respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(spawned).toHaveLength(0)
  })

  it('carry/gold 랜덤화가 주입 rng seam으로 위임된다', () => {
    const room = makeRoom({ permMon: [permSlot({ ltime: 0, interval: 100 })] })
    respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
      rng: () => 7,
    })
    expect(room.creatures[0]?.gold).toBe(7)
  })

  // Story 6: 템플릿 경로(fromTemplate)로 스폰된 몬스터도 experience/alignment를 실어야 한다.
  // fromTemplate 자체 테스트는 자체 Map을 만들어 buildSpawnTemplateIndex를 우회하므로,
  // 명시 매핑 chokepoint를 통과하는 이 경로가 두 필드를 떨구지 않는지 별도로 고정한다.
  it('템플릿 경로로 스폰된 몬스터가 experience/alignment를 실어온다(Story 6)', () => {
    const room = makeRoom({ permMon: [permSlot({ ltime: 0, interval: 100 })] })
    respawnPermCreatures(room, 200, {
      templates: idx(),
      alloc: createInstanceIdAllocator(),
    })
    expect(room.creatures[0]?.experience).toBe(300)
    expect(room.creatures[0]?.alignment).toBe(250)
  })
})

describe('buildSpawnTemplateIndex — 명시 매핑 chokepoint', () => {
  it('experience/alignment를 소스에서 인덱스로 통과시킨다(Story 6, 명시 매핑 누락 방지)', () => {
    const t = buildSpawnTemplateIndex([template({ experience: 42, alignment: -70 })]).get(123)
    expect(t?.experience).toBe(42)
    expect(t?.alignment).toBe(-70)
  })
})

describe('createInstanceIdAllocator — D7 방별 monotonic idx', () => {
  it('발급 idx가 방별로 단조 증가한다', () => {
    const room = makeRoom({ creatures: [] })
    const alloc = createInstanceIdAllocator([room])
    expect(alloc.next(room)).toBe(0)
    expect(alloc.next(room)).toBe(1)
    expect(alloc.next(room)).toBe(2)
  })

  it('pristine embedded 개수를 high-water seed로 쓴다', () => {
    const c0 = { instanceId: '50:c0' } as CreatureInstance
    const c1 = { instanceId: '50:c1' } as CreatureInstance
    const room = makeRoom({ creatures: [c0, c1] })
    const alloc = createInstanceIdAllocator([room])
    // seed=2(embedded 0,1) → 첫 발급 2.
    expect(alloc.next(room)).toBe(2)
  })

  it('사망·제거로 배열이 줄어도 idx가 충돌하지 않는다(단조 유지)', () => {
    const c0 = { instanceId: '50:c0' } as CreatureInstance
    const c1 = { instanceId: '50:c1' } as CreatureInstance
    const room = makeRoom({ creatures: [c0, c1] })
    const alloc = createInstanceIdAllocator([room])
    const first = alloc.next(room) // 2
    room.creatures.splice(1, 1) // c1 제거 → length=1
    const second = alloc.next(room) // length 파생이면 1(=c1 재사용, 충돌) — 단조면 3
    expect(second).toBe(3)
    expect(second).not.toBe(first)
  })

  it('방마다 카운터가 독립적이다', () => {
    const roomA = makeRoom({ roomId: 1 })
    const roomB = makeRoom({ roomId: 2 })
    const alloc = createInstanceIdAllocator([roomA, roomB])
    expect(alloc.next(roomA)).toBe(0)
    expect(alloc.next(roomB)).toBe(0)
    expect(alloc.next(roomA)).toBe(1)
  })

  it('seed 안 된 방은 첫 발급 시 length로 lazy fallback한다', () => {
    const room = makeRoom({ creatures: [] })
    const alloc = createInstanceIdAllocator() // rooms 미주입
    expect(alloc.next(room)).toBe(0)
    expect(alloc.next(room)).toBe(1)
  })
})

describe('loadSpawnTemplates — data/world/creatures.json', () => {
  it('creatures.json을 몹번호 인덱스로 로드하고 numwander를 담는다', () => {
    const templates = loadSpawnTemplates()
    const c25 = templates.get(25)
    expect(c25).toBeDefined()
    expect(c25?.numwander).toBe(3) // D9 추출값
    expect(typeof c25?.name).toBe('string')
  })

  it('전투 스탯 armor/thaco/ndice/sdice/pdice를 creatures.json에서 담는다(D6, 서브셋 드롭 없음)', () => {
    const templates = loadSpawnTemplates()
    const c25 = templates.get(25)
    expect(c25?.armor).toBe(70)
    expect(c25?.thaco).toBe(18)
    expect(c25?.ndice).toBe(2)
    expect(c25?.sdice).toBe(2)
    expect(c25?.pdice).toBe(0)
  })

  it('사망 분배 필드 experience/alignment를 creatures.json에서 담는다(Story 6, 서브셋 드롭 없음)', () => {
    const templates = loadSpawnTemplates()
    const c0 = templates.get(0) // 파수꾼: 정본 experience=300, alignment=250
    expect(c0?.experience).toBe(300)
    expect(c0?.alignment).toBe(250)
  })
})
