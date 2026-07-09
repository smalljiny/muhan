import { describe, it, expect, vi } from 'vitest'
import {
  createSessionRegistry,
  type SessionBinding,
  type ScheduleGraceCallback,
  type TerminateCallback,
} from './sessionRegistry.js'
import { createConnectionContext, type ConnectionContext } from './connection.js'

// 순수 자료구조 + 주입 콜백이라 실소켓·실타이머 없이 spy만으로 결정적으로 검증한다(fake clock 불필요 —
// Story 3의 어떤 함수도 타이머를 발화하지 않는다). `terminate`/`scheduleGrace`/`clearTimeoutFn`이 모든
// 관측점을 제공한다. 각 테스트는 얕은 통과를 피하려 전이 전(pre-transition) 객체를 캡처해 검사한다.

/** 가짜 grace 타이머 핸들. clearTimeoutFn 대상 identity를 추적하려고 매번 새 핸들을 만든다. */
function fakeHandle(n: number): NodeJS.Timeout {
  return n as unknown as NodeJS.Timeout
}

/**
 * scheduleGrace spy — 항상 고정 핸들 반환. 타입 파라미터로 시그니처를 고정해 `.mock.calls[0][0]`이
 * 캐스트 없이 `SessionBinding`으로 타입된다(콜백 시그니처 변경이 테스트 컴파일 에러로 드러난다).
 */
function makeScheduleGrace(handle: NodeJS.Timeout) {
  return vi.fn<ScheduleGraceCallback>(() => handle)
}

describe('createSessionRegistry', () => {
  describe('register', () => {
    it('기존 엔트리가 없으면 terminate 없이 live 바인딩을 등록하고 ctx.boundCharacterId를 대입한다', () => {
      const registry = createSessionRegistry()
      const ctx = createConnectionContext()
      const terminate = vi.fn()

      const binding = registry.register('char-1', 'acc-1', ctx, terminate)

      expect(terminate).not.toHaveBeenCalled()
      expect(binding.characterId).toBe('char-1')
      expect(binding.accountId).toBe('acc-1')
      expect(binding.connection).toBe(ctx)
      expect(binding.link).toBe('live')
      expect(binding.graceTimer).toBeNull()
      expect(registry.get('char-1')).toBe(binding)
      expect(ctx.boundCharacterId).toBe('char-1')
    })

    it('기존 엔트리가 있으면 terminate를 정확히 1회 (existing, "evictedByNewLogin")로 호출한 뒤 fresh 바인딩을 set한다', () => {
      // Trap 1: terminate가 실제로 map을 지우도록 만들어 terminate→set 순서를 관측 가능하게 한다.
      // set이 먼저 실행됐다면 terminate.remove가 fresh 엔트리를 지워 get이 undefined가 된다.
      const registry = createSessionRegistry()
      const ctxOld = createConnectionContext()
      const terminate = vi.fn<TerminateCallback>((b) => registry.remove(b.characterId))

      const existing = registry.register('char-1', 'acc-1', ctxOld, vi.fn())

      const ctxNew = createConnectionContext()
      const fresh = registry.register('char-1', 'acc-2', ctxNew, terminate)

      expect(terminate).toHaveBeenCalledTimes(1)
      // identity: terminate가 캡처한 첫 인자는 옛 바인딩 객체 그 자체다.
      expect(terminate.mock.calls[0]?.[0]).toBe(existing)
      expect(terminate.mock.calls[0]?.[1]).toBe('evictedByNewLogin')
      // 순서 load-bearing: terminate가 remove로 지운 뒤 fresh가 set됐으므로 get은 fresh다(undefined 아님).
      expect(registry.get('char-1')).toBe(fresh)
      expect(fresh).not.toBe(existing)
      expect(ctxNew.boundCharacterId).toBe('char-1')
    })

    it('link-dead 기존 엔트리도 live·link-dead 무관하게 terminate로 종결한다', () => {
      const registry = createSessionRegistry()
      const ctx = createConnectionContext()
      const live = registry.register('char-1', 'acc-1', ctx, vi.fn())
      const dead = registry.markLinkDead(live, makeScheduleGrace(fakeHandle(1)))
      expect(dead).not.toBeNull()

      const terminate = vi.fn<TerminateCallback>()
      registry.register('char-1', 'acc-2', createConnectionContext(), terminate)

      expect(terminate).toHaveBeenCalledTimes(1)
      expect(terminate.mock.calls[0]?.[0]).toBe(dead)
    })
  })

  describe('markLinkDead', () => {
    it('필드 변이 없이 새 link-dead 객체로 교체하고 scheduleGrace가 그 새 객체를 캡처한다', () => {
      const registry = createSessionRegistry()
      const ctx = createConnectionContext()
      const live = registry.register('char-1', 'acc-1', ctx, vi.fn())
      const handle = fakeHandle(42)
      const scheduleGrace = makeScheduleGrace(handle)

      const dead = registry.markLinkDead(live, scheduleGrace)

      expect(dead).not.toBeNull()
      // immutability: 교체 후 객체는 이전 객체와 다른 identity다.
      expect(dead).not.toBe(live)
      // 이전 객체는 변이되지 않았다(여전히 live).
      expect(live.link).toBe('live')
      expect(live.graceTimer).toBeNull()
      // 새 객체 상태.
      expect(dead?.link).toBe('link-dead')
      expect(dead?.characterId).toBe('char-1')
      expect(dead?.accountId).toBe('acc-1')
      expect(dead?.connection).toBe(ctx)
      // scheduleGrace가 캡처한 객체는 map에 publish된 그 새 객체(dead)와 === 동일하다(identity, deep-equal 아님).
      const captured = scheduleGrace.mock.calls[0]?.[0]
      expect(captured).toBe(dead)
      expect(captured).not.toBe(live)
      // 반환된 타이머 핸들이 새 객체 슬롯에 채워졌다.
      expect(dead?.graceTimer).toBe(handle)
      // map은 새 객체로 갱신됐다.
      expect(registry.get('char-1')).toBe(dead)
    })

    it('identity 불일치(전이 전 객체 캡처)면 no-op으로 null을 반환하고 scheduleGrace를 부르지 않는다', () => {
      // pre-transition 객체(live)를 캡처한 뒤, live를 한 번 link-dead로 전이시켜 map 엔트리를 교체한다.
      // 그 다음 캡처해 둔 옛 live로 다시 markLinkDead를 발동하면 identity 불일치라 no-op이어야 한다.
      const registry = createSessionRegistry()
      const ctx = createConnectionContext()
      const live = registry.register('char-1', 'acc-1', ctx, vi.fn())
      const dead = registry.markLinkDead(live, makeScheduleGrace(fakeHandle(1)))

      const staleScheduleGrace = makeScheduleGrace(fakeHandle(2))
      const result = registry.markLinkDead(live, staleScheduleGrace)

      expect(result).toBeNull()
      expect(staleScheduleGrace).not.toHaveBeenCalled()
      // map 엔트리는 첫 전이 결과(dead)로 유지된다.
      expect(registry.get('char-1')).toBe(dead)
    })
  })

  describe('rebind', () => {
    it('정상 시 기존 graceTimer를 clear하고 새 live 객체로 교체하며 newCtx.boundCharacterId를 대입한다', () => {
      const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout
      const registry = createSessionRegistry({ clearTimeoutFn })
      const ctx = createConnectionContext()
      const live = registry.register('char-1', 'acc-1', ctx, vi.fn())
      const graceHandle = fakeHandle(77)
      const dead = registry.markLinkDead(live, makeScheduleGrace(graceHandle))
      expect(dead).not.toBeNull()

      const newCtx: ConnectionContext = createConnectionContext()
      const rebound = registry.rebind(dead as SessionBinding, newCtx)

      expect(rebound).not.toBeNull()
      // clear가 옛 grace 핸들을 정확히 대상으로 삼는다.
      expect(clearTimeoutFn).toHaveBeenCalledWith(graceHandle)
      // immutability: 교체 후 객체는 이전 link-dead 객체와 다른 identity다.
      expect(rebound).not.toBe(dead)
      expect(rebound?.link).toBe('live')
      expect(rebound?.graceTimer).toBeNull()
      expect(rebound?.connection).toBe(newCtx)
      expect(rebound?.characterId).toBe('char-1')
      expect(rebound?.accountId).toBe('acc-1')
      expect(registry.get('char-1')).toBe(rebound)
      expect(newCtx.boundCharacterId).toBe('char-1')
    })

    it('stale(현재 map 엔트리와 불일치) 바인딩이면 null을 반환하고 live 엔트리를 변경하지 않는다', () => {
      // 진짜 stale 바인딩: 첫 등록 객체(live)를 캡처한 뒤 같은 캐릭터로 재등록해 map을 fresh로 교체한다.
      // 캡처해 둔 옛 live로 rebind를 시도하면 identity 불일치라 null이어야 하고 fresh는 무변경이어야 한다.
      const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout
      const registry = createSessionRegistry({ clearTimeoutFn })
      const live = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
      const fresh = registry.register('char-1', 'acc-2', createConnectionContext(), vi.fn())

      const newCtx = createConnectionContext()
      const result = registry.rebind(live, newCtx)

      expect(result).toBeNull()
      expect(clearTimeoutFn).not.toHaveBeenCalled()
      // fresh live 엔트리는 그대로다.
      expect(registry.get('char-1')).toBe(fresh)
      expect(newCtx.boundCharacterId).toBeNull()
    })
  })

  describe('get / remove', () => {
    it('get은 등록된 바인딩을, 미등록이면 undefined를 반환한다', () => {
      const registry = createSessionRegistry()
      const binding = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
      expect(registry.get('char-1')).toBe(binding)
      expect(registry.get('char-2')).toBeUndefined()
    })

    it('remove는 엔트리를 제거한다', () => {
      const registry = createSessionRegistry()
      registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
      registry.remove('char-1')
      expect(registry.get('char-1')).toBeUndefined()
    })
  })

  describe('map 조작 throw-safety', () => {
    it('주입 콜백이 정상 반환할 때 register/markLinkDead/rebind는 throw하지 않는다', () => {
      const registry = createSessionRegistry({ clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout })
      expect(() => {
        const live = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
        const dead = registry.markLinkDead(live, makeScheduleGrace(fakeHandle(1)))
        registry.rebind(dead as SessionBinding, createConnectionContext())
        registry.register('char-1', 'acc-2', createConnectionContext(), vi.fn())
      }).not.toThrow()
    })
  })
})
