import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type Character } from 'shared'
import type { RoomNode } from 'shared'
import { createLiveCharacterRegistry, type LiveCharacter } from './liveCharacterRegistry.js'
import {
  createLiveCharacterEntry,
  DEFAULT_START_ROOM,
  type LiveCharacterEntryDeps,
} from './liveCharacterEntry.js'

/**
 * liveCharacterEntry — hydrate(로드) / place(방 배치) / release(퇴장) 코어.
 *
 * hydrate는 부수효과 없는 로드(D-G 2)이고 place/release가 동기 배치·퇴장을 소유한다.
 * 재접속은 재로드하지 않는다(D-G 1) — 등록된 엔트리를 그대로 돌려줘 미영속 currentRoom을
 * 덮어쓰지 않는다. release의 occupants.delete는 onRoomLeft보다 반드시 선행한다(tryMove 미러).
 */
function makeCharacter(id: string, currentRoom = 1): Character {
  return {
    _id: id,
    name: '테스토스',
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
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
  }
}

function makeRoom(roomId: number): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

type Harness = {
  deps: LiveCharacterEntryDeps
  findById: ReturnType<typeof vi.fn>
  onRoomEntered: ReturnType<typeof vi.fn>
  onRoomLeft: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  rooms: Map<number, RoomNode>
  registry: ReturnType<typeof createLiveCharacterRegistry>
}

function makeHarness(character: Character | null): Harness {
  const registry = createLiveCharacterRegistry()
  const rooms = new Map<number, RoomNode>()
  rooms.set(DEFAULT_START_ROOM, makeRoom(DEFAULT_START_ROOM))
  if (character !== null) rooms.set(character.currentRoom, makeRoom(character.currentRoom))

  const findById = vi.fn((_id: string) => Promise.resolve(character))
  const onRoomEntered = vi.fn()
  const onRoomLeft = vi.fn()
  const warn = vi.fn()

  const deps: LiveCharacterEntryDeps = {
    characterRepo: { findById },
    liveRegistry: registry,
    resolveRoom: (roomId: number) => rooms.get(roomId),
    onRoomEntered,
    onRoomLeft,
    logger: { warn },
  }
  return { deps, findById, onRoomEntered, onRoomLeft, warn, rooms, registry }
}

describe('createLiveCharacterEntry', () => {
  let h: Harness

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('hydrate', () => {
    it('사전 등록된 엔트리는 findById 호출 없이 동일 참조를 반환한다(D-G 1)', async () => {
      const character = makeCharacter('char-1')
      h = makeHarness(character)
      const live: LiveCharacter = { character }
      h.registry.register(live)

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(h.findById).toHaveBeenCalledTimes(0)
      expect(result).toBe(live)
    })

    it('미등록이면 findById 1회 호출, 레지스트리·occupants는 불변이다(부수효과 없음, D-G 2)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const room = h.rooms.get(5)!

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(h.findById).toHaveBeenCalledTimes(1)
      expect(result.character._id).toBe('char-1')
      expect(h.registry.has('char-1')).toBe(false)
      expect(room.occupants.size).toBe(0)
      expect(h.onRoomEntered).not.toHaveBeenCalled()
    })

    it('미등록 characterId 로드 결과가 null이면 명확한 에러를 던진다', async () => {
      h = makeHarness(null)
      const entry = createLiveCharacterEntry(h.deps)
      await expect(entry.hydrate('missing')).rejects.toThrow(/missing/)
    })

    it('currentRoom이 orphan이면 DEFAULT_START_ROOM으로 교정하고 warn을 1회 호출한다', async () => {
      const character = makeCharacter('char-1', 9999) // resolveRoom가 undefined 반환
      h = makeHarness(character)
      // orphan 방을 실제로 미해소로 만든다(생성자에서 9999 방을 넣었으므로 제거).
      h.rooms.delete(9999)

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.currentRoom).toBe(DEFAULT_START_ROOM)
      expect(h.warn).toHaveBeenCalledTimes(1)
      // 교정된 엔트리는 즉시 배치 가능해야 한다(fallback 방은 그래프에 해소됨 — invariant 5 end-to-end).
      expect(() => entry.place(result)).not.toThrow()
    })
  })

  describe('place', () => {
    it('occupants에 characterId를 추가하고 onRoomEntered를 add 이후에 호출한다(순서 계약)', () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const room = h.rooms.get(5)!
      const entry = createLiveCharacterEntry(h.deps)

      // onRoomEntered 호출 시점에 occupants에 이미 자신이 있음을 관측한다(add가 hook보다 선행).
      let presentAtHook = false
      h.onRoomEntered.mockImplementation(() => {
        presentAtHook = room.occupants.has('char-1')
      })

      entry.place({ character })

      expect(room.occupants.has('char-1')).toBe(true)
      expect(h.onRoomEntered).toHaveBeenCalledTimes(1)
      expect(presentAtHook).toBe(true) // add가 hook보다 선행(tryMove:197-199 미러)
      expect(h.registry.has('char-1')).toBe(true)
    })

    it('같은 캐릭터를 다시 place해도 중복 추가·중복 훅 호출하지 않는다(재접속 멱등)', () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const room = h.rooms.get(5)!
      const entry = createLiveCharacterEntry(h.deps)

      entry.place({ character })
      entry.place({ character })

      expect(room.occupants.size).toBe(1)
      expect(h.onRoomEntered).toHaveBeenCalledTimes(1)
    })
  })

  describe('release', () => {
    it('occupants에서 제거하고 onRoomLeft는 delete 이후에 호출한다(순서 계약)', () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const room = h.rooms.get(5)!
      const entry = createLiveCharacterEntry(h.deps)
      entry.place({ character })

      // onRoomLeft 호출 시점에 occupants가 이미 비어 있음을 관측한다.
      let occupantsAtHook = -1
      h.onRoomLeft.mockImplementation(() => {
        occupantsAtHook = room.occupants.size
      })

      entry.release('char-1')

      expect(room.occupants.has('char-1')).toBe(false)
      expect(h.onRoomLeft).toHaveBeenCalledTimes(1)
      expect(occupantsAtHook).toBe(0) // delete가 hook보다 선행
      expect(h.registry.has('char-1')).toBe(false)
    })

    it('미등록 characterId는 no-op(throw·훅 호출 없음)', () => {
      h = makeHarness(null)
      const entry = createLiveCharacterEntry(h.deps)
      expect(() => entry.release('unknown')).not.toThrow()
      expect(h.onRoomLeft).not.toHaveBeenCalled()
    })
  })
})
