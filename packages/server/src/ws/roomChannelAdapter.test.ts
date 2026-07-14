import { describe, it, expect, vi } from 'vitest'
import type { RoomNode } from 'shared'
import { createRoomChannelAdapter } from './roomChannelAdapter.js'
import type { ChannelDeliveryContext } from './channelPort.js'
import type { ActorContext } from './actorContext.js'

/**
 * 완전한 RoomNode fake를 만든다 — resolveRoom이 `RoomNode | undefined`를 반환하므로
 * fake도 전 필드를 채워야 tsc가 통과한다(`as` 캐스트 금지, 프로젝트 규칙). 그래프 필드는
 * 빈 값으로 두고 occupants만 테스트가 관심 있는 값으로 채운다.
 */
function makeRoom(occupantIds: readonly string[]): RoomNode {
  return {
    roomId: 1,
    name: '테스트 방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [],
    occupants: new Set<string>(occupantIds),
  }
}

const speaker: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

describe('createRoomChannelAdapter', () => {
  it('발화자 방 occupants 전 멤버에게 sendTo를 정확히 1회씩 fan-out한다(집합 == occupants)', () => {
    const room = makeRoom(['char-1', 'char-2', 'char-3'])
    const resolveRoom = vi.fn((_characterId: string): RoomNode | undefined => room)
    const sendTo = vi.fn<(characterId: string, ctx: ChannelDeliveryContext) => void>()
    const adapter = createRoomChannelAdapter({ resolveRoom, sendTo })

    const ctx: ChannelDeliveryContext = { speaker, channel: 'say', text: '안녕' }
    adapter.deliver(ctx)

    expect(sendTo).toHaveBeenCalledTimes(3)
    const called = new Set(sendTo.mock.calls.map((call) => call[0]))
    expect(called).toEqual(room.occupants)
  })

  it('deliver는 동기(void 반환, Promise 아님)다', () => {
    const room = makeRoom(['char-1'])
    const resolveRoom = vi.fn((_characterId: string): RoomNode | undefined => room)
    const sendTo = vi.fn<(characterId: string, ctx: ChannelDeliveryContext) => void>()
    const adapter = createRoomChannelAdapter({ resolveRoom, sendTo })

    const result = adapter.deliver({ speaker, channel: 'say', text: '안녕' })

    expect(result).toBeUndefined()
  })

  it('resolveRoom이 undefined면(방 미해석) sendTo를 호출하지 않는다(no-op)', () => {
    const resolveRoom = vi.fn((_characterId: string): RoomNode | undefined => undefined)
    const sendTo = vi.fn<(characterId: string, ctx: ChannelDeliveryContext) => void>()
    const adapter = createRoomChannelAdapter({ resolveRoom, sendTo })

    adapter.deliver({ speaker, channel: 'say', text: '안녕' })

    expect(sendTo).not.toHaveBeenCalled()
  })

  it('발화자 자신이 occupants에 있으면 전달 대상에 포함한다(제외하지 않음)', () => {
    const room = makeRoom(['char-1', 'char-2'])
    const resolveRoom = vi.fn((_characterId: string): RoomNode | undefined => room)
    const sendTo = vi.fn<(characterId: string, ctx: ChannelDeliveryContext) => void>()
    const adapter = createRoomChannelAdapter({ resolveRoom, sendTo })

    adapter.deliver({ speaker, channel: 'say', text: '안녕' })

    const called = new Set(sendTo.mock.calls.map((call) => call[0]))
    expect(called.has('char-1')).toBe(true)
  })

  it('발화자 characterId로 방을 조회하고 ctx를 그대로 sendTo에 전달한다(speaker·channel·text·target 보존)', () => {
    const room = makeRoom(['char-1', 'char-2'])
    const resolveRoom = vi.fn((_characterId: string): RoomNode | undefined => room)
    const sendTo = vi.fn<(characterId: string, ctx: ChannelDeliveryContext) => void>()
    const adapter = createRoomChannelAdapter({ resolveRoom, sendTo })

    const ctx: ChannelDeliveryContext = {
      speaker,
      channel: 'emote',
      text: '인사',
      target: 'char-2',
    }
    adapter.deliver(ctx)

    expect(resolveRoom).toHaveBeenCalledWith('char-1')
    for (const call of sendTo.mock.calls) {
      expect(call[1]).toBe(ctx)
    }
  })
})
