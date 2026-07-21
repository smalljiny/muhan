import { describe, it, expect } from 'vitest'
import type { CreatureInstance, PermMonSlot, RoomNode } from 'shared'
import { onCreatureDeath, onDeathSummon } from './creatureDeath.js'
import { buildSpawnTemplateIndex, createInstanceIdAllocator, type SpawnTemplate } from './spawn.js'
import { F_SET, MPERMT, MSUMMO } from './hexFlags.js'
import { cadenceSec } from './nextAction.js'

const EMPTY_FLAGS = '0000000000000000'

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
    flags: EMPTY_FLAGS,
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

function creature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: '50:c0',
    templateId: null,
    name: '고정몹',
    level: 4,
    hpmax: 20,
    hpcur: 0,
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
    flags: EMPTY_FLAGS,
    enemies: [],
    inventory: [],
    ...over,
  }
}

const deps = () => ({
  templates: buildSpawnTemplateIndex([template()]),
  alloc: createInstanceIdAllocator(),
})

describe('onCreatureDeath — perm 리스폰 타이머 리셋', () => {
  it('MPERMT 사망 시 동명 슬롯의 ltime을 사망 시각(now)으로 리셋한다', () => {
    const slot = permSlot({ ltime: 0, interval: 100, misc: 123 })
    const room = makeRoom({ permMon: [slot], creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '고정몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(500)
  })

  it('cooldown 미경과 슬롯(ltime+interval > now)은 리셋하지 않는다', () => {
    const slot = permSlot({ ltime: 450, interval: 100, misc: 123 }) // 450+100=550 > 500
    const room = makeRoom({ permMon: [slot], creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '고정몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(450) // 불변
  })

  it('이름 불일치 슬롯은 리셋하지 않는다', () => {
    const slot = permSlot({ ltime: 0, interval: 100, misc: 123 }) // template 123 = 고정몹
    const room = makeRoom({ permMon: [slot], creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '다른몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(0) // 불변
  })

  it('동명 due 슬롯이 둘이면 첫 슬롯만 리셋하고 break한다', () => {
    const room = makeRoom({
      permMon: [
        permSlot({ ltime: 0, interval: 100, misc: 123 }),
        permSlot({ ltime: 0, interval: 100, misc: 123 }),
      ],
      creatures: [],
    })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '고정몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(500)
    expect(room.permMon[1]?.ltime).toBe(0) // break로 미변경
  })

  it('misc 0(빈 슬롯)은 건너뛴다', () => {
    const room = makeRoom({ permMon: [permSlot({ misc: 0, ltime: 0 })], creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '고정몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(0)
  })

  it('알 수 없는 misc(템플릿 없음)는 건너뛴다', () => {
    const room = makeRoom({ permMon: [permSlot({ misc: 999, ltime: 0 })], creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MPERMT), name: '고정몹' })
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(0)
  })

  it('MPERMT가 아니면 perm 슬롯을 리셋하지 않는다', () => {
    const room = makeRoom({ permMon: [permSlot({ ltime: 0, interval: 100 })], creatures: [] })
    const dead = creature({ flags: EMPTY_FLAGS, name: '고정몹' }) // MPERMT 미세팅
    room.creatures.push(dead)

    onCreatureDeath(dead, room, 500, deps())

    expect(room.permMon[0]?.ltime).toBe(0)
  })
})

describe('onCreatureDeath — 활성 집합·방 creatures[] 제거', () => {
  it('죽은 크리처를 room.creatures에서 제거한다', () => {
    const dead = creature({ instanceId: '50:c1', name: '고정몹' })
    const survivor = creature({ instanceId: '50:c0', name: '생존몹' })
    const room = makeRoom({ creatures: [survivor, dead] })

    onCreatureDeath(dead, room, 500, deps())

    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.instanceId).toBe('50:c0')
    expect(room.creatures.includes(dead)).toBe(false)
  })

  it('room.creatures에 없는 크리처(이미 제거됨)여도 안전하다', () => {
    const dead = creature({ instanceId: '50:c9' })
    const room = makeRoom({ creatures: [] })

    expect(() => onCreatureDeath(dead, room, 500, deps())).not.toThrow()
    expect(room.creatures).toHaveLength(0)
  })
})

describe('onDeathSummon — MSUMMO 소환', () => {
  it('MSUMMO 크리처 사망 시 special 몹번호로 1마리 소환한다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 123 })
    const summoned = onDeathSummon(dead, room, 700, deps())

    expect(summoned).toHaveLength(1)
    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.name).toBe('고정몹')
    expect(room.creatures[0]?.templateId).toBe(123)
  })

  it('소환 크리처 타이머를 소환 시각(now) 기준으로 초기화한다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 123 })
    onDeathSummon(dead, room, 700, deps())

    const c = room.creatures[0]
    expect(c?.nextActionAt).toBe(700 + cadenceSec(14))
    expect(c?.lastScavengeAt).toBe(700)
    expect(c?.lastWanderAt).toBe(700)
  })

  it('MSUMMO가 아니면 소환하지 않는다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: EMPTY_FLAGS, special: 123 })
    const summoned = onDeathSummon(dead, room, 700, deps())

    expect(summoned).toHaveLength(0)
    expect(room.creatures).toHaveLength(0)
  })

  it('special=0이면 소환하지 않는다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 0 })
    const summoned = onDeathSummon(dead, room, 700, deps())

    expect(summoned).toHaveLength(0)
    expect(room.creatures).toHaveLength(0)
  })

  it('알 수 없는 special(템플릿 없음)이면 소환하지 않는다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 999 })
    const summoned = onDeathSummon(dead, room, 700, deps())

    expect(summoned).toHaveLength(0)
    expect(room.creatures).toHaveLength(0)
  })

  it('carry/gold 랜덤화를 주입 rng seam으로 위임한다', () => {
    const room = makeRoom({ creatures: [] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 123 })
    onDeathSummon(dead, room, 700, {
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator(),
      rng: () => 42,
    })

    expect(room.creatures[0]?.gold).toBe(42)
  })

  it('monotonic idx 발급기로 instanceId를 부여한다(D7)', () => {
    const existing = creature({ instanceId: '50:c0' })
    const room = makeRoom({ creatures: [existing] })
    const dead = creature({ flags: F_SET(EMPTY_FLAGS, MSUMMO), special: 123 })
    onDeathSummon(dead, room, 700, {
      templates: buildSpawnTemplateIndex([template()]),
      alloc: createInstanceIdAllocator([room]), // seed=1(embedded 개수)
    })

    // 소환 크리처는 방 배열 끝(index 1)에 push되고 idx=1로 발급된다.
    expect(room.creatures[1]?.instanceId).toBe('50:c1')
  })
})

describe('onCreatureDeath — 통합(perm 리셋 + 소환 + 제거)', () => {
  it('MPERMT+MSUMMO 사망 시 ltime 리셋·소환·제거를 함께 처리한다', () => {
    const slot = permSlot({ ltime: 0, interval: 100, misc: 123 })
    const dead = creature({
      instanceId: '50:c0',
      flags: F_SET(F_SET(EMPTY_FLAGS, MPERMT), MSUMMO),
      special: 123,
      name: '고정몹',
    })
    const room = makeRoom({ permMon: [slot], creatures: [dead] })

    onCreatureDeath(dead, room, 800, deps())

    // perm ltime 리셋(dead가 MPERMT·동명이므로).
    expect(room.permMon[0]?.ltime).toBe(800)
    // 소환된 크리처(templateId=123)가 방에 남고, 죽은 크리처(templateId=null)는 제거됐다.
    expect(room.creatures.includes(dead)).toBe(false)
    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.templateId).toBe(123)
  })
})
