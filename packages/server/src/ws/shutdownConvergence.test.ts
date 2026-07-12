import { describe, it, expect, vi } from 'vitest'
import { createShutdownConverger } from './shutdownConvergence.js'
import { createResolveDisconnect } from './resolveDisconnect.js'
import {
  createSessionRegistry,
  type ScheduleGraceCallback,
  type SessionBinding,
  type TerminateCallback,
} from './sessionRegistry.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import { createConnectionContext } from './connection.js'

// shutdownConvergence는 순수 단위다 — 주입된 registry.listBindings + resolveDisconnect만으로 관측한다.
// 배선(호출 순서·index.ts 소유)은 여기서 테스트하지 않고, converge가 스냅샷 전체를 각각
// resolveDisconnect(binding, 'shutdown')로 수렴하는 계약만 검증한다.

/** 가짜 grace 타이머 핸들 — 실 setTimeout을 남기지 않으려고 마킹만 한다. */
function fakeHandle(n: number): NodeJS.Timeout {
  return n as unknown as NodeJS.Timeout
}

/** scheduleGrace spy — 항상 고정 핸들 반환(시그니처 고정). */
function makeScheduleGrace(handle: NodeJS.Timeout) {
  return vi.fn<ScheduleGraceCallback>(() => handle)
}

/** onSessionEnd를 스파이하는 no-op 포트. */
function makePort(): SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } {
  return { onSessionEnd: vi.fn() }
}

/** listBindings가 준비된 스냅샷을 반환하는 stub registry(converge 순수 단위 검증용). */
function stubRegistry(snapshot: readonly SessionBinding[]): {
  listBindings: () => readonly SessionBinding[]
} {
  return { listBindings: () => snapshot }
}

/** 최소 SessionBinding 팩토리 — link 상태만 달리해 혼재 스냅샷을 구성한다. */
function makeBinding(characterId: string, link: 'live' | 'link-dead'): SessionBinding {
  return {
    characterId,
    accountId: `acc-${characterId}`,
    connection: createConnectionContext(),
    link,
    graceTimer: link === 'link-dead' ? fakeHandle(1) : null,
  }
}

describe('createShutdownConverger', () => {
  it('isShuttingDown()이 markShuttingDown() 전 false, 후 true', () => {
    const converger = createShutdownConverger({
      registry: stubRegistry([]),
      resolveDisconnect: vi.fn(),
    })

    expect(converger.isShuttingDown()).toBe(false)
    converger.markShuttingDown()
    expect(converger.isShuttingDown()).toBe(true)
  })

  it('converge()가 스냅샷의 각 바인딩에 resolveDisconnect(binding, "shutdown")을 정확히 1회 호출한다(live·link-dead 혼재)', () => {
    const live1 = makeBinding('c1', 'live')
    const dead1 = makeBinding('c2', 'link-dead')
    const live2 = makeBinding('c3', 'live')
    const dead2 = makeBinding('c4', 'link-dead')
    const snapshot = [live1, dead1, live2, dead2]

    const resolveDisconnect = vi.fn<TerminateCallback>()
    const converger = createShutdownConverger({
      registry: stubRegistry(snapshot),
      resolveDisconnect,
    })

    converger.converge()

    // 각 바인딩당 정확히 1회, 스냅샷 크기만큼 호출.
    expect(resolveDisconnect).toHaveBeenCalledTimes(snapshot.length)
    // 모든 호출의 reason이 'shutdown'이고, 바인딩이 identity로 전달됐다.
    for (const binding of snapshot) {
      expect(resolveDisconnect).toHaveBeenCalledWith(binding, 'shutdown')
    }
    // 실제 인자 identity를 명시 확인(deep-equal이 아닌 참조 동일성 toBe).
    const passedBindings = resolveDisconnect.mock.calls.map((call) => call[0])
    expect(passedBindings).toHaveLength(snapshot.length)
    passedBindings.forEach((passed, i) => {
      expect(passed).toBe(snapshot[i])
    })
    const reasons = resolveDisconnect.mock.calls.map((call) => call[1])
    expect(reasons).toEqual(['shutdown', 'shutdown', 'shutdown', 'shutdown'])
  })

  it('통합: 실제 registry·resolveDisconnect 배선에서 converge 후 레지스트리가 비고 각 바인딩이 정확히 1회 포트 종결된다', () => {
    const registry = createSessionRegistry()
    const port = makePort()
    const teardown = vi.fn()
    const resolveDisconnect = createResolveDisconnect({
      registry,
      port,
      teardown,
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })

    // live 2개 + link-dead 2개 혼재 등록.
    registry.register('c1', 'acc-1', createConnectionContext(), resolveDisconnect)
    registry.register('c2', 'acc-2', createConnectionContext(), resolveDisconnect)
    const live3 = registry.register('c3', 'acc-3', createConnectionContext(), resolveDisconnect)
    const live4 = registry.register('c4', 'acc-4', createConnectionContext(), resolveDisconnect)
    expect(registry.markLinkDead(live3, makeScheduleGrace(fakeHandle(3)))).not.toBeNull()
    expect(registry.markLinkDead(live4, makeScheduleGrace(fakeHandle(4)))).not.toBeNull()
    expect(registry.listBindings()).toHaveLength(4)

    const converger = createShutdownConverger({ registry, resolveDisconnect })
    converger.converge()

    // 종결 후 레지스트리가 빈다.
    expect(registry.listBindings()).toEqual([])
    // 각 바인딩이 정확히 1회 포트 종결됐다(4개 → 4회, reason 모두 shutdown).
    expect(port.onSessionEnd).toHaveBeenCalledTimes(4)
    for (const characterId of ['c1', 'c2', 'c3', 'c4']) {
      expect(port.onSessionEnd).toHaveBeenCalledWith(
        expect.objectContaining({ characterId, reason: 'shutdown' }),
      )
    }
    expect(teardown).toHaveBeenCalledTimes(4)
  })

  it('한 바인딩 종결이 throw해도 격리·로깅하고 나머지 바인딩을 계속 수렴한다', () => {
    const b1 = makeBinding('c1', 'live')
    const boom = makeBinding('c2', 'link-dead')
    const b3 = makeBinding('c3', 'live')
    // throw 바인딩을 가운데 두어 순회 중단이 없음을 증명한다(순서 load-bearing).
    const snapshot = [b1, boom, b3]

    const resolveDisconnect = vi.fn<TerminateCallback>((binding) => {
      if (binding === boom) throw new Error('teardown 실패')
    })
    const logConvergeFailure = vi.fn()
    const converger = createShutdownConverger({
      registry: stubRegistry(snapshot),
      resolveDisconnect,
      logConvergeFailure,
    })

    // converge 자체는 throw하지 않는다(상위 종료 시퀀스의 후속 flush를 막지 않도록).
    expect(() => converger.converge()).not.toThrow()

    // 모든 바인딩에 대해 호출이 시도됐다(throw 이후 b3까지 계속).
    expect(resolveDisconnect).toHaveBeenCalledTimes(3)
    expect(resolveDisconnect).toHaveBeenCalledWith(b3, 'shutdown')
    // 실패한 바인딩만 정확히 1회 로깅됐다.
    expect(logConvergeFailure).toHaveBeenCalledTimes(1)
    expect(logConvergeFailure).toHaveBeenCalledWith(boom, expect.any(Error))
  })

  it('logConvergeFailure 미주입 시에도 throw를 조용히 격리하고 나머지를 계속 수렴한다', () => {
    const boom = makeBinding('c1', 'live')
    const ok = makeBinding('c2', 'live')
    const resolveDisconnect = vi.fn<TerminateCallback>((binding) => {
      if (binding === boom) throw new Error('teardown 실패')
    })
    const converger = createShutdownConverger({
      registry: stubRegistry([boom, ok]),
      resolveDisconnect,
    })

    expect(() => converger.converge()).not.toThrow()
    expect(resolveDisconnect).toHaveBeenCalledWith(ok, 'shutdown')
  })

  it('2차 converge()가 1차 스냅샷 이후 등록된 late 바인딩을 종결한다(늦은 등록 레이스 방어)', () => {
    const registry = createSessionRegistry()
    const port = makePort()
    const resolveDisconnect = createResolveDisconnect({
      registry,
      port,
      teardown: vi.fn(),
      logPortFailure: vi.fn(),
      clearTimeoutFn: vi.fn(),
    })
    registry.register('c1', 'acc-1', createConnectionContext(), resolveDisconnect)
    const converger = createShutdownConverger({ registry, resolveDisconnect })

    // 1차 수렴: c1 종결, 레지스트리 빔.
    converger.converge()
    expect(registry.listBindings()).toEqual([])
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)

    // 1차 수렴 이후 late 바인딩 등록(app.close 대기 중 enterWorld 레이스 시뮬레이션).
    registry.register('c2', 'acc-2', createConnectionContext(), resolveDisconnect)
    expect(registry.listBindings()).toHaveLength(1)

    // 2차 수렴: late 바인딩 c2 종결. converge가 idempotent·재호출 안전임을 증명한다(index.ts 2차 수렴 근거).
    converger.converge()
    expect(registry.listBindings()).toEqual([])
    expect(port.onSessionEnd).toHaveBeenCalledTimes(2)
    expect(port.onSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: 'c2', reason: 'shutdown' }),
    )
  })

  it('빈 레지스트리에서 converge()는 no-op(resolveDisconnect 미호출)', () => {
    const resolveDisconnect = vi.fn<TerminateCallback>()
    const converger = createShutdownConverger({
      registry: stubRegistry([]),
      resolveDisconnect,
    })

    converger.converge()

    expect(resolveDisconnect).not.toHaveBeenCalled()
  })
})
