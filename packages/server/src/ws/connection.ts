import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from 'shared'

/**
 * per-connection 컨텍스트 — 소켓 하나의 수명 동안 유지되는 transport 상태.
 *
 * `protocolVersion`은 핸드셰이크(Story 4)가 대조에 쓸 계약 세대. `heartbeat`는 하트비트 타이머 슬롯으로,
 * Story 5-6이 여기에 ping 타이머 핸들을 대입한다(현재는 미채움, 초기값 null). 실사용 슬롯이 되도록
 * 미리 실제 타입(`NodeJS.Timeout | null`)으로 열어 둔다 — 채울 때 인터페이스를 다시 넓히지 않게 한다.
 */
export interface ConnectionContext {
  readonly protocolVersion: number
  heartbeat: NodeJS.Timeout | null
}

/** 새 연결의 초기 컨텍스트를 만든다. */
export function createConnectionContext(): ConnectionContext {
  return { protocolVersion: PROTOCOL_VERSION, heartbeat: null }
}

/**
 * 연결 종료 시 per-connection 리소스를 정리한다.
 *
 * 현재는 레지스트리에서 컨텍스트를 제거하는 것이 전부다. 하트비트 타이머 clear 지점은
 * Story 5-6에서 `heartbeat` 슬롯이 채워질 때 여기에 추가한다.
 */
export function cleanupConnection(
  connections: Map<WebSocket, ConnectionContext>,
  socket: WebSocket,
): void {
  connections.delete(socket)
}
