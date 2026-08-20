import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode } from 'shared'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { createLiveCharacterEntry } from '../world/liveCharacterEntry.js'
import { createMarkCharacterDirty } from '../world/markCharacterDirty.js'
import { createCombatRegistry } from '../combat/combatRegistry.js'
import { createLiveSessionLifecycleAdapter } from './liveSessionLifecycleAdapter.js'
import type { DisconnectReason } from './sessionRegistry.js'

/**
 * liveSessionLifecycleAdapter — 세션 종결 시 방 점유 해제 + 라이브 엔트리 제거 + 최종 currentRoom 영속화.
 *
 * 실 레지스트리 + 실 createLiveCharacterEntry(Story 3 release 코어) + 실 RoomNode(Set occupants)를 써
 * release가 occupants/registry를 진짜로 변이하도록 구성한다. 어댑터에는 실 markCharacterDirty 헬퍼를
 * 끼우고 그 하위의 원시 markDirty seam만 spy로 관찰한다 — 어댑터가 흘린 스냅샷의 실제 형태를 본다.
 * 네 가지 DisconnectReason은 동일하게 처리되어야 한다(reason 미분기, T6.4).
 */
function makeCharacter(id: string, currentRoom: number): Character {
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

/**
 * 실 레지스트리 + 실 entry를 조립한다. `loadRoom`에 방을 하나 두고 캐릭터를 그 방에 로드·배치한다.
 * 반환된 release는 팩토리 클로저(this 미사용)라 standalone으로 전달해도 동작한다.
 */
function setup(loadRoom: number) {
  const registry = createLiveCharacterRegistry()
  const rooms = new Map<number, RoomNode>()
  rooms.set(loadRoom, makeRoom(loadRoom))
  const character = makeCharacter('char-1', loadRoom)
  const onRoomEntered = vi.fn()
  const onRoomLeft = vi.fn()
  const entry = createLiveCharacterEntry({
    characterRepo: {
      findById: vi.fn(() => Promise.resolve(character)),
      hydrateInventory: vi.fn(() => Promise.resolve([])),
    },
    liveRegistry: registry,
    resolveRoom: (id: number) => rooms.get(id),
    onRoomEntered,
    onRoomLeft,
    peekPendingCharacter: () => undefined,
    logger: { warn: vi.fn(), error: vi.fn() },
  })
  return { registry, rooms, entry, onRoomEntered, onRoomLeft, character }
}

async function placeChar(fixture: ReturnType<typeof setup>) {
  const live = await fixture.entry.hydrate('char-1')
  fixture.entry.place(live)
  return live
}

const REASONS: readonly DisconnectReason[] = [
  'evictedByNewLogin',
  'graceExpired',
  'idleTimeout',
  'shutdown',
]

describe('createLiveSessionLifecycleAdapter', () => {
  it.each(REASONS)(
    'reason=%s: 방 점유 해제 + 엔트리 제거 + markDirty 정확히 1회 (네 사유 동일)',
    async (reason) => {
      const fx = setup(5)
      await placeChar(fx)
      const room = fx.rooms.get(5)
      expect(room?.occupants.has('char-1')).toBe(true)
      expect(fx.registry.has('char-1')).toBe(true)

      const markDirty = vi.fn()
      const adapter = createLiveSessionLifecycleAdapter({
        liveRegistry: fx.registry,
        release: (id) => fx.entry.release(id),
        markCharacterDirty: createMarkCharacterDirty(markDirty),
        combatRegistry: createCombatRegistry(),
      })

      adapter.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason })

      expect(room?.occupants.has('char-1')).toBe(false)
      expect(fx.registry.has('char-1')).toBe(false)
      expect(markDirty).toHaveBeenCalledTimes(1)
    },
  )

  it('keystone(비-vacuous): END-TIME 방 B로 markDirty한다(로드 시점 방 A 아님) — A≠B', async () => {
    const ROOM_A = 10
    const ROOM_B = 20
    expect(ROOM_A).not.toBe(ROOM_B) // 픽스처 불변식: A≠B가 아니면 이 검증은 아무것도 증명하지 못한다

    const fx = setup(ROOM_A)
    fx.rooms.set(ROOM_B, makeRoom(ROOM_B))
    const live = await placeChar(fx) // 로드·배치: occupant는 방 A, currentRoom=A

    // 이전 이동 A→B를 모사한다: 점유자를 A에서 B로 옮기고 currentRoom을 B로 in-place 갱신한다.
    fx.rooms.get(ROOM_A)?.occupants.delete('char-1')
    fx.rooms.get(ROOM_B)?.occupants.add('char-1')
    live.character.currentRoom = ROOM_B

    const markDirty = vi.fn()
    const adapter = createLiveSessionLifecycleAdapter({
      liveRegistry: fx.registry,
      release: (id) => fx.entry.release(id),
      markCharacterDirty: createMarkCharacterDirty(markDirty),
      combatRegistry: createCombatRegistry(),
    })

    adapter.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'graceExpired' })

    // END-TIME 방 B로 기록해야 한다 — 로드 시점 방 A로 캐싱했다면 실패한다.
    // 스냅샷이 전체 문서라 exact 매칭 대신 objectContaining으로 대조한다. not 단언도 objectContaining으로
    // 두어야 A≠B keystone이 vacuous해지지 않는다(exact 매칭이면 전체 문서 앞에서 항상 참이 된다).
    expect(markDirty).toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ currentRoom: ROOM_B }),
    )
    expect(markDirty).not.toHaveBeenCalledWith(
      'characters',
      'char-1',
      expect.objectContaining({ currentRoom: ROOM_A }),
    )
  })

  it('dirty-before-release 순서: markDirty 호출 시점에 엔트리가 아직 존재한다', async () => {
    const fx = setup(7)
    await placeChar(fx)

    let hasAtMarkTime: boolean | undefined
    let snapshotAtMarkTime: unknown
    // 호출 시점에 registry.has를 읽어 순서를 고정한다 — release가 선행했다면 false가 된다.
    const markDirty = vi.fn((_collection: string, id: string, snapshot: unknown) => {
      hasAtMarkTime = fx.registry.has(id)
      snapshotAtMarkTime = snapshot
    })
    const adapter = createLiveSessionLifecycleAdapter({
      liveRegistry: fx.registry,
      release: (id) => fx.entry.release(id),
      markCharacterDirty: createMarkCharacterDirty(markDirty),
      combatRegistry: createCombatRegistry(),
    })

    adapter.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'idleTimeout' })

    expect(hasAtMarkTime).toBe(true) // mark 시점 엔트리 존재 → release보다 선행
    // release 이후였다면 엔트리가 사라져 방을 읽을 수 없다. 스냅샷은 전체 문서라 subset으로 대조한다.
    expect(snapshotAtMarkTime).toMatchObject({ _id: 'char-1', currentRoom: 7 })
    expect(fx.registry.has('char-1')).toBe(false) // release는 mark 이후에 실행됐다
  })

  it('미등록 id: throw 없음 + markDirty 미호출 + occupants 무변이', async () => {
    const fx = setup(5)
    await placeChar(fx) // 'char-1'만 배치, 'ghost'는 미등록
    const room = fx.rooms.get(5)

    const markDirty = vi.fn()
    const adapter = createLiveSessionLifecycleAdapter({
      liveRegistry: fx.registry,
      release: (id) => fx.entry.release(id),
      markCharacterDirty: createMarkCharacterDirty(markDirty),
      combatRegistry: createCombatRegistry(),
    })

    expect(() =>
      adapter.onSessionEnd({ accountId: 'acct-1', characterId: 'ghost', reason: 'shutdown' }),
    ).not.toThrow()

    expect(markDirty).not.toHaveBeenCalled()
    expect(fx.registry.has('ghost')).toBe(false)
    expect(room?.occupants.has('char-1')).toBe(true) // 무관 엔트리는 그대로
  })
})
