import { describe, it, expect, vi } from 'vitest'
import { createResolveDisconnect } from './resolveDisconnect.js'
import {
  createSessionRegistry,
  type DisconnectReason,
  type ScheduleGraceCallback,
  type SessionBinding,
} from './sessionRegistry.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import { createConnectionContext, type IdleTimer } from './connection.js'

// resolveDisconnect은 순수 종결 함수다 — 주입된 registry·port·teardown·clearTimeoutFn만으로 관측한다.
// §3.7 verify 규율: assertion이 semantic(포트 호출 횟수·throw 후 teardown·clearTimeout 핸들 identity)을
// 실제로 검사해야 한다. 커버리지%로 대체하지 않는다.

/** clearTimeoutFn·scheduleGrace 대상 identity 추적용 가짜 타이머 핸들. */
function fakeHandle(n: number): NodeJS.Timeout {
  return n as unknown as NodeJS.Timeout
}

/** scheduleGrace spy — 항상 고정 핸들 반환(타입 파라미터로 시그니처 고정). */
function makeScheduleGrace(handle: NodeJS.Timeout) {
  return vi.fn<ScheduleGraceCallback>(() => handle)
}

/** onSessionEnd를 스파이하는 포트. 기본은 정상 반환, 옵션으로 throw 주입. */
function makePort(impl?: () => void): SessionLifecyclePort & {
  onSessionEnd: ReturnType<typeof vi.fn>
} {
  return { onSessionEnd: vi.fn(impl) }
}

describe('createResolveDisconnect', () => {
  it('정상 경로: identity 가드 통과 → 선-제거 → graceTimer clear → 포트 1회 → teardown', () => {
    const registry = createSessionRegistry()
    const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout
    const port = makePort()
    const teardown = vi.fn()
    const resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn,
    })

    const ctx = createConnectionContext()
    const live = registry.register('char-1', 'acc-1', ctx, vi.fn())
    const graceHandle = fakeHandle(42)
    const dead = registry.markLinkDead(live, makeScheduleGrace(graceHandle))
    expect(dead).not.toBeNull()

    resolve(dead!, 'graceExpired')

    // 선-제거: 포트 호출 전에 map에서 지워졌다.
    expect(registry.get('char-1')).toBeUndefined()
    // graceTimer가 이 함수의 주입 clearTimeoutFn으로 정확히 정리됐다(누수 방지, 핸들 identity).
    expect(clearTimeoutFn).toHaveBeenCalledWith(graceHandle)
    // 포트 정확히 1회 + 도메인 컨텍스트.
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(port.onSessionEnd).toHaveBeenCalledWith({
      accountId: 'acc-1',
      characterId: 'char-1',
      reason: 'graceExpired',
    })
    // transport cleanup 콜백이 종결 대상 바인딩으로 1회 호출됐다.
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledWith(dead)
  })

  it('멱등성: 같은 바인딩에 두 번 호출해도 포트·teardown은 정확히 1회(2번째는 선-제거로 identity 가드에 걸려 no-op)', () => {
    // grace 콜백·close 리스너가 겹쳐 큐잉되는 상황을 재현한다 — 동일 바인딩에 두 번 종결을 시도한다.
    const registry = createSessionRegistry()
    const port = makePort()
    const teardown = vi.fn()
    const resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })

    const binding = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())

    resolve(binding, 'graceExpired')
    resolve(binding, 'graceExpired') // 두 번째: 이미 제거돼 get !== binding → no-op

    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(registry.get('char-1')).toBeUndefined()
  })

  it('재진입 차단: teardown이 같은 바인딩으로 resolve를 재호출해도 포트는 정확히 1회(선-제거→teardown 순서 검증)', () => {
    // 실 경로 모델: teardown → socket.close() → close 리스너 → resolveDisconnect 재발화. 재진입이 teardown
    // (step 5) '안에서' 트리거되므로, 이 테스트가 판별하는 것은 선-제거가 teardown '앞'이라는 순서다 — 제거가
    // teardown 뒤였다면 재진입이 가드를 통과해 포트가 2회 호출된다(순차 이중 호출은 두 순서 모두 통과하므로
    // 구별 못 함). 구현은 여기서 한 걸음 더 나아가 제거를 포트 '앞'에도 둔다 — onSessionEnd 안에서의 동기
    // 재진입(현재 미모델 경로)까지 막는 더 강한 방어이며, 그 강한 순서는 이 테스트가 별도로 pin하지는 않는다.
    const registry = createSessionRegistry()
    const port = makePort()
    let entered = 0
    // 순환 참조: teardown이 resolve를 캡처하고 resolve의 deps가 teardown을 담는다. 플레이스홀더로 초기화한 뒤
    // 실제 종결 함수로 재대입해 forward reference를 푼다.
    let resolve: (binding: SessionBinding, reason: DisconnectReason) => void = () => {}
    const teardown = vi.fn((b: SessionBinding) => {
      // teardown 실행 중(=포트 이후) 정확히 1회 재진입을 트리거한다.
      if (++entered === 1) resolve(b, 'graceExpired')
    })
    resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })

    const binding = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
    resolve(binding, 'graceExpired')

    // 선-제거(teardown 앞)면 재진입의 identity 가드가 실패해 포트는 1회. 제거가 teardown 뒤였다면 2회가 된다.
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    // 재진입은 가드에서 no-op이므로 teardown도 1회에 그친다.
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(registry.get('char-1')).toBeUndefined()
  })

  it('포트 throw: catch·로깅 후에도 teardown·레지스트리 제거가 정상 완료된다', () => {
    // 포트가 실제로 throw하도록 만들어 throw가 teardown을 막지 않음을 검증한다(선-제거·teardown이 try 밖).
    const registry = createSessionRegistry()
    const port = makePort(() => {
      throw new Error('영속화 실패')
    })
    const teardown = vi.fn()
    const logPortFailure = vi.fn()
    const resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure,
      clearTimeoutFn: vi.fn(),
    })

    const binding = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())

    expect(() => resolve(binding, 'idleTimeout')).not.toThrow()
    expect(logPortFailure).toHaveBeenCalledTimes(1)
    // throw에도 불구하고 종결이 완주했다.
    expect(registry.get('char-1')).toBeUndefined()
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('stale(identity 불일치) 바인딩: no-op — 포트 미호출·레지스트리 무변경·teardown 미호출', () => {
    // 진짜 stale: 첫 등록 객체를 캡처한 뒤 같은 캐릭터로 재등록해 map 엔트리를 fresh로 교체한다.
    const registry = createSessionRegistry()
    const port = makePort()
    const teardown = vi.fn()
    const resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })

    const stale = registry.register('char-1', 'acc-1', createConnectionContext(), vi.fn())
    const fresh = registry.register('char-1', 'acc-2', createConnectionContext(), vi.fn())

    resolve(stale, 'graceExpired')

    expect(port.onSessionEnd).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
    // map 엔트리는 fresh 그대로다.
    expect(registry.get('char-1')).toBe(fresh)
  })

  it('idle 타이머가 있으면 clear한다(연결의 idle 슬롯 정리)', () => {
    const registry = createSessionRegistry()
    const idle: IdleTimer & { clear: ReturnType<typeof vi.fn> } = {
      arm: vi.fn(),
      clear: vi.fn(),
    }
    const ctx = createConnectionContext()
    ctx.idle = idle
    const resolve = createResolveDisconnect({
      registry,
      port: makePort(),
      teardown: vi.fn(),
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })

    const binding = registry.register('char-1', 'acc-1', ctx, vi.fn())
    resolve(binding, 'idleTimeout')

    expect(idle.clear).toHaveBeenCalledTimes(1)
  })

  it('account 불일치 link-dead 엔트리를 register 경로로 종결: 포트 1회 + graceTimer clear로 누수 없음', () => {
    // §3.7 immutable-boundary case 2: resolveDisconnect를 register의 terminate로 배선하고, 같은 캐릭터
    // 다른 account로 재로그인해 link-dead 엔트리를 register 경로(evict-old)로 종결시킨다.
    const registry = createSessionRegistry()
    const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout
    const port = makePort()
    const teardown = vi.fn()
    const resolve = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn,
    })

    const live = registry.register('char-1', 'acc-1', createConnectionContext(), resolve)
    const graceHandle = fakeHandle(77)
    const dead = registry.markLinkDead(live, makeScheduleGrace(graceHandle))
    expect(dead).not.toBeNull()

    // 다른 account로 재로그인 → register가 기존 link-dead 엔트리를 resolve로 종결한다.
    const fresh = registry.register('char-1', 'acc-2', createConnectionContext(), resolve)

    // 포트는 옛 엔트리 종결로 정확히 1회, 사유는 evictedByNewLogin.
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(port.onSessionEnd).toHaveBeenCalledWith({
      accountId: 'acc-1',
      characterId: 'char-1',
      reason: 'evictedByNewLogin',
    })
    // graceTimer가 resolve의 주입 clearTimeoutFn으로 정리됐다(핸들 identity — 누수 방지).
    expect(clearTimeoutFn).toHaveBeenCalledWith(graceHandle)
    // fresh 엔트리가 map을 차지한다(종결이 fresh를 지우지 않았다).
    expect(registry.get('char-1')).toBe(fresh)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledWith(dead)
  })
})
