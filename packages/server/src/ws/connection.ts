import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from 'shared'
import type { AccountIdentity } from '../auth/sessionAuthPort.js'
import { ConnectionState } from './fsm/sessionFsm.js'

/**
 * per-connection 컨텍스트 — 소켓 하나의 수명 동안 유지되는 transport 상태.
 *
 * `protocolVersion`은 핸드셰이크(Story 4)가 대조에 쓸 계약 세대(서버 권위, 불변). `ready`는 핸드셰이크
 * 완료 여부로, 첫 `system:ready`가 서버 버전과 일치하면 true로 전이한다(연결당 1회). `heartbeat`는
 * 하트비트 타이머 슬롯으로, Story 5-6이 여기에 ping 타이머 핸들을 대입한다(현재는 미채움, 초기값 null).
 * `account`는 preValidation 게이트가 확정한 계정 신원으로, upgrade 성공 시 소켓 핸들러가 `req.account`를
 * 여기 대입한다(초기값 null — 게이트 통과 전이거나 배선 오류 시 null). `state`는 세션 FSM의 현재 상태로,
 * 핸드셰이크 완료(accept) 전엔 FSM 미진입이라 초기값 characterSelect를 두되 onEnter는 accept 시 구동한다
 * (`ready` 플래그가 진입 전/후를 구분). `ready`·`heartbeat`·`account`·`state`는 소켓 수명 동안 갱신되는
 * mutable 슬롯이라 `readonly`를 두지 않는다.
 */
export interface ConnectionContext {
  readonly protocolVersion: number
  ready: boolean
  heartbeat: NodeJS.Timeout | null
  account: AccountIdentity | null
  state: ConnectionState
}

/**
 * 새 연결의 초기 컨텍스트를 만든다. 핸드셰이크·계정 대입 이전이므로 `ready`는 false·`account`는 null.
 * `state`는 characterSelect로 두되 FSM 진입(onEnter)은 accept 시점에 일어난다(ready 플래그로 구분).
 */
export function createConnectionContext(): ConnectionContext {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ready: false,
    heartbeat: null,
    account: null,
    state: ConnectionState.characterSelect,
  }
}

/**
 * 연결 종료 시 per-connection 리소스를 정리한다.
 *
 * `heartbeat` 슬롯에 남은 ping 타이머를 clear해 누수를 막고(방어선), 레지스트리에서 컨텍스트를 제거한다.
 * 하트비트 매니저의 `stop()`도 같은 타이머를 정리하지만, 어느 경로로 close되더라도 타이머가 살아남지
 * 않도록 여기서 한 번 더 clear한다(clearInterval은 idempotent).
 */
export function cleanupConnection(
  connections: Map<WebSocket, ConnectionContext>,
  socket: WebSocket,
): void {
  const ctx = connections.get(socket)
  if (ctx?.heartbeat != null) {
    clearInterval(ctx.heartbeat)
    ctx.heartbeat = null
  }
  connections.delete(socket)
}
