import type {
  DisconnectReason,
  SessionBinding,
  SessionRegistry,
  TerminateCallback,
} from './sessionRegistry.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'

/**
 * 등록된 세션 바인딩의 단일 종결 함수 — 모든 종결 경로(register evict-old·grace 만료·idle 종료·close)가
 * 이 한 지점으로 수렴한다. resolveDisconnect의 유일한 목적은 종결을 **정확히 1회** 실행하는 것이다.
 *
 * 순서가 load-bearing이다:
 *   (1) identity 가드 — `registry.get(characterId) === binding`일 때만 진행(stale·이미 종결된 옛 객체는 no-op).
 *   (2) 선-제거 — 포트 호출·teardown '전에' map에서 지운다. 재진입/중복 큐잉(grace 콜백·close 리스너가 겹쳐
 *       발화)을 차단하는 핵심이다. 두 번째 진입은 (1)에서 identity 불일치로 걸러진다.
 *   (3) 타이머 clear — graceTimer(link-dead 슬롯)와 연결의 idle 타이머를 정리해 누수를 막는다.
 *   (4) 포트 1회 — try로 감싸 실패해도 teardown을 막지 않는다(로깅 후 계속).
 *   (5) transport cleanup — 주입 콜백(cleanupConnection + socket.close)을 try '밖'에서 호출해, 포트가
 *       throw해도 반드시 실행되게 한다.
 *
 * 순수 조율 함수다 — registry·port·teardown·clearTimeoutFn을 주입받아 소켓·타이머 전역에 의존하지 않는다.
 */

/** resolveDisconnect 팩토리 주입물. teardown은 transport 정리(cleanupConnection+close)를 감싼 콜백이다. */
export interface ResolveDisconnectDeps {
  readonly registry: SessionRegistry
  readonly port: SessionLifecyclePort
  /** transport 정리 콜백 — 종결 대상 바인딩을 받아 cleanupConnection + socket.close를 수행한다. */
  readonly teardown: (binding: SessionBinding) => void
  /** 포트 onSessionEnd 실패를 기록하는 콜백. teardown을 막지 않도록 catch 경로에서만 호출된다. */
  readonly logPortFailure: (err: unknown) => void
  /** graceTimer 해제용 clear. 미주입 시 전역 clearTimeout(sessionRegistry.ts 관례 미러). */
  readonly clearTimeoutFn?: typeof clearTimeout
}

/**
 * 종결 함수를 만든다. 반환 시그니처 `(binding, reason) => void`는 SessionRegistry의 TerminateCallback과
 * 호환되므로 `register`의 terminate 인자로 그대로 배선된다(evict-old 경로). grace·idle·close 경로도 같은
 * 함수를 각자의 사유로 호출한다.
 */
export function createResolveDisconnect(deps: ResolveDisconnectDeps): TerminateCallback {
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout

  return (binding: SessionBinding, reason: DisconnectReason): void => {
    // (1) identity 가드 — 현재 map 엔트리와 동일할 때만 진행한다.
    if (deps.registry.get(binding.characterId) !== binding) return

    // (2) 선-제거 — 포트·teardown 전에 지워 재진입/중복 큐잉을 차단한다(순서 load-bearing).
    deps.registry.remove(binding.characterId)

    // (3) 타이머 clear — link-dead grace 슬롯 + 연결 idle 타이머 정리(누수 방지).
    if (binding.graceTimer !== null) clearTimeoutFn(binding.graceTimer)
    binding.connection.idle?.clear()

    // (4) 포트 1회 — 실패해도 teardown을 막지 않는다.
    try {
      deps.port.onSessionEnd({
        accountId: binding.accountId,
        characterId: binding.characterId,
        reason,
      })
    } catch (err) {
      deps.logPortFailure(err)
    }

    // (5) transport cleanup — try 밖이라 포트 throw와 무관하게 반드시 실행된다.
    deps.teardown(binding)
  }
}
