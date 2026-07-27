import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode } from 'shared'
import { buildApp } from '../app.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import type { LiveWorldWiringBundle } from './liveWorldWiring.js'

/**
 * plugin.ts 라이브 월드 결선(Story 7) — buildApp/registerWebsocket에 라이브 월드 의존 묶음이 주입되면
 * 채널·수명 포트가 묶음 파생 어댑터로 세워지고, 명시 포트가 함께 주어지면 명시 포트가 우선한다
 * (explicit > bundle-derived > noop, #2). wsLifecyclePort 데코레이션으로 어느 포트가 배선됐는지 관측한다.
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

function makeRoom(roomId: number, occupantIds: readonly string[] = []): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [],
    occupants: new Set<string>(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

type BundleHarness = {
  bundle: LiveWorldWiringBundle
  markDirty: ReturnType<typeof vi.fn>
  liveRegistry: ReturnType<typeof createLiveCharacterRegistry>
  room: RoomNode
}

function makeBundle(): BundleHarness {
  const room = makeRoom(1, ['char-1'])
  const worldGraph = new Map<number, RoomNode>([[1, room]])
  const liveRegistry = createLiveCharacterRegistry()
  liveRegistry.register({ character: makeCharacter('char-1', 1) })
  const markDirty = vi.fn()
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: { findById: vi.fn(() => Promise.resolve(null)) },
    markDirty,
    currentHour: () => 12,
    onRoomEntered: vi.fn(),
    onRoomLeft: vi.fn(),
    logger: { warn: vi.fn() },
  }
  return { bundle, markDirty, liveRegistry, room }
}

describe('registerWebsocket 라이브 월드 묶음 결선', () => {
  it('묶음 주입 시 wsLifecyclePort가 묶음 파생 라이브 수명 어댑터로 세워진다', async () => {
    const h = makeBundle()
    const app = buildApp({ liveWorldDeps: h.bundle })
    await app.ready()

    // 라이브 어댑터는 종료 시 최종 방을 markDirty한 뒤 release한다(no-op 어댑터라면 markDirty가 없다).
    app.wsLifecyclePort.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'shutdown' })
    expect(h.markDirty).toHaveBeenCalledWith('characters', 'char-1', { currentRoom: 1 })

    await app.close()
  })

  it('명시 lifecyclePort가 묶음보다 우선한다(explicit > bundle-derived, #2)', async () => {
    const h = makeBundle()
    const explicit: SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } = {
      onSessionEnd: vi.fn(),
    }
    const app = buildApp({ liveWorldDeps: h.bundle, lifecyclePort: explicit })
    await app.ready()

    app.wsLifecyclePort.onSessionEnd({ accountId: 'acct-1', characterId: 'char-1', reason: 'shutdown' })
    // 명시 포트가 호출되고, 묶음 파생 어댑터(markDirty)는 관여하지 않는다.
    expect(explicit.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(h.markDirty).not.toHaveBeenCalled()

    await app.close()
  })

  it('묶음 미주입 시 wsLifecyclePort는 no-op 어댑터로 남는다(기존 동작 보존)', async () => {
    const app = buildApp()
    await app.ready()

    expect(typeof app.wsLifecyclePort.onSessionEnd).toBe('function')
    expect(() =>
      app.wsLifecyclePort.onSessionEnd({
        accountId: 'acc-1',
        characterId: 'char-x',
        reason: 'graceExpired',
      }),
    ).not.toThrow()

    await app.close()
  })
})
