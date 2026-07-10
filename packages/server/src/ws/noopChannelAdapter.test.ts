import { describe, it, expect, vi } from 'vitest'
import { createNoopChannelAdapter, type ChannelLogger } from './noopChannelAdapter.js'
import type { ActorContext } from './actorContext.js'

const speaker: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

describe('createNoopChannelAdapter', () => {
  it('deliver가 전달 사실(characterId·channel·target)만 구조 로깅한다', () => {
    // info fn을 캡처해 단언한다 — logger.info를 오브젝트에서 분리 참조하면 unbound-method 규칙을 트립한다.
    const info = vi.fn()
    const logger: ChannelLogger = { info }
    const adapter = createNoopChannelAdapter(logger)

    adapter.deliver({ speaker, channel: 'say', text: '안녕' })

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      { characterId: 'char-1', channel: 'say', target: undefined },
      expect.any(String),
    )
  })

  it('target이 있으면 로그 payload에 실어 전달한다', () => {
    const info = vi.fn()
    const logger: ChannelLogger = { info }
    const adapter = createNoopChannelAdapter(logger)

    adapter.deliver({ speaker, channel: 'emote', text: '인사', target: 'char-2' })

    expect(info).toHaveBeenCalledWith(
      { characterId: 'char-1', channel: 'emote', target: 'char-2' },
      expect.any(String),
    )
  })
})
