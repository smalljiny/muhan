import { describe, it, expect, vi } from 'vitest'
import { createChatHandler } from './chat.js'
import type { ChannelDeliveryContext, ChannelPort } from '../channelPort.js'
import type { ActorContext } from '../actorContext.js'

const actor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

// deliver를 ChannelDeliveryContext 시그니처로 타입해 mock.calls[0][0]이 any가 되지 않게 한다
// (no-unsafe-assignment 회피 + 인자 구조 검증 유지).
function spyPort(): {
  port: ChannelPort
  deliver: ReturnType<typeof vi.fn<(ctx: ChannelDeliveryContext) => void>>
} {
  const deliver = vi.fn<(ctx: ChannelDeliveryContext) => void>()
  return { port: { deliver }, deliver }
}

describe('createChatHandler', () => {
  it('chat:message를 speaker=actor·매핑 channel·text로 정확히 1회 deliver한다', () => {
    const { port, deliver } = spyPort()
    const handler = createChatHandler(port)

    const result = handler({ type: 'chat:message', channel: 'yell', text: '외침' }, actor)

    expect(result).toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith({ speaker: actor, channel: 'yell', text: '외침' })
  })

  it('chat:emote를 channel=emote·text=command.emote로 매핑해 deliver한다 (target 포함)', () => {
    const { port, deliver } = spyPort()
    const handler = createChatHandler(port)

    handler({ type: 'chat:emote', emote: '인사', target: 'char-2' }, actor)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith({
      speaker: actor,
      channel: 'emote',
      text: '인사',
      target: 'char-2',
    })
  })

  it('chat:emote에 target이 없으면 target 키를 싣지 않는다 (undefined 키 금지)', () => {
    const { port, deliver } = spyPort()
    const handler = createChatHandler(port)

    handler({ type: 'chat:emote', emote: '웃음' }, actor)

    expect(deliver).toHaveBeenCalledWith({ speaker: actor, channel: 'emote', text: '웃음' })
    const arg = deliver.mock.calls[0]?.[0]
    expect(Object.prototype.hasOwnProperty.call(arg, 'target')).toBe(false)
  })

  it('gate 위반 actor(level 미채움)로도 게이트 없이 deliver한다 (미강제 검증)', () => {
    const { port, deliver } = spyPort()
    const handler = createChatHandler(port)
    // broadcast는 gate.minLevel=20을 선언하지만 E3는 강제하지 않는다. level 미채움 actor로도 통과한다.
    const underLeveled: ActorContext = { accountId: 'acc-1', characterId: 'char-1', level: 1 }

    handler({ type: 'chat:message', channel: 'broadcast', text: '방송' }, underLeveled)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith({
      speaker: underLeveled,
      channel: 'broadcast',
      text: '방송',
    })
  })

  it('chat이 아닌 명령은 deliver하지 않고 undefined를 반환한다 (도달 불가 방어 갈래)', () => {
    const { port, deliver } = spyPort()
    const handler = createChatHandler(port)

    const result = handler({ type: 'debug:echo', text: '핑' }, actor)

    expect(result).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })
})
