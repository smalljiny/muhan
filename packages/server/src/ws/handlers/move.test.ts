import { describe, it, expect, vi } from 'vitest'
import type { Character, ExitEdge, RoomNode } from 'shared'
import { setFlag, XLOCKD } from '../../world/door.js'
import { defaultFleeRng, type TryMoveDeps } from '../../world/tryMove.js'
import type { LiveCharacter } from '../../world/liveCharacterRegistry.js'
import type { ActorContext } from '../actorContext.js'
import { createMoveHandler } from './move.js'
import { dispatch, createCommandRegistry } from '../router.js'
import type { ChannelPort } from '../channelPort.js'
import type { PermissionPort } from '../permissionPort.js'

// ── 픽스처 팩토리 (tryMove.test.ts 관례 재사용) ───────────────────────────────

// 출구 엣지(4바이트=32비트 flags). name·targetRoomId·세팅 비트만 지정.
function makeExit(name: string, targetRoomId: number, bits: number[] = []): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name, targetRoomId, flags, key: 0, ltime: 0, interval: 60 }
}

// 방(8바이트=64비트 flags). exits·점유자를 지정.
function makeRoom(roomId: number, exits: ExitEdge[], occupantIds: string[] = []): RoomNode {
  return {
    roomId,
    name: `방${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits,
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

// 라이브 캐릭터 — 핸들러는 character.currentRoom만 읽고 in-place 갱신한다. 나머지 필드는 dormant라
// 최소 shape를 cast로 구성한다(server character 픽스처 관례).
function makeLive(currentRoom: number): LiveCharacter {
  return { character: { currentRoom } as Character }
}

// tryMoveDeps 조립기 — 방 Map + vi.fn seam. resolveRoom을 spy로 둬 "tryMove 미호출"을 간접 검증한다
// (real tryMove의 첫 동작이 resolveRoom(currentRoomId)이므로 resolveRoom 미호출 = tryMove 미실행).
function makeTryMoveDeps(rooms: RoomNode[]) {
  const graph = new Map<number, RoomNode>()
  for (const room of rooms) graph.set(room.roomId, room)
  const deps: TryMoveDeps = {
    resolveRoom: vi.fn((roomId: number) => graph.get(roomId)),
    currentHour: () => 12,
    broadcastLeave: vi.fn(),
    broadcastJoin: vi.fn(),
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    rng: defaultFleeRng,
  }
  return { deps, graph }
}

// actor에는 방 필드가 없다(D2) — accountId/characterId만. 핸들러는 currentRoom을 오직 registry에서 읽는다.
const actor: ActorContext = { accountId: 'acc-1', characterId: 'me' }

describe('createMoveHandler', () => {
  describe('성공 이동 (A≠B, non-vacuous)', () => {
    // 출발 방 A=100, 도착 방 B=200, A≠B. A는 '동'→B 출구를 갖고, B는 '서'→A 명명 출구를 가져
    // exits.map(e=>e.name)이 non-vacuous(['서'])다.
    it('점유자 재배치·live.currentRoom 갱신·world:room 이벤트를 낸다', () => {
      const dest = makeRoom(200, [makeExit('서', 100)])
      const source = makeRoom(100, [makeExit('동', 200)], ['me'])
      expect(source.roomId).not.toBe(dest.roomId) // A≠B 명시
      const { deps } = makeTryMoveDeps([source, dest])
      const live = makeLive(100)
      const markDirty = vi.fn()
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => live) },
        tryMoveDeps: deps,
        markDirty,
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      // tryMove가 점유자를 재배치했다(source에서 제거, dest에 추가).
      expect(source.occupants.has('me')).toBe(false)
      expect(dest.occupants.has('me')).toBe(true)
      // live 방 위치가 도착 방으로 갱신됐다(D-A1).
      expect(live.character.currentRoom).toBe(200)
      // world:room 상태 이벤트 — correlationId 없음.
      expect(event).toEqual({ type: 'world:room', roomId: 200, exits: ['서'] })
    })

    it('hook 순서: onRoomLeft는 source delete 후, onRoomEntered는 dest add 후 각 1회', () => {
      const dest = makeRoom(200, [makeExit('서', 100)])
      const source = makeRoom(100, [makeExit('동', 200)], ['me'])
      const { deps } = makeTryMoveDeps([source, dest])
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      })

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(deps.onRoomLeft).toHaveBeenCalledTimes(1)
      expect(deps.onRoomLeft).toHaveBeenCalledWith(source, expect.anything())
      expect(deps.onRoomEntered).toHaveBeenCalledTimes(1)
      expect(deps.onRoomEntered).toHaveBeenCalledWith(dest, expect.anything())
    })
  })

  describe('거부 (막힌 방향/잠긴 문)', () => {
    it('rule_rejected 이벤트를 내고 점유자·live.currentRoom 불변, markDirty 미호출', () => {
      const dest = makeRoom(200, [])
      const source = makeRoom(100, [makeExit('동', 200, [XLOCKD])], ['me'])
      const { deps } = makeTryMoveDeps([source, dest])
      const live = makeLive(100)
      const markDirty = vi.fn()
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => live) },
        tryMoveDeps: deps,
        markDirty,
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', message: '문이 잠겨 있습니다' })
      expect(source.occupants.has('me')).toBe(true)
      expect(dest.occupants.size).toBe(0)
      expect(live.character.currentRoom).toBe(100)
      expect(markDirty).not.toHaveBeenCalled()
    })

    it('id가 있으면 rule_rejected 이벤트에 correlationId를 반향한다', () => {
      const source = makeRoom(100, [makeExit('동', 200, [XLOCKD])], ['me'])
      const { deps } = makeTryMoveDeps([source, makeRoom(200, [])])
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      })

      const event = handler({ type: 'world:move', direction: '동', id: 'm1' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', correlationId: 'm1' })
    })
  })

  describe('성공 시 dirty 마킹 (A≠B, non-vacuous)', () => {
    it("markDirty를 ('characters', characterId, { currentRoom: B })로 1회 호출한다 — snapshot이 도착 방", () => {
      const dest = makeRoom(200, [makeExit('서', 100)])
      const source = makeRoom(100, [makeExit('동', 200)], ['me'])
      expect(source.roomId).not.toBe(dest.roomId) // A≠B 명시 — snapshot이 A가 아닌 B임을 증명하려면 필수
      const { deps } = makeTryMoveDeps([source, dest])
      const markDirty = vi.fn()
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markDirty,
      })

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(markDirty).toHaveBeenCalledTimes(1)
      expect(markDirty).toHaveBeenCalledWith('characters', 'me', { currentRoom: 200 })
    })
  })

  describe('미등록 actor 격리', () => {
    it('liveRegistry.get이 undefined면 error{internal}, 이동·markDirty·tryMove 없음', () => {
      const source = makeRoom(100, [makeExit('동', 200)], ['me'])
      const { deps } = makeTryMoveDeps([source, makeRoom(200, [])])
      const markDirty = vi.fn()
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => undefined) },
        tryMoveDeps: deps,
        markDirty,
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'internal' })
      expect(source.occupants.has('me')).toBe(true)
      expect(markDirty).not.toHaveBeenCalled()
      // resolveRoom 미호출 = real tryMove 미실행(tryMove 첫 동작이 resolveRoom(currentRoomId)).
      expect(deps.resolveRoom).not.toHaveBeenCalled()
    })

    it('미등록 actor + id면 internal 이벤트에 correlationId를 반향한다', () => {
      const { deps } = makeTryMoveDeps([])
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => undefined) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      })

      const event = handler({ type: 'world:move', direction: '동', id: 'm2' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'internal', correlationId: 'm2' })
    })
  })

  describe('D2 신원 — currentRoom 출처는 registry', () => {
    it('핸들러는 currentRoom을 registry 엔트리에서 읽는다(actor에는 방 필드가 없다)', () => {
      // registry가 방 777을 준다. actor에는 어떤 방 정보도 없다. tryMove가 777을 source로 해석함을
      // resolveRoom 호출 인자로 확인한다 — 방 위치가 오직 registry에서 왔음을 증명한다.
      const dest = makeRoom(888, [makeExit('북', 777)])
      const source = makeRoom(777, [makeExit('동', 888)], ['me'])
      const { deps } = makeTryMoveDeps([source, dest])
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => makeLive(777)) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      })

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(deps.resolveRoom).toHaveBeenCalledWith(777)
    })

    it('defensive narrow: world:move가 아닌 명령은 undefined를 반환한다', () => {
      const { deps } = makeTryMoveDeps([])
      const handler = createMoveHandler({
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      })
      expect(handler({ type: 'debug:echo', text: '핑' }, actor)).toBeUndefined()
    })
  })
})

// ── 조건부 등록 (router 확장) ────────────────────────────────────────────────

describe('createCommandRegistry — world:move 조건부 등록', () => {
  const testChannelPort: ChannelPort = { deliver: () => {} }
  const testPermission: PermissionPort = { check: () => true }

  it('moveDeps 없이 만들면 world:move는 미등록 → unknown_type', () => {
    const registry = createCommandRegistry(testChannelPort)
    const result = dispatch(registry, { type: 'world:move', direction: '동' }, actor, testPermission)
    expect(result.outcome).toBe('rejected')
    expect(result.event).toMatchObject({ type: 'error', code: 'unknown_type' })
  })

  it('moveDeps를 주면 world:move가 move 핸들러로 디스패치된다', () => {
    const dest = makeRoom(200, [makeExit('서', 100)])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeTryMoveDeps([source, dest])
    const registry = createCommandRegistry(testChannelPort, {
      move: {
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markDirty: vi.fn(),
      },
    })

    const result = dispatch(registry, { type: 'world:move', direction: '동' }, actor, testPermission)

    expect(result.outcome).toBe('handled')
    expect(result.event).toEqual({ type: 'world:room', roomId: 200, exits: ['서'] })
  })
})
