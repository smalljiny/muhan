import { describe, it, expect } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { createActiveSet } from './activeSet.js'

function makeCreature(instanceId: string, hpcur: number): CreatureInstance {
  return {
    instanceId,
    templateId: null,
    name: '몬스터',
    level: 1,
    hpmax: hpcur,
    hpcur,
    mpmax: 0,
    mpcur: 0,
    dexterity: 10,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    flags: '0000000000000000',
    enemies: [],
    inventory: [],
  }
}

function makeRoom(roomId: number, occupantIds: string[], creatures: CreatureInstance[]): RoomNode {
  return {
    roomId,
    name: `방${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set(occupantIds),
    creatures,
    permMon: [],
    random: [],
    traffic: 0,
  }
}

describe('createActiveSet — 점유 기반 활성/비활성', () => {
  it('첫 플레이어 진입(occupants>0) 시 방을 활성 등록한다', () => {
    const set = createActiveSet()
    const room = makeRoom(1, ['p1'], [makeCreature('1:c0', 5)])
    expect(set.activate(room, 100)).toBe(true)
    expect(set.isActive(1)).toBe(true)
    expect(set.activatedAt(1)).toBe(100)
    expect(set.activeRooms()).toContain(room)
  })

  it('빈 방(occupants 없음)은 활성화하지 않는다', () => {
    const set = createActiveSet()
    const room = makeRoom(1, [], [makeCreature('1:c0', 5)])
    expect(set.activate(room, 100)).toBe(false)
    expect(set.isActive(1)).toBe(false)
    expect(set.activatedAt(1)).toBeUndefined()
  })

  it('이미 활성인 방 재활성화는 no-op이고 activatedAt을 rebase하지 않는다', () => {
    const set = createActiveSet()
    const room = makeRoom(1, ['p1'], [])
    set.activate(room, 100)
    expect(set.activate(room, 200)).toBe(false)
    expect(set.activatedAt(1)).toBe(100)
  })

  it('방이 비면(occupants 빈 상태) 비활성 제거한다', () => {
    const set = createActiveSet()
    const room = makeRoom(1, ['p1'], [])
    set.activate(room, 100)
    room.occupants.delete('p1')
    expect(set.deactivate(room)).toBe(true)
    expect(set.isActive(1)).toBe(false)
    expect(set.activatedAt(1)).toBeUndefined()
    expect(set.activeRooms()).not.toContain(room)
  })

  it('아직 점유 중인 방은 비활성화하지 않는다', () => {
    const set = createActiveSet()
    const room = makeRoom(1, ['p1', 'p2'], [])
    set.activate(room, 100)
    room.occupants.delete('p1') // p2가 남음
    expect(set.deactivate(room)).toBe(false)
    expect(set.isActive(1)).toBe(true)
  })

  it('빈 방=시간 정지 — 비활성 구간은 activatedAt에서 제외된다(재활성화 시 now로 rebase)', () => {
    const set = createActiveSet()
    const room = makeRoom(1, ['p1'], [makeCreature('1:c0', 5)])
    set.activate(room, 100)
    room.occupants.delete('p1')
    set.deactivate(room) // t=100~500 사이 시간 정지 구간

    room.occupants.add('p2')
    expect(set.activate(room, 500)).toBe(true)
    // 비활성 구간(100~500)이 소급되지 않도록 activatedAt이 재진입 시각으로 rebase된다.
    expect(set.activatedAt(1)).toBe(500)
  })

  it('비활성 방의 크리처 상태를 건드리지 않는다(동결 — activeSet은 creatures를 변경하지 않음)', () => {
    const set = createActiveSet()
    const creature = makeCreature('1:c0', 5)
    const room = makeRoom(1, ['p1'], [creature])
    set.activate(room, 100)
    room.occupants.delete('p1')
    set.deactivate(room)
    // activeSet은 크리처 상태(hpcur·타이머)를 읽기만 하며 변경하지 않는다.
    expect(creature.hpcur).toBe(5)
    expect(creature.nextActionAt).toBeUndefined()
  })
})
