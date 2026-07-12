import type { SessionBinding, SessionRegistry, TerminateCallback } from './sessionRegistry.js'

/**
 * shutdown 세션 수렴 헬퍼 — 서버 주도 종료 플래그와, 등록된 모든 세션 바인딩을 일괄 종결하는 순수 단위.
 *
 * 실 배선(신호 핸들러 등록·호출 순서·플래그를 언제 세우고 언제 converge할지)은 index.ts가 소유한다.
 * 이 헬퍼는 그 배선 밖에서 단위 테스트 가능하도록, 상태(boolean 플래그)를 클로저에 캡슐화하고
 * (`createSessionRegistry`의 상태 캡슐화 관례 미러) registry.listBindings + 주입 resolveDisconnect만으로
 * 수렴한다 — 소켓·타이머·신호 전역에 의존하지 않는다.
 */

/** shutdown 수렴 핸들. 종료 플래그와 일괄 수렴을 노출한다. 상태는 클로저에 캡슐화한다. */
export interface ShutdownConverger {
  isShuttingDown(): boolean
  markShuttingDown(): void
  converge(): void
}

/** 수렴 팩토리 주입물 — 바인딩 스냅샷 소스(listBindings)와 단일 종결 함수(resolveDisconnect). */
export interface ShutdownConvergerDeps {
  readonly registry: Pick<SessionRegistry, 'listBindings'>
  readonly resolveDisconnect: TerminateCallback
  /**
   * 한 바인딩의 종결이 throw할 때 기록하는 콜백(미주입 시 조용히 격리). 한 바인딩 실패가 나머지 수렴을
   * 중단시키지 않도록 converge가 바인딩별로 catch한다(WorldClock.onTick 슬롯 격리 관례 미러). 격리가 없으면
   * 상위 종료 시퀀스(index.ts)의 후속 flush가 스킵돼 데이터 유실로 이어진다.
   */
  readonly logConvergeFailure?: (binding: SessionBinding, err: unknown) => void
}

/**
 * shutdown 수렴 핸들을 만든다. 플래그(`shuttingDown`)는 클로저에 캡슐화한다.
 */
export function createShutdownConverger(deps: ShutdownConvergerDeps): ShutdownConverger {
  let shuttingDown = false

  function isShuttingDown(): boolean {
    return shuttingDown
  }

  function markShuttingDown(): void {
    shuttingDown = true
  }

  /**
   * 등록된 모든 바인딩을 `resolveDisconnect(binding, 'shutdown')`로 일괄 종결한다.
   *
   * converge는 플래그와 무관하다 — 호출 순서(플래그 set 후 converge)는 index.ts 배선이 소유하며, 여기서는
   * 플래그를 검사하지 않고 항상 스냅샷을 수렴한다. listBindings는 라이브 뷰가 아닌 복사 스냅샷이라(sessionRegistry
   * 계약, Story 4), resolveDisconnect가 순회 중 index.remove를 호출해도 안전하다. resolveDisconnect의 identity
   * 가드·선-제거가 재진입/이중 종결을 막고, link-dead 바인딩은 graceTimer clear + 포트 1회 후 teardown no-op으로
   * 안전 종결된다.
   *
   * 바인딩별 격리: 각 resolveDisconnect 호출을 try/catch로 감싸 한 바인딩 종결 실패가 나머지 수렴을 중단시키지
   * 않게 한다(WorldClock.onTick 슬롯 격리 미러). 격리가 없으면 index.ts 종료 시퀀스의 후속 saveEngine.shutdown
   * flush가 통째로 스킵돼 잔여 dirty 상태가 유실된다(#56 결함 클래스 재발 방지).
   */
  function converge(): void {
    const bindings = deps.registry.listBindings()
    for (const binding of bindings) {
      try {
        deps.resolveDisconnect(binding, 'shutdown')
      } catch (err) {
        deps.logConvergeFailure?.(binding, err)
      }
    }
  }

  return { isShuttingDown, markShuttingDown, converge }
}
