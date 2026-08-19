import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type Character, type ObjectInstance } from 'shared'
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

/** 테스트용 유효 ObjectInstance 팩토리 — objectSchema shape를 정확히 만족한다. */
function makeObject(id: string): ObjectInstance {
  return {
    _id: id,
    objnum: 100,
    type: 3,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 50,
    shotscur: 0,
    schemaVersion: 1,
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
  hydrateInventory: ReturnType<typeof vi.fn>
  onRoomEntered: ReturnType<typeof vi.fn>
  onRoomLeft: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  peekPendingCharacter: ReturnType<typeof vi.fn>
  rooms: Map<number, RoomNode>
  registry: ReturnType<typeof createLiveCharacterRegistry>
}

function makeHarness(character: Character | null, inventory: ObjectInstance[] = []): Harness {
  const registry = createLiveCharacterRegistry()
  const rooms = new Map<number, RoomNode>()
  rooms.set(DEFAULT_START_ROOM, makeRoom(DEFAULT_START_ROOM))
  if (character !== null) rooms.set(character.currentRoom, makeRoom(character.currentRoom))

  const findById = vi.fn((_id: string) => Promise.resolve(character))
  // 조회마다 새 배열을 돌려준다(저장소 계약 미러) — 참조 동일성이 아니라 내용·순서로 단언하게 만든다.
  const hydrateInventory = vi.fn((_id: string) => Promise.resolve([...inventory]))
  const onRoomEntered = vi.fn()
  const onRoomLeft = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  // 기본값은 "미영속 스냅샷 없음" — 기존 케이스의 의미를 바꾸지 않는다(#8.12 회귀 없음).
  const peekPendingCharacter = vi.fn((_id: string): unknown => undefined)

  const deps: LiveCharacterEntryDeps = {
    characterRepo: { findById, hydrateInventory },
    liveRegistry: registry,
    resolveRoom: (roomId: number) => rooms.get(roomId),
    onRoomEntered,
    onRoomLeft,
    peekPendingCharacter,
    logger: { warn, error },
  }
  return {
    deps,
    findById,
    hydrateInventory,
    onRoomEntered,
    onRoomLeft,
    warn,
    error,
    peekPendingCharacter,
    rooms,
    registry,
  }
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
      const live: LiveCharacter = { character, inventory: [] }
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

  /**
   * 인벤토리 적재(T3.3) — hydrate의 세 반환 지점 각각에 대한 계약.
   *
   * 정상 경로·orphan 폴백은 `hydrateInventory` 결과를 싣고, 조기 반환(등록 엔트리)은 기존 인벤을
   * 보존하며 저장소를 다시 치지 않는다. 후자를 재로드하면 재접속마다 인벤이 디스크 스냅샷으로
   * 되돌아가 미영속 라이브 변경(연마로 소모된 비법서 등)이 되살아난다.
   */
  describe('hydrate 인벤토리 적재', () => {
    it('정상 경로는 hydrateInventory 결과를 순서대로 싣는다', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character, [makeObject('obj-a'), makeObject('obj-b')])

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.inventory.map((o) => o._id)).toEqual(['obj-a', 'obj-b'])
      expect(h.hydrateInventory).toHaveBeenCalledWith('char-1')
    })

    it('orphan 폴백 경로도 인벤토리를 싣는다(방 교정이 인벤 적재를 건너뛰지 않는다)', async () => {
      const character = makeCharacter('char-1', 9999)
      h = makeHarness(character, [makeObject('obj-a')])
      h.rooms.delete(9999)

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.currentRoom).toBe(DEFAULT_START_ROOM)
      expect(result.inventory.map((o) => o._id)).toEqual(['obj-a'])
    })

    it('조기 반환(등록 엔트리)은 기존 인벤을 유지하고 hydrateInventory를 호출하지 않는다', async () => {
      const character = makeCharacter('char-1')
      // 저장소가 다른 내용을 갖고 있어도 조기 반환은 그것을 읽지 않아야 한다(비-vacuous).
      h = makeHarness(character, [makeObject('obj-disk')])
      const liveInventory = [makeObject('obj-live')]
      h.registry.register({ character, inventory: liveInventory })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(h.hydrateInventory).toHaveBeenCalledTimes(0)
      expect(result.inventory).toBe(liveInventory)
    })

    it('1회 hydrate에서 hydrateInventory 호출은 정확히 1회다(OQ3 왕복 상한 — N+1 차단)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character, [makeObject('obj-a'), makeObject('obj-b'), makeObject('obj-c')])

      const entry = createLiveCharacterEntry(h.deps)
      await entry.hydrate('char-1')

      expect(h.hydrateInventory).toHaveBeenCalledTimes(1)
    })

    it('재접속(D-G 1)은 인벤을 두 벌 만들지 않고 기존 참조를 유지한다', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character, [makeObject('obj-a')])
      const entry = createLiveCharacterEntry(h.deps)

      const first = await entry.hydrate('char-1')
      entry.place(first) // 레지스트리 등록 — 이후 hydrate는 조기 반환 경로로 들어간다
      const second = await entry.hydrate('char-1')

      expect(second).toBe(first)
      expect(second.inventory).toBe(first.inventory)
      expect(second.inventory).toHaveLength(1)
      expect(h.hydrateInventory).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * pending 스냅샷 overlay(#124) — 재진입 hydrate가 write-behind 미영속 진행도를 잃지 않는지.
   *
   * 계약 순서는 peekPending(동기 선형화 지점) → findById → characterPatchSchema 검증 → overlay →
   * 인벤 적재 → orphan 폴백이다. 검증 실패는 error 1건 후 저장소 문서로 폴백하고 throw하지 않는다.
   */
  describe('hydrate pending overlay (#124)', () => {
    it('peekPending을 findById보다 먼저 호출한다(§8.5 선형화 지점)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)

      const calls: string[] = []
      let openGate!: () => void
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      h.peekPendingCharacter.mockImplementation((_id: string) => {
        calls.push('peek')
        return undefined
      })
      h.findById.mockImplementation(async (_id: string) => {
        calls.push('findById')
        await gate
        return character
      })

      const entry = createLiveCharacterEntry(h.deps)
      const pending = entry.hydrate('char-1')
      // findById가 게이트에 걸린 시점에도 peek은 이미 끝나 있어야 한다(동기 선행).
      await Promise.resolve()
      expect(calls).toEqual(['peek', 'findById'])

      openGate()
      await pending
      expect(calls).toEqual(['peek', 'findById'])
    })

    it('검증 실패 스냅샷은 error 1건 후 저장소 문서로 폴백한다(§8.9 — throw 없음)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      // gold가 숫자가 아니라 characterPatchSchema.safeParse가 실패한다.
      h.peekPendingCharacter.mockReturnValue({ gold: '많음' })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character).toEqual(character)
      expect(h.error).toHaveBeenCalledTimes(1)
      expect(h.warn).not.toHaveBeenCalled()
    })

    it('정상 전체 스냅샷을 저장소 문서 위에 덮는다(§8.10 케이스 1 — _id는 요청 id 유지)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      h.peekPendingCharacter.mockReturnValue({
        _id: 'char-1',
        gold: 999,
        level: 9,
        experience: 4242,
      })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character._id).toBe('char-1')
      expect(result.character.gold).toBe(999)
      expect(result.character.level).toBe(9)
      expect(result.character.experience).toBe(4242)
      // overlay되지 않은 필드는 저장소 값을 유지한다.
      expect(result.character.name).toBe(character.name)
      expect(h.error).not.toHaveBeenCalled()
    })

    it('스냅샷의 _id가 요청 characterId와 달라도 _id는 바뀌지 않는다(§8.10 케이스 2)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      h.peekPendingCharacter.mockReturnValue({ _id: 'char-999', gold: 777 })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character._id).toBe('char-1')
      expect(result.character.gold).toBe(777)
    })

    it('pending 스냅샷 객체를 mutate하지 않는다(라이브 참조 오염 금지)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const snapshot: Record<string, unknown> = { gold: 555 }
      h.peekPendingCharacter.mockReturnValue(snapshot)

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(snapshot).toEqual({ gold: 555 })
      expect(result.character).not.toBe(snapshot)
    })

    /**
     * 중첩 컨테이너까지 참조가 끊겨야 한다.
     *
     * hydrate가 돌려주는 캐릭터는 in-place로 변이되는 라이브 객체다(regen이 hpCurrent를 직접
     * 바꾼다). 중첩 배열이 pending 스냅샷과 참조를 공유하면 그 라이브 변이가 곧 flush될 스냅샷을
     * 오염시킨다. 지금 이 성질은 safeParse가 배열·객체를 새로 만들어 주는 데서 나오므로, 검증을
     * `as Partial<Character>` 캐스트로 대체하는 "최적화"가 들어오면 여기서 잡힌다.
     */
    it('overlay 결과는 pending의 중첩 컨테이너와 참조를 공유하지 않는다', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      const stats = [10, 11, 12, 13, 14]
      const spells = Array.from({ length: 16 }, () => 0)
      h.peekPendingCharacter.mockReturnValue({ stats, spells })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.stats).toEqual(stats)
      expect(result.character.stats).not.toBe(stats)
      expect(result.character.spells).not.toBe(spells)
    })

    /**
     * §M-1 — 값이 undefined인 키가 stored의 필수 필드를 지우지 않는다.
     *
     * zod의 .partial()은 키가 존재하면 값이 undefined여도 출력에 남긴다. 그대로 spread하면
     * 타입은 number인데 런타임 값이 undefined인 캐릭터가 라이브 레지스트리에 들어가고, 이후
     * 규칙이 NaN을 뿜으며 다음 flush가 그 undefined를 $set한다 — 전 구간이 무성 실패다.
     */
    it('값이 undefined인 pending 키는 저장소 값을 덮지 않는다', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      h.peekPendingCharacter.mockReturnValue({ gold: undefined, level: 9 })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.gold).toBe(character.gold)
      expect(result.character.gold).not.toBeUndefined()
      expect(result.character.level).toBe(9) // 정상 값은 그대로 overlay된다
    })

    it('pending이 없으면 저장소 문서를 그대로 쓴다(§8.12 회귀 없음)', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character, [makeObject('obj-a')])

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(h.peekPendingCharacter).toHaveBeenCalledTimes(1)
      expect(h.peekPendingCharacter).toHaveBeenCalledWith('char-1')
      expect(result.character).toEqual(character)
      expect(result.inventory.map((o) => o._id)).toEqual(['obj-a'])
      expect(h.error).not.toHaveBeenCalled()
      expect(h.warn).not.toHaveBeenCalled()
    })

    it('overlay가 orphan 폴백보다 앞서 적용된다(pending의 유효 currentRoom을 잃지 않는다)', async () => {
      const character = makeCharacter('char-1', 9999)
      h = makeHarness(character)
      h.rooms.delete(9999) // 저장소 문서의 방은 orphan
      h.rooms.set(5, makeRoom(5)) // pending의 방은 유효
      h.peekPendingCharacter.mockReturnValue({ currentRoom: 5 })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.currentRoom).toBe(5)
      expect(h.warn).not.toHaveBeenCalled()
    })

    it('overlay 후에도 currentRoom이 orphan이면 DEFAULT_START_ROOM으로 폴백한다', async () => {
      const character = makeCharacter('char-1', 5)
      h = makeHarness(character)
      h.peekPendingCharacter.mockReturnValue({ currentRoom: 8888 })

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result.character.currentRoom).toBe(DEFAULT_START_ROOM)
      expect(h.warn).toHaveBeenCalledTimes(1)
    })

    it('등록된 엔트리 조기 반환은 peekPending·findById를 모두 호출하지 않는다(D-G 1 보존)', async () => {
      const character = makeCharacter('char-1')
      h = makeHarness(character)
      const live: LiveCharacter = { character, inventory: [] }
      h.registry.register(live)

      const entry = createLiveCharacterEntry(h.deps)
      const result = await entry.hydrate('char-1')

      expect(result).toBe(live)
      expect(h.peekPendingCharacter).toHaveBeenCalledTimes(0)
      expect(h.findById).toHaveBeenCalledTimes(0)
    })
  })

  // 주석 문자열(오라클 근거·추적 임계·이슈 번호)을 readFileSync로 단언하는 테스트는 두지 않는다 —
  // 동작이 아니라 산문을 검증해 표기를 다듬으면 깨지고, 반대로 주석만 남고 동작이 사라져도 통과한다.
  // divergence 추적은 CLAUDE.md '알려진 divergence' 절과 이슈 #142가 소유한다.

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

      entry.place({ character, inventory: [] })

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

      entry.place({ character, inventory: [] })
      entry.place({ character, inventory: [] })

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
      entry.place({ character, inventory: [] })

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
