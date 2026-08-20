import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode } from 'shared'
import { XLOCKD, XSECRT } from '../../world/door.js'
import { OHIDDN, MINVIS } from '../../world/hexFlags.js'
import { defaultFleeRng, type TryMoveDeps } from '../../world/tryMove.js'
import type { LiveCharacter } from '../../world/liveCharacterRegistry.js'
import { createMarkCharacterDirty } from '../../world/markCharacterDirty.js'
import { exitFlags, flagsHex, makeExitTo, makeItem, makeCreature } from '../../world/roomFixtures.testutil.js'
import type { ActorContext } from '../actorContext.js'
import { createMoveHandler, type MoveHandlerDeps } from './move.js'
import { dispatch, createCommandRegistry } from '../router.js'
import type { ChannelPort } from '../channelPort.js'
import type { PermissionPort } from '../permissionPort.js'

// ── 픽스처 팩토리 (world/roomFixtures.testutil.ts 공유 헬퍼 재사용) ────────────

// 방(8바이트=64비트 flags). roomId·exits·점유자를 지정하고, 나머지는 overrides로 덮어쓴다.
function makeRoom(
  roomId: number,
  exits: RoomNode['exits'],
  occupantIds: string[] = [],
  overrides: Partial<RoomNode> = {},
): RoomNode {
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
    ...overrides,
  }
}

// 라이브 캐릭터 — 핸들러는 character.currentRoom만 읽고 in-place 갱신하지만, markCharacterDirty가
// 전체 Character 문서를 스냅샷하므로 픽스처도 전체 문서로 채운다(부분 cast는 스냅샷 경로에서 깨진다).
function makeCharacter(currentRoom: number): Character {
  return {
    _id: 'me',
    name: '무한전사',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
  }
}

function makeLive(currentRoom: number): LiveCharacter {
  return { character: makeCharacter(currentRoom), inventory: [] }
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

// 이름을 해소하지 못하는 기본 해소자 — 점유자를 다루지 않는 케이스의 잡음을 없앤다.
const noNames = (): undefined => undefined

// 방 200 도착 시 world:room 완성 기대값 — 출발 100→도착 200(출구 '서'), 점유자·아이템·크리처 없음.
const ROOM_200_ARRIVAL_EVENT = {
  type: 'world:room',
  roomId: 200,
  name: '방200',
  longDesc: '',
  exits: ['서'],
  occupants: [],
  items: [],
  creatures: [],
} as const

// actor에는 방 필드가 없다(D2) — accountId/characterId만. 핸들러는 currentRoom을 오직 registry에서 읽는다.
const actor: ActorContext = { accountId: 'acc-1', characterId: 'me' }

// handler 조립기 — 4필드 리터럴 반복을 없앤다. overrides가 준 부분만 기본 deps를 덮어쓴다.
function makeHandler(rooms: RoomNode[], overrides: Partial<MoveHandlerDeps> = {}) {
  const { deps } = makeTryMoveDeps(rooms)
  const handler = createMoveHandler({
    liveRegistry: { get: vi.fn(() => makeLive(100)) },
    tryMoveDeps: deps,
    markCharacterDirty: vi.fn(),
    resolveCharacterName: noNames,
    ...overrides,
  })
  return { handler, deps }
}

describe('createMoveHandler', () => {
  describe('성공 이동 (A≠B, non-vacuous)', () => {
    // 출발 방 A=100, 도착 방 B=200, A≠B. A는 '동'→B 출구를 갖고, B는 '서'→A 명명 출구를 가져
    // exits.map(e=>e.name)이 non-vacuous(['서'])다.
    it('점유자 재배치·live.currentRoom 갱신·world:room 이벤트를 낸다', () => {
      const dest = makeRoom(200, [makeExitTo('서', 100)])
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      expect(source.roomId).not.toBe(dest.roomId) // A≠B 명시
      const live = makeLive(100)
      const markDirty = vi.fn()
      const { handler } = makeHandler([source, dest], {
        liveRegistry: { get: vi.fn(() => live) },
        markCharacterDirty: createMarkCharacterDirty(markDirty),
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      // tryMove가 점유자를 재배치했다(source에서 제거, dest에 추가).
      expect(source.occupants.has('me')).toBe(false)
      expect(dest.occupants.has('me')).toBe(true)
      // live 방 위치가 도착 방으로 갱신됐다(D-A1).
      expect(live.character.currentRoom).toBe(200)
      // world:room 상태 이벤트 — correlationId 없음. 점유자는 이름 미해소(noNames)라 비어 있다
      // (해소 케이스는 아래 별도 it이 소유한다).
      expect(event).toEqual(ROOM_200_ARRIVAL_EVENT)
    })

    it('도착 방의 이름·설명·아이템·크리처를 싣는다', () => {
      const dest = makeRoom(200, [makeExitTo('서', 100)], [], {
        name: '어두운 동굴',
        longDesc: '축축한 동굴이다.',
        items: [makeItem('obj-1', '녹슨 검')],
        creatures: [makeCreature('crt-1', '박쥐', { level: 2 })],
      })
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      const { handler } = makeHandler([source, dest])

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({
        name: '어두운 동굴',
        longDesc: '축축한 동굴이다.',
        items: [{ instanceId: 'obj-1', name: '녹슨 검' }],
        creatures: [{ instanceId: 'crt-1', name: '박쥐', level: 2 }],
      })
    })

    it('도착 방의 숨김 아이템·숨김 크리처·비밀 출구를 걸러 낸다', () => {
      const dest = makeRoom(200, [makeExitTo('서', 100), makeExitTo('숨은문', 300, exitFlags(XSECRT))], [], {
        items: [makeItem('obj-1', '녹슨 검'), makeItem('obj-2', '숨은 열쇠', flagsHex(OHIDDN))],
        creatures: [
          makeCreature('crt-1', '박쥐', { level: 2 }),
          makeCreature('crt-2', '투명 유령', { level: 2, flags: flagsHex(MINVIS) }),
        ],
      })
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      const { handler } = makeHandler([source, dest])

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({
        exits: ['서'],
        items: [{ instanceId: 'obj-1', name: '녹슨 검' }],
        creatures: [{ instanceId: 'crt-1', name: '박쥐', level: 2 }],
      })
    })

    it('도착 방 점유자 이름을 resolveCharacterName으로 해소하고 본인도 그대로 싣는다', () => {
      // 도착 방에 먼저 다른 사람(char-2)이 있고, 이동한 본인('me')도 tryMove가 추가한다.
      const dest = makeRoom(200, [makeExitTo('서', 100)], ['char-2'])
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      const names = new Map<string, string>([['me', '무한전사'], ['char-2', '테스토스']])
      const { handler } = makeHandler([source, dest], { resolveCharacterName: (id) => names.get(id) })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      // 본인 제외는 클라이언트 책임이므로 서버는 'me'를 그대로 싣는다(스펙 §4).
      expect(event).toMatchObject({ type: 'world:room' })
      const occupants = (event as { occupants: { characterId: string; name: string }[] }).occupants
      expect(new Set(occupants)).toEqual(
        new Set([
          { characterId: 'char-2', name: '테스토스' },
          { characterId: 'me', name: '무한전사' },
        ]),
      )
    })

    it('hook 순서: onRoomLeft는 source delete 후, onRoomEntered는 dest add 후 각 1회', () => {
      const dest = makeRoom(200, [makeExitTo('서', 100)])
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      const { handler, deps } = makeHandler([source, dest])

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(deps.onRoomLeft).toHaveBeenCalledTimes(1)
      expect(deps.onRoomLeft).toHaveBeenCalledWith(source, expect.anything())
      expect(deps.onRoomEntered).toHaveBeenCalledTimes(1)
      expect(deps.onRoomEntered).toHaveBeenCalledWith(dest, expect.anything())
    })
  })

  describe('거부 (막힌 방향/잠긴 문)', () => {
    it('rule_rejected 이벤트를 내고 점유자·live.currentRoom 불변, markCharacterDirty 미호출', () => {
      const dest = makeRoom(200, [])
      const source = makeRoom(100, [makeExitTo('동', 200, exitFlags(XLOCKD))], ['me'])
      const live = makeLive(100)
      const markDirty = vi.fn()
      const { handler } = makeHandler([source, dest], {
        liveRegistry: { get: vi.fn(() => live) },
        markCharacterDirty: createMarkCharacterDirty(markDirty),
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', message: '문이 잠겨 있습니다' })
      expect(source.occupants.has('me')).toBe(true)
      expect(dest.occupants.size).toBe(0)
      expect(live.character.currentRoom).toBe(100)
      expect(markDirty).not.toHaveBeenCalled()
    })

    it('id가 있으면 rule_rejected 이벤트에 correlationId를 반향한다', () => {
      const source = makeRoom(100, [makeExitTo('동', 200, exitFlags(XLOCKD))], ['me'])
      const { handler } = makeHandler([source, makeRoom(200, [])])

      const event = handler({ type: 'world:move', direction: '동', id: 'm1' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', correlationId: 'm1' })
    })
  })

  describe('성공 시 dirty 마킹 (A≠B, non-vacuous)', () => {
    it("markCharacterDirty를 ('characters', characterId, 전체 문서)로 1회 호출한다 — snapshot이 도착 방", () => {
      const dest = makeRoom(200, [makeExitTo('서', 100)])
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      expect(source.roomId).not.toBe(dest.roomId) // A≠B 명시 — snapshot이 A가 아닌 B임을 증명하려면 필수
      const markDirty = vi.fn()
      const { handler } = makeHandler([source, dest], {
        // 실 헬퍼를 끼워 원시 seam에 도달한 스냅샷을 그대로 관찰한다(부분 스냅샷이면 여기서 드러난다).
        markCharacterDirty: createMarkCharacterDirty(markDirty),
      })

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(markDirty).toHaveBeenCalledTimes(1)
      // collection·id 인자(핸들러가 actor.characterId를 넘긴다). 스냅샷은 아래에서 별도로 본다.
      expect(markDirty.mock.calls[0]?.slice(0, 2)).toEqual(['characters', 'me'])
      // 스냅샷은 mark 시점의 distinct 복사본이므로, currentRoom=B는 in-place 갱신이 마킹보다
      // 선행했음을 증명한다(순서가 뒤집혔다면 출발 방 A가 실린다).
      const snapshot = markDirty.mock.calls[0]?.[2] as Character
      expect(snapshot.currentRoom).toBe(200)
      // 부분 스냅샷이 아니라 전체 문서다 — 다른 필드가 함께 실린다(LWW write-loss 봉쇄 계약).
      expect(snapshot).toMatchObject({ _id: 'me', level: 7, gold: 100, currentRoom: 200 })
    })
  })

  describe('미등록 actor 격리', () => {
    it('liveRegistry.get이 undefined면 error{internal}, 이동·markCharacterDirty·tryMove 없음', () => {
      const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
      const markDirty = vi.fn()
      const { handler, deps } = makeHandler([source, makeRoom(200, [])], {
        liveRegistry: { get: vi.fn(() => undefined) },
        markCharacterDirty: createMarkCharacterDirty(markDirty),
      })

      const event = handler({ type: 'world:move', direction: '동' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'internal' })
      expect(source.occupants.has('me')).toBe(true)
      expect(markDirty).not.toHaveBeenCalled()
      // resolveRoom 미호출 = real tryMove 미실행(tryMove 첫 동작이 resolveRoom(currentRoomId)).
      expect(deps.resolveRoom).not.toHaveBeenCalled()
    })

    it('미등록 actor + id면 internal 이벤트에 correlationId를 반향한다', () => {
      const { handler } = makeHandler([], { liveRegistry: { get: vi.fn(() => undefined) } })

      const event = handler({ type: 'world:move', direction: '동', id: 'm2' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'internal', correlationId: 'm2' })
    })
  })

  describe('D2 신원 — currentRoom 출처는 registry', () => {
    it('핸들러는 currentRoom을 registry 엔트리에서 읽는다(actor에는 방 필드가 없다)', () => {
      // registry가 방 777을 준다. actor에는 어떤 방 정보도 없다. tryMove가 777을 source로 해석함을
      // resolveRoom 호출 인자로 확인한다 — 방 위치가 오직 registry에서 왔음을 증명한다.
      const dest = makeRoom(888, [makeExitTo('북', 777)])
      const source = makeRoom(777, [makeExitTo('동', 888)], ['me'])
      const { handler, deps } = makeHandler([source, dest], { liveRegistry: { get: vi.fn(() => makeLive(777)) } })

      handler({ type: 'world:move', direction: '동' }, actor)

      expect(deps.resolveRoom).toHaveBeenCalledWith(777)
    })

    it('defensive narrow: world:move가 아닌 명령은 undefined를 반환한다', () => {
      const { handler } = makeHandler([])
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
    expect(result.events[0]).toMatchObject({ type: 'error', code: 'unknown_type' })
  })

  it('moveDeps를 주면 world:move가 move 핸들러로 디스패치된다', () => {
    const dest = makeRoom(200, [makeExitTo('서', 100)])
    const source = makeRoom(100, [makeExitTo('동', 200)], ['me'])
    const { deps } = makeTryMoveDeps([source, dest])
    const registry = createCommandRegistry(testChannelPort, {
      move: {
        liveRegistry: { get: vi.fn(() => makeLive(100)) },
        tryMoveDeps: deps,
        markCharacterDirty: vi.fn(),
        resolveCharacterName: noNames,
      },
    })

    const result = dispatch(registry, { type: 'world:move', direction: '동' }, actor, testPermission)

    expect(result.outcome).toBe('handled')
    expect(result.events[0]).toEqual(ROOM_200_ARRIVAL_EVENT)
  })
})
