import type { ConnectionContext } from './connection.js'
import { ConnectionState } from './fsm/sessionFsm.js'
import type { SessionBinding, SessionRegistry, TerminateCallback } from './sessionRegistry.js'

/**
 * 연결 수명주기 조율 — 세션 FSM의 command 진입(등록/재연결)과 소켓 close 판정(link-dead vs no-op)을
 * registry·resolveDisconnect 위에서 조율하는 셸 단위. **소켓·emit을 직접 만지지 않는다** — registry
 * 조작과 주입 `resolveDisconnect`(종결)·`setTimeoutFn`(grace 스케줄)만 쓰므로 3층 경계(소켓은 셸에만)를
 * 지키고 fake clock으로 결정적 단위 테스트가 된다(deadline.ts의 setTimeoutFn 주입 관례 미러).
 *
 * plugin(셸)이 per-connection이 아니라 registerWebsocket 1회에 인스턴스화해 연결 간 공유한다. FSM은
 * `SessionContext.enterWorld` 주입 콜백으로 `enterWorld`를 호출하고, 셸의 socket 'close' 핸들러가
 * `handleClose`를 호출한다.
 */

/** createSessionLifecycle 주입물. graceMs는 env WS_RECONNECT_GRACE_MS(하드코딩 금지). */
export interface SessionLifecycleDeps {
  readonly registry: SessionRegistry
  /** 등록된 바인딩의 단일 종결 함수(resolveDisconnect). register의 evict-old·grace 만료가 공유한다. */
  readonly resolveDisconnect: TerminateCallback
  /**
   * link-dead 재연결 창(ms)을 돌려주는 provider. **thunk로 받는 것이 load-bearing**이다 — lifecycle은
   * registerWebsocket 1회에 인스턴스화되지만 env(getConfig)는 연결 시점에야 읽혀야 하므로(미설정 buildApp을
   * 막지 않는다), grace 값을 스케줄 시점에 지연 조회한다. 셸은 `() => getConfig().WS_RECONNECT_GRACE_MS`로 배선한다.
   */
  readonly graceMs: () => number
  /** grace 타이머 스케줄용 setTimeout. 미주입 시 전역 setTimeout(deadline.ts 관례 미러, fake clock 지원). */
  readonly setTimeoutFn?: typeof setTimeout
}

/** 연결 수명주기 핸들 — command 진입 등록/재연결(enterWorld)과 소켓 close 판정(handleClose). */
export interface SessionLifecycle {
  /**
   * 월드 진입 등록 seam — FSM `enterCommand`가 `SessionContext.enterWorld`로 호출한다.
   * link-dead + accountId 일치 엔트리가 있으면 rebind→'resumed', 그 외(엔트리 없음·account 불일치·live)는
   * register(기존 엔트리 있으면 resolveDisconnect로 evict)→'entered'를 반환한다.
   */
  enterWorld(ctx: ConnectionContext, accountId: string, characterId: string): 'entered' | 'resumed'
  /**
   * 소켓 close 도메인 판정 — command 상태 + 등록됨 + `binding.connection === ctx`일 때만 markLinkDead로
   * grace 창을 연다. 미등록·stale(다른 ctx가 소유)·command 아님은 no-op(transport 정리는 셸이 별도로 한다).
   */
  handleClose(ctx: ConnectionContext): void
}

/**
 * 연결 수명주기 조율기를 만든다. registry·resolveDisconnect·graceMs·setTimeoutFn을 주입받아 소켓·타이머
 * 전역에 의존하지 않는다(순수 조율).
 */
export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout

  /**
   * link-dead 진입 시 grace 타이머를 건다. 만료 시 캡처한 `deadBinding`이 여전히 현재 map 엔트리인지
   * identity로 확인한 뒤에만 종결한다 — rebind가 새 객체로 교체했으면 불일치라 no-op이다(ABA-safe).
   */
  function scheduleGrace(deadBinding: SessionBinding): NodeJS.Timeout {
    return setTimeoutFn(() => {
      if (deps.registry.get(deadBinding.characterId) === deadBinding) {
        deps.resolveDisconnect(deadBinding, 'graceExpired')
      }
    }, deps.graceMs())
  }

  function enterWorld(
    ctx: ConnectionContext,
    accountId: string,
    characterId: string,
  ): 'entered' | 'resumed' {
    const existing = deps.registry.get(characterId)
    // link-dead + 같은 account면 재연결(rebind). rebind가 null이면 register로 폴백한다 — 단일 스레드 동기 경로라
    // get→rebind 사이 교체가 없어 실제로는 도달 불가하지만, rebind의 nullable 계약을 방어적으로 존중한다.
    if (existing !== undefined && existing.link === 'link-dead' && existing.accountId === accountId) {
      const rebound = deps.registry.rebind(existing, ctx)
      if (rebound !== null) return 'resumed'
    }
    // 그 외: fresh 등록. 기존 엔트리(있으면 live·link-dead 무관)는 register가 resolveDisconnect로 종결한다.
    // account 불일치 link-dead는 상류 assertOwnership(sessionFsm)로 도달 불가한 방어 폴백이다 — 도달한다면
    // 남의 계정 세션을 evict하게 되므로, 소유권 검증은 여기가 아니라 상류 게이트가 단일 책임으로 보장한다.
    deps.registry.register(characterId, accountId, ctx, deps.resolveDisconnect)
    return 'entered'
  }

  function handleClose(ctx: ConnectionContext): void {
    const characterId = ctx.boundCharacterId
    // 월드 미진입(command 아님·미등록)이면 도메인 종결 대상이 아니다.
    if (ctx.state !== ConnectionState.command || characterId === null) return
    const binding = deps.registry.get(characterId)
    // identity 가드(load-bearing): 현재 바인딩이 이 소켓의 ctx를 가리킬 때만 link-dead로 보낸다. 서버 주도
    // 종료(evict/grace) 후 옛 소켓의 뒤늦은 close가 새 세션을 markLinkDead하는 재진입을 막는다.
    if (binding === undefined || binding.connection !== ctx) return
    deps.registry.markLinkDead(binding, scheduleGrace)
  }

  return { enterWorld, handleClose }
}
