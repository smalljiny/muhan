import { describe, it, expect, vi } from 'vitest'
import type { CreatureInstance, ItemInstance, RoomNode } from 'shared'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock } from './worldClock.js'
import { createActiveSet } from './activeSet.js'
import { createCreatureTick, defaultOnCombatTick, type OnCombatTick } from './creatureTick.js'
import { alwaysFireRng, neverFireRng } from './autonomic.js'
import { F_SET, F_ISSET, MSCAVE, MHASSC, MAGGRE } from './hexFlags.js'

function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: '1:c0',
    templateId: null,
    name: '몬스터',
    level: 1,
    hpmax: 100,
    hpcur: 100,
    mpmax: 0,
    mpcur: 0,
    dexterity: 14,
    gold: 0,
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
    flags: '0000000000000000',
    enemies: [],
    inventory: [],
    ...over,
  }
}

function makeItem(name: string, flags: string): ItemInstance {
  return { instanceId: `1:${name}`, name, description: '', value: 1, flags, contains: [] }
}

function makeRoom(over: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 1,
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

describe('createCreatureTick — 슬롯 계약', () => {
  it("name='creatureTick', intervalSec=1", () => {
    const slot = createCreatureTick({ activeSet: createActiveSet() })
    expect(slot.name).toBe('creatureTick')
    expect(slot.intervalSec).toBe(1)
  })
})

describe('next-action 도래 게이트 (FakeClock 기반)', () => {
  it('도래 몬스터만 처리하고 비도래는 건드리지 않는다', () => {
    const clock = new FakeClock()
    const world = new WorldClock({ clock })
    const activeSet = createActiveSet()
    const due = makeCreature({ instanceId: '1:c0', nextActionAt: 2 })
    const notDue = makeCreature({ instanceId: '1:c1', nextActionAt: 1000 })
    const room = makeRoom({ creatures: [due, notDue] })
    activeSet.activate(room, 0)

    world.register(createCreatureTick({ activeSet }))
    world.start()
    clock.tick(3) // tickSec 1,2,3 — c0(nextActionAt=2)는 tickSec 2에 도래

    const c0 = room.creatures.find((c) => c.instanceId === '1:c0')
    const c1 = room.creatures.find((c) => c.instanceId === '1:c1')
    // 도래 몬스터는 재스케줄되어 nextActionAt이 미래로 이동한다(dex14 → +3).
    expect(c0?.nextActionAt).toBeGreaterThan(2)
    // 비도래 몬스터는 그대로다.
    expect(c1?.nextActionAt).toBe(1000)
  })

  it('처리 후 nextActionAt을 now+cadence로 재스케줄한다', () => {
    const activeSet = createActiveSet()
    const c = makeCreature({ dexterity: 14, nextActionAt: 5 })
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet })
    slot.run(10) // now=10
    expect(room.creatures[0]?.nextActionAt).toBe(13) // 10 + cadence(14)=3
  })

  it('활성 방이 없으면 아무 것도 하지 않는다', () => {
    const activeSet = createActiveSet()
    const slot = createCreatureTick({ activeSet })
    expect(() => slot.run(1)).not.toThrow()
  })
})

describe('autonomic 상태 적용', () => {
  it('재생 결과가 방 몬스터에 반영된다(활성 내내)', () => {
    const activeSet = createActiveSet()
    const c = makeCreature({ hpcur: 1, hpmax: 100, lastRegenAt: 0, nextActionAt: 0 })
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet })
    slot.run(60) // due 60 1회 → +10
    expect(room.creatures[0]?.hpcur).toBe(11)
  })

  it('빈 방=시간 정지 — 재활성 후 동결 구간은 재생 소급되지 않는다', () => {
    const activeSet = createActiveSet()
    const c = makeCreature({ hpcur: 1, hpmax: 100, lastRegenAt: 0, nextActionAt: 0 })
    const room = makeRoom({ creatures: [c] })
    // t=0 활성 → t 사이 비활성 → t=1000 재활성(activatedAt=1000).
    activeSet.activate(room, 0)
    room.occupants.delete('p1')
    activeSet.deactivate(room)
    room.occupants.add('p2')
    activeSet.activate(room, 1000)
    const slot = createCreatureTick({ activeSet })
    slot.run(1000) // baseline=max(60,1000)=1000 → 1회만
    expect(room.creatures[0]?.hpcur).toBe(11) // 소급되면 훨씬 큼
  })

  it('scavenge가 방 아이템을 몬스터 인벤토리로 옮기고 방에서 제거한다', () => {
    const activeSet = createActiveSet()
    const item = makeItem('금화', '0000000000000000')
    const c = makeCreature({
      flags: F_SET('0000000000000000', MSCAVE),
      lastScavengeAt: 0,
      nextActionAt: 0,
    })
    const room = makeRoom({ creatures: [c], items: [item] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: alwaysFireRng })
    slot.run(1000)
    expect(room.items).toHaveLength(0)
    expect(room.creatures[0]?.inventory).toHaveLength(1)
    expect(room.creatures[0]?.inventory[0]?.name).toBe('금화')
    expect(F_ISSET(room.creatures[0]?.flags ?? '', MHASSC)).toBe(true)
  })

  it('wander-out은 몬스터를 방에서 제거하고 onCombatTick을 호출하지 않는다', () => {
    const activeSet = createActiveSet()
    const onCombatTick = vi.fn()
    const c = makeCreature({ lastWanderAt: 0, nextActionAt: 0 })
    const room = makeRoom({ creatures: [c], traffic: 100 })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: alwaysFireRng, onCombatTick })
    slot.run(1000)
    expect(room.creatures).toHaveLength(0)
    expect(onCombatTick).not.toHaveBeenCalled()
  })
})

describe('§3.5 조기종료 게이트 + onCombatTick 디스패치 seam', () => {
  it('적 없고 비공격형이면 onCombatTick을 호출하지 않는다', () => {
    const activeSet = createActiveSet()
    const onCombatTick = vi.fn()
    const c = makeCreature({ nextActionAt: 0 }) // enemies 없음, MAGGRE 없음
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: neverFireRng, onCombatTick })
    slot.run(10)
    expect(onCombatTick).not.toHaveBeenCalled()
  })

  it('적이 있으면 onCombatTick을 호출한다', () => {
    const activeSet = createActiveSet()
    const onCombatTick = vi.fn()
    const c = makeCreature({ nextActionAt: 0, enemies: ['player1'] })
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: neverFireRng, onCombatTick })
    slot.run(10)
    expect(onCombatTick).toHaveBeenCalledTimes(1)
    expect(onCombatTick).toHaveBeenCalledWith(room.creatures[0], room)
  })

  it('공격형(MAGGRE)이면 적 없어도 onCombatTick을 호출한다', () => {
    const activeSet = createActiveSet()
    const onCombatTick = vi.fn()
    const c = makeCreature({ nextActionAt: 0, flags: F_SET('0000000000000000', MAGGRE) })
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: neverFireRng, onCombatTick })
    slot.run(10)
    expect(onCombatTick).toHaveBeenCalledTimes(1)
  })

  it('기본 onCombatTick은 no-op이다(주입 없이도 안전)', () => {
    const activeSet = createActiveSet()
    const c = makeCreature({ nextActionAt: 0, enemies: ['player1'] })
    const room = makeRoom({ creatures: [c] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: neverFireRng })
    expect(() => slot.run(10)).not.toThrow()
    expect(defaultOnCombatTick(c, room)).toBeUndefined()
  })
})

describe('tick 도중 비활성화된 방 동결', () => {
  // 사망 seam이 마지막 점유자를 부활 방으로 옮기면 onRoomLeft 훅이 출발 방을 deactivate한다. 같은 tick에서
  // 그 방의 후속 몬스터가 재생·재스케줄·전투 디스패치를 받으면 빈 방 동결 규칙을 어긴다.
  // B는 재생이 도래한 상태(hp·mp 최대 미만, lastRegenAt=0, now=60)로 구성해, 동결과 "전투 굴림만 사라짐"을
  // 구분한다 — 동결이면 hp·mp·nextActionAt이 그대로, 활성이면 재생되고 재스케줄된다.
  const NOW = 60

  function setup() {
    const activeSet = createActiveSet()
    const a = makeCreature({ instanceId: '1:c0', nextActionAt: 0, enemies: ['p1'] })
    const b = makeCreature({
      instanceId: '1:c1',
      nextActionAt: 0,
      enemies: ['p1'],
      hpcur: 50,
      hpmax: 100,
      mpcur: 5,
      mpmax: 30,
      lastRegenAt: 0,
    })
    const room = makeRoom({ creatures: [a, b], occupants: new Set(['p1']) })
    expect(activeSet.activate(room, 0)).toBe(true)
    return { activeSet, room }
  }

  /** tick 이후 방 배열에서 instanceId로 다시 찾는다 — runAutonomic·applyResult가 객체를 교체한다. */
  function findB(room: RoomNode): CreatureInstance {
    const b = room.creatures.find((c) => c.instanceId === '1:c1')
    if (b === undefined) throw new Error('B가 방에 없다')
    return b
  }

  it('A의 전투 처리로 방이 비활성화되면 B는 hp·mp·nextActionAt 불변이고 onCombatTick을 받지 않는다', () => {
    const { activeSet, room } = setup()
    const deactivated: boolean[] = []
    const onCombatTick = vi.fn((creature: CreatureInstance, r: RoomNode) => {
      if (creature.instanceId !== '1:c0') return
      // 마지막 점유자 퇴장(부활 이동) → onRoomLeft 훅의 deactivate를 흉내낸다.
      r.occupants.delete('p1')
      deactivated.push(activeSet.deactivate(r))
    })
    const slot = createCreatureTick({ activeSet, rng: neverFireRng, onCombatTick })

    slot.run(NOW)

    expect(deactivated).toEqual([true])
    const b = findB(room)
    expect(b.hpcur).toBe(50)
    expect(b.mpcur).toBe(5)
    expect(b.nextActionAt).toBe(0)
    expect(onCombatTick.mock.calls.filter(([c]) => c.instanceId === '1:c1')).toHaveLength(0)
  })

  it('대조: 방이 계속 활성이면 B도 재생·재스케줄되고 onCombatTick을 1회 받는다', () => {
    const { activeSet, room } = setup()
    const onCombatTick = vi.fn<OnCombatTick>()
    const slot = createCreatureTick({ activeSet, rng: neverFireRng, onCombatTick })

    slot.run(NOW)

    const b = findB(room)
    expect(b.hpcur).toBeGreaterThan(50)
    expect(b.mpcur).toBeGreaterThan(5)
    expect(b.nextActionAt).toBeGreaterThan(NOW)
    const callsForB = onCombatTick.mock.calls.filter(([c]) => c.instanceId === '1:c1')
    expect(callsForB).toHaveLength(1)
  })
})
