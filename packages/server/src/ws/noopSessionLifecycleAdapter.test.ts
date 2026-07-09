import { describe, it, expect, vi } from 'vitest'
import { createNoopSessionLifecycleAdapter } from './noopSessionLifecycleAdapter.js'

// no-op 어댑터는 실 저장 없이 로깅만 한다(E4/E5가 실 영속화 구현). onSessionEnd 본문을 직접 실행해
// 커버리지·semantic을 함께 검증한다(resolveDisconnect 테스트는 vi.fn() 포트를 써 실 어댑터 본문을 타지 않는다).

describe('createNoopSessionLifecycleAdapter', () => {
  it('onSessionEnd는 accountId·characterId·reason을 로깅하고 I/O 없이 throw하지 않는다', () => {
    const logger = { info: vi.fn() }
    const adapter = createNoopSessionLifecycleAdapter(logger)

    expect(() =>
      adapter.onSessionEnd({ accountId: 'acc-1', characterId: 'char-1', reason: 'graceExpired' }),
    ).not.toThrow()

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      accountId: 'acc-1',
      characterId: 'char-1',
      reason: 'graceExpired',
    })
  })
})
