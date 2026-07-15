import { describe, it, expect, vi } from 'vitest'
import type { CreatureInstance, ItemInstance, RoomNode } from 'shared'
import { FakeClock } from '../util/clock.testutil.js'
import { WorldClock } from './worldClock.js'
import { createActiveSet } from './activeSet.js'
import { createCreatureTick, defaultOnCombatTick } from './creatureTick.js'
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

describe('next-action 도래 게이트 (FakeClock 구동)', () => {
  it('도래 크리처만 처리하고 비도래는 건드리지 않는다', () => {
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
    // 도래 크리처는 재스케줄되어 nextActionAt이 미래로 이동한다(dex14 → +3).
    expect(c0?.nextActionAt).toBeGreaterThan(2)
    // 비도래 크리처는 그대로다.
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
  it('재생 결과가 방 크리처에 반영된다(활성 내내)', () => {
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

  it('scavenge가 방 아이템을 크리처 인벤토리로 옮기고 방에서 제거한다', () => {
    const activeSet = createActiveSet()
    const item = makeItem('금화', '0000000000000000')
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 0, nextActionAt: 0 })
    const room = makeRoom({ creatures: [c], items: [item] })
    activeSet.activate(room, 0)
    const slot = createCreatureTick({ activeSet, rng: alwaysFireRng })
    slot.run(1000)
    expect(room.items).toHaveLength(0)
    expect(room.creatures[0]?.inventory).toHaveLength(1)
    expect(room.creatures[0]?.inventory[0]?.name).toBe('금화')
    expect(F_ISSET(room.creatures[0]?.flags ?? '', MHASSC)).toBe(true)
  })

  it('wander-out은 크리처를 방에서 제거하고 onCombatTick을 호출하지 않는다', () => {
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
