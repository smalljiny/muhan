// WsClient 테스트 공용 하네스 — fake WebSocket과 소켓을 회수하는 factory, 송신 프레임 파서.
// 여러 wsClient*.test.ts가 공유한다(커버리지 대상에서 제외되는 *.testutil.ts).
import type { ServerEvent } from 'shared'
import { WsClient, type SocketLike } from '../transport/wsClient.js'

// 테스트용 최소 fake WebSocket — send를 기록하고, open/close/message를 수동 트리거한다.
// DOM 없이 wsClient 로직만 검증하기 위해 socketFactory로 주입한다.
export class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.(new CloseEvent('close'))
  }

  // 테스트 헬퍼 — 소켓 이벤트를 수동으로 발생시킨다.
  fireOpen(): void {
    this.onopen?.(new Event('open'))
  }
  emit(event: ServerEvent): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  emitRaw(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  fireError(): void {
    this.onerror?.(new Event('error'))
  }
}

// 각 테스트가 마지막으로 생성된 fake를 회수할 수 있게 하는 factory.
export function makeHarness() {
  const created: FakeSocket[] = []
  const factory = (): SocketLike => {
    const s = new FakeSocket()
    created.push(s)
    return s
  }
  const client = new WsClient({ url: 'ws://test', socketFactory: factory })
  const last = () => {
    const s = created[created.length - 1]
    if (!s) throw new Error('no socket created')
    return s
  }
  return { client, created, last }
}

// send 기록을 파싱해 배열로 돌려준다.
export function sentFrames(s: FakeSocket): unknown[] {
  return s.sent.map((raw) => JSON.parse(raw) as unknown)
}
