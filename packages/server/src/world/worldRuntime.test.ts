import { describe, it, expect, vi } from 'vitest'
import type { PermMonSlot, RoomNode } from 'shared'
import { createWorldRuntime } from './worldRuntime.js'
import { buildSpawnTemplateIndex, type SpawnTemplate } from './spawn.js'
import type { InvasionEvent } from './invasion.js'
import { WorldClock } from './worldClock.js'
import { FakeClock } from '../util/clock.testutil.js'
import { F_ISSET, MPERMT } from './hexFlags.js'
import { tryMove, noopOnRoomEntered, noopOnRoomLeft, type TryMoveDeps, type MoveActor } from './tryMove.js'

// ── 픽스처 ────────────────────────────────────────────────────────────────────

function makeRoom(over: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 50,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
    ...over,
  }
}

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
    flags: '0000000000000000',
    numwander: 1,
    ...over,
  }
}

function permSlot(over: Partial<PermMonSlot> = {}): PermMonSlot {
  return { interval: 100, ltime: 0, misc: 123, ...over }
}

function graphOf(...rooms: RoomNode[]): Map<number, RoomNode> {
  const g = new Map<number, RoomNode>()
  for (const r of rooms) g.set(r.roomId, r)
  return g
}

const templates = () => buildSpawnTemplateIndex([template()])
const noEvents: InvasionEvent[] = []
// 결정적 invasion rng(항상 min). 주입 시 invasion 슬롯이 boot register 대상에 포함된다(게이트 통과).
const minInvasionRng = (min: number): number => min

// ── 슬롯 빌드 (T6.1) ──────────────────────────────────────────────────────────

describe('createWorldRuntime — 슬롯 빌드', () => {
  it('creatureTick·randomSpawn·이벤트당 invasion 슬롯을 빌드한다', () => {
    const events: InvasionEvent[] = [
      { id: 'e1', periodSec: 4000, roomRange: { min: 8000, max: 8300 }, mobRange: { min: 732, max: 755 }, count: 3, broadcast: '침공1' },
      { id: 'e2', periodSec: 5000, roomRange: { min: 3601, max: 3630 }, mobRange: { min: 265, max: 299 }, count: 2, broadcast: '침공2' },
    ]
    const runtime = createWorldRuntime(graphOf(makeRoom()), {
      now: () => 0,
      templates: templates(),
      events,
      invasionRng: minInvasionRng, // 실 rng 주입 시에만 invasion 슬롯이 register 대상에 포함된다
    })
    expect(runtime.slots.map((s) => s.name)).toEqual([
      'creatureTick',
      'randomSpawn',
      'invasion:e1',
      'invasion:e2',
    ])
    expect(runtime.slots.map((s) => s.intervalSec)).toEqual([1, 20, 4000, 5000])
  })

  it('invasionRng 미주입(E4-2 기본)이면 invasion 슬롯을 register 대상에서 제외한다', () => {
    const events: InvasionEvent[] = [
      { id: 'e1', periodSec: 4000, roomRange: { min: 8000, max: 8300 }, mobRange: { min: 732, max: 755 }, count: 3, broadcast: '침공1' },
    ]
    const runtime = createWorldRuntime(graphOf(makeRoom()), {
      now: () => 0,
      templates: templates(),
      events,
      // invasionRng 미주입 — 결정적 stub 고정 방 누적 방지(adversarial 결정): boot inert.
    })
    expect(runtime.slots.map((s) => s.name)).toEqual(['creatureTick', 'randomSpawn'])
    expect(runtime.slots.some((s) => s.name.startsWith('invasion:'))).toBe(false)
  })

  it('templates·events 미주입 시 data/world에서 로드하고, invasionRng 주입 시 invasion 슬롯이 붙는다', () => {
    // 실 creatures.json·events.json을 로드하는 fallback 경로. invasionRng 주입 시 이벤트 수만큼 invasion.
    const runtime = createWorldRuntime(graphOf(makeRoom()), { now: () => 0, invasionRng: minInvasionRng })
    const names = runtime.slots.map((s) => s.name)
    expect(names[0]).toBe('creatureTick')
    expect(names[1]).toBe('randomSpawn')
    expect(names.filter((n) => n.startsWith('invasion:')).length).toBe(runtime.slots.length - 2)
    expect(runtime.slots.length).toBeGreaterThan(2)
  })

  it('빌드한 슬롯을 WorldClock에 register하고 구동해도 throw하지 않는다', () => {
    const runtime = createWorldRuntime(graphOf(makeRoom({ occupants: new Set(['p1']) })), {
      now: () => 0,
      templates: templates(),
      events: noEvents,
    })
    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    for (const slot of runtime.slots) clock.register(slot)
    clock.start()
    expect(() => fake.tick(25)).not.toThrow()
  })

  it('invasion 슬롯 발화 시 resolveRoom으로 그래프 방을 찾아 스폰하고 방송한다', () => {
    const room = makeRoom({ roomId: 8000 })
    const broadcast = vi.fn()
    const events: InvasionEvent[] = [
      { id: 'e1', periodSec: 1, roomRange: { min: 8000, max: 8000 }, mobRange: { min: 123, max: 123 }, count: 1, broadcast: '침공!' },
    ]
    const runtime = createWorldRuntime(graphOf(room), {
      now: () => 0,
      templates: templates(),
      events,
      invasionRng: minInvasionRng, // 게이트 통과 — invasion 슬롯이 register 대상에 포함
      broadcast,
    })
    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    for (const slot of runtime.slots) clock.register(slot)
    clock.start()
    fake.tick(1)
    expect(room.creatures).toHaveLength(1) // resolveRoom(8000)→room, 팩토리 (b) 스폰
    expect(broadcast).toHaveBeenCalledWith('침공!')
  })
})

// ── onRoomEntered 훅 (T6.2) ────────────────────────────────────────────────────

describe('createWorldRuntime — onRoomEntered 훅', () => {
  it('점유 방을 주입 now로 활성화한다(activatedAt == now)', () => {
    const room = makeRoom({ occupants: new Set(['p1']) })
    const runtime = createWorldRuntime(graphOf(room), {
      now: () => 42,
      templates: templates(),
      events: noEvents,
    })
    const actor: MoveActor = { characterId: 'p1', currentRoomId: 50 }
    runtime.onRoomEntered(room, actor)
    expect(runtime.activeSet.isActive(50)).toBe(true)
    expect(runtime.activeSet.activatedAt(50)).toBe(42)
  })

  it('due perm 슬롯을 입장 시점에 리스폰한다(activate + respawnPermCreatures 결선)', () => {
    const room = makeRoom({
      occupants: new Set(['p1']),
      permMon: [permSlot({ ltime: 0, interval: 100 })],
    })
    const runtime = createWorldRuntime(graphOf(room), {
      now: () => 200, // ltime(0)+interval(100) <= 200 → due
      templates: templates(),
      events: noEvents,
    })
    runtime.onRoomEntered(room, { characterId: 'p1', currentRoomId: 50 })
    expect(room.creatures).toHaveLength(1)
    expect(room.creatures[0]?.name).toBe('고정몹')
    expect(F_ISSET(room.creatures[0]?.flags ?? '', MPERMT)).toBe(true)
  })

  it('creatureRng seam이 리스폰 gold 랜덤화로 흘러간다', () => {
    const room = makeRoom({
      occupants: new Set(['p1']),
      permMon: [permSlot({ ltime: 0, interval: 100 })],
    })
    const runtime = createWorldRuntime(graphOf(room), {
      now: () => 200,
      templates: templates(),
      events: noEvents,
      creatureRng: (base) => base * 2, // gold 100 → 200
    })
    runtime.onRoomEntered(room, { characterId: 'p1', currentRoomId: 50 })
    expect(room.creatures[0]?.gold).toBe(200)
  })

  it('빈 방(점유자 없음) 입장 훅은 활성화되지 않는다(activate no-op 계약)', () => {
    const room = makeRoom({ occupants: new Set<string>() })
    const runtime = createWorldRuntime(graphOf(room), {
      now: () => 5,
      templates: templates(),
      events: noEvents,
    })
    runtime.onRoomEntered(room, { characterId: 'p1', currentRoomId: 50 })
    expect(runtime.activeSet.isActive(50)).toBe(false)
  })
})

// ── onRoomLeft 대칭 seam via tryMove (T6.3) ────────────────────────────────────

describe('createWorldRuntime — onRoomLeft를 tryMove leave 경로로 구동', () => {
  it('방 A→B 이동 시 빈 A는 비활성화, B는 활성화된다', () => {
    const roomA = makeRoom({
      roomId: 100,
      occupants: new Set(['me']),
      exits: [{ name: '동', targetRoomId: 200, flags: [0, 0, 0, 0], key: 0, ltime: 0, interval: 60 }],
    })
    const roomB = makeRoom({ roomId: 200 })
    const graph = graphOf(roomA, roomB)
    const runtime = createWorldRuntime(graph, {
      now: () => 1,
      templates: templates(),
      events: noEvents,
    })

    // A에 플레이어가 이미 있으므로 A는 활성 상태로 시작한다.
    runtime.onRoomEntered(roomA, { characterId: 'me', currentRoomId: 100 })
    expect(runtime.activeSet.isActive(100)).toBe(true)

    // 실 deactivate 배선으로 tryMove를 구동한다(onRoomLeft·onRoomEntered 결선).
    const deps: TryMoveDeps = {
      resolveRoom: (id) => graph.get(id),
      currentHour: () => 12,
      broadcastLeave: () => undefined,
      broadcastJoin: () => undefined,
      onRoomEntered: runtime.onRoomEntered,
      onRoomLeft: runtime.onRoomLeft,
      rng: (exits) => exits[0],
    }
    const result = tryMove(deps, { characterId: 'me', currentRoomId: 100 }, '동', 'directional')
    expect(result.ok).toBe(true)
    expect(runtime.activeSet.isActive(100)).toBe(false) // 빈 A 비활성화
    expect(runtime.activeSet.isActive(200)).toBe(true) // B 활성화
  })
})

// ── boot 통합: gameTime·checkExits와 공존 + now 도메인 커플링 (T6.1·회귀) ─────────

describe('createWorldRuntime — boot 통합(기존 슬롯 회귀 + creatureTick 구동)', () => {
  it('runtime 슬롯이 gameTime·checkExits와 한 클록에 공존하고 creatureTick이 활성 방을 처리한다', async () => {
    const { createGameTime } = await import('./gameTime.js')
    const room = makeRoom({ roomId: 70, occupants: new Set(['p1']) })
    // 도래(nextActionAt 미설정) 크리처 1마리 — creatureTick이 처리하면 nextActionAt이 세팅된다.
    room.creatures.push({
      instanceId: '70:c0',
      templateId: null,
      name: '몹',
      level: 1,
      hpmax: 10,
      hpcur: 10,
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
      flags: '0000000000000000',
      enemies: [],
      inventory: [],
    })
    const graph = graphOf(room)

    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    const runtime = createWorldRuntime(graph, {
      now: () => clock.currentTick(),
      templates: templates(),
      events: noEvents,
    })
    const gameTime = createGameTime()

    clock.register(gameTime.slot)
    for (const slot of runtime.slots) clock.register(slot)
    clock.start()

    // 활성화 시각과 creatureTick tickSec가 같은 clock에서 나온다(now 도메인 단일 출처).
    fake.tick(3)
    runtime.onRoomEntered(room, { characterId: 'p1', currentRoomId: 70 })
    expect(runtime.activeSet.activatedAt(70)).toBe(3)

    // 다음 tick에 creatureTick이 활성 방의 도래 크리처를 처리해 nextActionAt을 세팅한다.
    fake.tick(1) // tickSec=4
    expect(room.creatures[0]?.nextActionAt).toBe(4 + 3) // dex 14<20 → cadence 3
  })

  it('noopOnRoomEntered/noopOnRoomLeft가 기본 no-op으로 남아있다(dormant 경계)', () => {
    const room = makeRoom()
    const actor: MoveActor = { characterId: 'x', currentRoomId: 50 }
    expect(() => noopOnRoomEntered(room, actor)).not.toThrow()
    expect(() => noopOnRoomLeft(room, actor)).not.toThrow()
  })
})
