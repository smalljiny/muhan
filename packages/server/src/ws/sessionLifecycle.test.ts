import { describe, it, expect, vi } from 'vitest'
import { createSessionLifecycle } from './sessionLifecycle.js'
import { createSessionRegistry, type SessionRegistry } from './sessionRegistry.js'
import { createResolveDisconnect } from './resolveDisconnect.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import { createConnectionContext, type ConnectionContext } from './connection.js'
import { ConnectionState } from './fsm/sessionFsm.js'

// createSessionLifecycle는 소켓·emit 없이 registry·resolveDisconnect·주입 setTimeoutFn만으로 동작하는
// 셸 조율 단위다. 실 registry + 실 resolveDisconnect + 스파이 포트 + fake setTimeoutFn을 배선해
// 전체 경로를 결정적으로 관측한다(§3.7 verify 규율: 포트 호출 횟수·바인딩 identity·grace 콜백 identity 검사).

/** 가짜 grace 타이머 핸들. */
function fakeHandle(n: number): NodeJS.Timeout {
  return n as unknown as NodeJS.Timeout
}

/** onSessionEnd를 스파이하는 포트. */
function makePort(): SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } {
  return { onSessionEnd: vi.fn() }
}

/**
 * lifecycle 테스트 하네스 — 실 registry + 실 resolveDisconnect + 스파이 포트 + fake setTimeoutFn.
 * grace 콜백을 캡처해 fake clock으로 발화할 수 있게 한다(만료 시점을 테스트가 제어).
 */
function makeHarness(graceMs = 30000): {
  registry: SessionRegistry
  port: SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> }
  teardown: ReturnType<typeof vi.fn>
  lifecycle: ReturnType<typeof createSessionLifecycle>
  setTimeoutFn: ReturnType<typeof vi.fn>
  fireGrace(): void
  graceMs: number
} {
  const registry = createSessionRegistry({ clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout })
  const port = makePort()
  const teardown = vi.fn()
  const resolveDisconnect = createResolveDisconnect({
    registry,
    port,
    teardown,
    logPortFailure: vi.fn(),
    clearTimeoutFn: vi.fn(),
  })

  // fake setTimeoutFn — grace 콜백과 지연값을 캡처한다(fake clock).
  let graceCb: (() => void) | null = null
  const setTimeoutFn = vi.fn((cb: () => void) => {
    graceCb = cb
    return fakeHandle(1)
  })

  const lifecycle = createSessionLifecycle({
    registry,
    resolveDisconnect,
    graceMs: () => graceMs,
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
  })

  return {
    registry,
    port,
    teardown,
    lifecycle,
    setTimeoutFn,
    graceMs,
    fireGrace() {
      if (graceCb === null) throw new Error('grace 콜백이 스케줄되지 않았다')
      graceCb()
    },
  }
}

/** command 상태로 진입한 것처럼 보이는 ctx를 만든다(FSM enterState가 대입하는 state를 흉내낸다). */
function commandCtx(): ConnectionContext {
  const ctx = createConnectionContext()
  ctx.state = ConnectionState.command
  return ctx
}

describe('createSessionLifecycle', () => {
  describe('enterWorld', () => {
    it('신규 캐릭터는 register 경로로 entered이고 레지스트리에 live 바인딩이 등록된다', () => {
      const h = makeHarness()
      const ctx = commandCtx()

      const outcome = h.lifecycle.enterWorld(ctx, 'acc-1', 'char-1')

      expect(outcome).toBe('entered')
      const binding = h.registry.get('char-1')
      expect(binding?.link).toBe('live')
      expect(binding?.connection).toBe(ctx)
      expect(binding?.accountId).toBe('acc-1')
      expect(ctx.boundCharacterId).toBe('char-1')
      // 신규 등록이라 포트 종결이 없다.
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('같은 캐릭터 live 재로그인은 기존 바인딩을 evictedByNewLogin으로 종결(포트 1회)한 뒤 fresh 바인딩을 보유한다', () => {
      const h = makeHarness()
      const ctxOld = commandCtx()
      h.lifecycle.enterWorld(ctxOld, 'acc-1', 'char-1')
      const oldBinding = h.registry.get('char-1')

      const ctxNew = commandCtx()
      const outcome = h.lifecycle.enterWorld(ctxNew, 'acc-1', 'char-1')

      expect(outcome).toBe('entered')
      // (a) 기존 바인딩이 evictedByNewLogin으로 종결돼 포트가 정확히 1회 호출됐다.
      expect(h.port.onSessionEnd).toHaveBeenCalledTimes(1)
      expect(h.port.onSessionEnd).toHaveBeenCalledWith({
        accountId: 'acc-1',
        characterId: 'char-1',
        reason: 'evictedByNewLogin',
      })
      // (b) 종결 후 레지스트리는 fresh 바인딩을 보유한다(terminate→set 순서가 fresh를 지우지 않았다).
      const fresh = h.registry.get('char-1')
      expect(fresh).not.toBe(oldBinding)
      expect(fresh?.connection).toBe(ctxNew)
      expect(fresh?.link).toBe('live')
      // 옛 바인딩 teardown(옛 소켓 종결)이 1회 일어났다.
      expect(h.teardown).toHaveBeenCalledTimes(1)
      expect(h.teardown).toHaveBeenCalledWith(oldBinding)
    })

    it('link-dead 같은 account 재접속은 rebind되어 resumed이고 새 ctx를 가리키는 live 바인딩이 된다', () => {
      const h = makeHarness()
      const ctxOld = commandCtx()
      h.lifecycle.enterWorld(ctxOld, 'acc-1', 'char-1')
      // drop → link-dead.
      h.lifecycle.handleClose(ctxOld)
      const deadBinding = h.registry.get('char-1')
      expect(deadBinding?.link).toBe('link-dead')

      const ctxNew = commandCtx()
      const outcome = h.lifecycle.enterWorld(ctxNew, 'acc-1', 'char-1')

      expect(outcome).toBe('resumed')
      const rebound = h.registry.get('char-1')
      expect(rebound).not.toBe(deadBinding)
      expect(rebound?.link).toBe('live')
      expect(rebound?.connection).toBe(ctxNew)
      // rebind는 종결이 아니므로 포트를 호출하지 않는다.
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('link-dead지만 account가 다르면 rebind하지 않고 register 경로(evict)로 종결 후 재등록한다', () => {
      const h = makeHarness()
      const ctxOld = commandCtx()
      h.lifecycle.enterWorld(ctxOld, 'acc-1', 'char-1')
      h.lifecycle.handleClose(ctxOld) // link-dead

      const ctxNew = commandCtx()
      const outcome = h.lifecycle.enterWorld(ctxNew, 'acc-2', 'char-1')

      expect(outcome).toBe('entered')
      // account 불일치라 rebind에서 빠지고 register가 옛 link-dead 엔트리를 종결(포트 1회).
      expect(h.port.onSessionEnd).toHaveBeenCalledTimes(1)
      expect(h.port.onSessionEnd).toHaveBeenCalledWith({
        accountId: 'acc-1',
        characterId: 'char-1',
        reason: 'evictedByNewLogin',
      })
      expect(h.registry.get('char-1')?.accountId).toBe('acc-2')
    })
  })

  describe('handleClose', () => {
    it('command + 등록 + identity 일치면 markLinkDead로 grace 동안 바인딩을 유지하고 grace를 env값으로 스케줄한다', () => {
      const h = makeHarness(7777)
      const ctx = commandCtx()
      h.lifecycle.enterWorld(ctx, 'acc-1', 'char-1')

      h.lifecycle.handleClose(ctx)

      const binding = h.registry.get('char-1')
      expect(binding?.link).toBe('link-dead')
      // grace 타이머가 주입 setTimeoutFn으로 env graceMs를 지연값으로 스케줄됐다(하드코딩 없음).
      expect(h.setTimeoutFn).toHaveBeenCalledTimes(1)
      expect(h.setTimeoutFn.mock.calls[0]?.[1]).toBe(7777)
      // 아직 만료 전이라 포트 미호출.
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('grace 만료(fake clock) 시 resolveDisconnect(graceExpired)가 실행되고 포트가 1회 호출된다', () => {
      const h = makeHarness()
      const ctx = commandCtx()
      h.lifecycle.enterWorld(ctx, 'acc-1', 'char-1')
      h.lifecycle.handleClose(ctx)

      h.fireGrace()

      expect(h.port.onSessionEnd).toHaveBeenCalledTimes(1)
      expect(h.port.onSessionEnd).toHaveBeenCalledWith({
        accountId: 'acc-1',
        characterId: 'char-1',
        reason: 'graceExpired',
      })
      expect(h.registry.get('char-1')).toBeUndefined()
    })

    it('rebind가 바인딩을 교체한 뒤 옛 grace 콜백이 발화하면 identity 불일치로 no-op이다', () => {
      const h = makeHarness()
      const ctxOld = commandCtx()
      h.lifecycle.enterWorld(ctxOld, 'acc-1', 'char-1')
      h.lifecycle.handleClose(ctxOld) // link-dead + grace 콜백 캡처

      // grace 내 재접속 → rebind가 바인딩을 새 객체로 교체한다.
      const ctxNew = commandCtx()
      expect(h.lifecycle.enterWorld(ctxNew, 'acc-1', 'char-1')).toBe('resumed')

      // 이제 옛 grace 콜백이 발화해도 캡처한 옛 deadBinding이 map 엔트리와 불일치라 종결하지 않는다.
      h.fireGrace()

      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
      // 재바인딩된 live 엔트리는 그대로 유지된다.
      expect(h.registry.get('char-1')?.link).toBe('live')
      expect(h.registry.get('char-1')?.connection).toBe(ctxNew)
    })

    it('characterSelect 상태(미등록)의 close는 markLinkDead·grace 스케줄·포트 호출을 하지 않는다', () => {
      const h = makeHarness()
      const ctx = createConnectionContext() // state 기본값 characterSelect, 미등록
      ctx.state = ConnectionState.characterSelect

      h.lifecycle.handleClose(ctx)

      expect(h.setTimeoutFn).not.toHaveBeenCalled()
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('create 상태(미등록)의 close도 markLinkDead·grace 스케줄·포트 호출을 하지 않는다', () => {
      // §3.4: 월드 미진입 상태(characterSelect·create)는 레지스트리에 없어 도메인 종결 대상이 아니다.
      const h = makeHarness()
      const ctx = createConnectionContext()
      ctx.state = ConnectionState.create

      h.lifecycle.handleClose(ctx)

      expect(h.setTimeoutFn).not.toHaveBeenCalled()
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('stale 소켓 close(binding.connection !== thisCtx)는 markLinkDead하지 않는다 (서버 주도 종료 후 옛 소켓)', () => {
      const h = makeHarness()
      const ctxLive = commandCtx()
      h.lifecycle.enterWorld(ctxLive, 'acc-1', 'char-1')

      // 옛 소켓의 ctx: command 상태 + 같은 characterId를 boundCharacterId로 갖지만, 현재 map 엔트리의
      // connection은 ctxLive다. 옛 ctx의 close가 새 세션을 markLinkDead하면 안 된다.
      const ctxStale = commandCtx()
      ctxStale.boundCharacterId = 'char-1'

      h.lifecycle.handleClose(ctxStale)

      // 현재 바인딩은 여전히 live(옛 소켓 close가 건드리지 못했다).
      expect(h.registry.get('char-1')?.link).toBe('live')
      expect(h.registry.get('char-1')?.connection).toBe(ctxLive)
      expect(h.setTimeoutFn).not.toHaveBeenCalled()
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })

    it('boundCharacterId가 null이면 (월드 미진입) no-op이다', () => {
      const h = makeHarness()
      const ctx = commandCtx() // command 상태지만 boundCharacterId 미대입
      expect(ctx.boundCharacterId).toBeNull()

      h.lifecycle.handleClose(ctx)

      expect(h.setTimeoutFn).not.toHaveBeenCalled()
      expect(h.port.onSessionEnd).not.toHaveBeenCalled()
    })
  })

  describe('동시 재접속 경합 (§3.5 — 마지막 승리)', () => {
    it('두 소켓이 같은 link-dead 캐릭터로 재접속하면 마지막이 이기고 선행이 evictedByNewLogin으로 종결된다', () => {
      const h = makeHarness()
      const ctxOrig = commandCtx()
      h.lifecycle.enterWorld(ctxOrig, 'acc-1', 'char-1')
      h.lifecycle.handleClose(ctxOrig) // link-dead

      // 첫 재접속 B: link-dead를 봐서 rebind(resumed) → map을 bindingB로 교체.
      const ctxB = commandCtx()
      expect(h.lifecycle.enterWorld(ctxB, 'acc-1', 'char-1')).toBe('resumed')
      const bindingB = h.registry.get('char-1')

      // 둘째 재접속 C: 직렬 실행이라 이제 live(bindingB)를 본다 → register 경로 → evict(B).
      const ctxC = commandCtx()
      expect(h.lifecycle.enterWorld(ctxC, 'acc-1', 'char-1')).toBe('entered')

      // 선행 B가 evictedByNewLogin으로 종결(포트 1회).
      expect(h.port.onSessionEnd).toHaveBeenCalledTimes(1)
      expect(h.port.onSessionEnd).toHaveBeenCalledWith({
        accountId: 'acc-1',
        characterId: 'char-1',
        reason: 'evictedByNewLogin',
      })
      expect(h.teardown).toHaveBeenCalledWith(bindingB)
      // 마지막 C가 map을 차지한다.
      expect(h.registry.get('char-1')?.connection).toBe(ctxC)
    })
  })
})
