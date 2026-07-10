// WebSocket 전송 레이어 — 순수 TS(프레임워크 비의존). React UI(Story 3)는 subscribe/getSnapshot을
// useSyncExternalStore로 소비한다. 송신 전 clientCommandSchema 검증, 수신 후 serverEventSchema parse,
// hello→ready 버전 협상, command 상태 도달용 최소 자동 selectCharacter, debug:echo 송신을 제공한다.

import {
  clientCommandSchema,
  serverEventSchema,
  PROTOCOL_VERSION,
  type CharacterSummary,
  type ClientCommand,
  type ServerEvent,
} from 'shared/protocol'

/** 연결 라이프사이클 상태. ready = echo 가능(session:entered/resumed 도달). */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'negotiating'
  | 'ready'

/** 브라우저 WebSocket과 호환되는 최소 표면 — 테스트가 fake를 주입할 수 있게 한다. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: Event) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: Event) => void) | null
}

export type SocketFactory = (url: string) => SocketLike

/** 관측 가능한 오류 채널 — throw 대신 스냅샷의 errors에 누적한다. */
export type WsError =
  | { kind: 'send-validation'; message: string }
  | { kind: 'receive-validation'; message: string }
  | { kind: 'parse'; message: string }
  | { kind: 'not-connected'; message: string }
  | { kind: 'socket'; message: string }

/** 불변 스냅샷 — 변경이 있을 때만 새 객체로 재할당해 참조 안정성을 보장한다. */
export interface WsClientSnapshot {
  status: ConnectionStatus
  events: readonly ServerEvent[]
  errors: readonly WsError[]
}

export interface WsClientOptions {
  url: string
  socketFactory?: SocketFactory
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url)

export class WsClient {
  private readonly url: string
  private readonly socketFactory: SocketFactory
  private socket: SocketLike | null = null
  private selectSent = false
  private listeners: readonly (() => void)[] = []
  private snapshot: WsClientSnapshot = {
    status: 'disconnected',
    events: [],
    errors: [],
  }

  constructor(options: WsClientOptions) {
    this.url = options.url
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
  }

  getSnapshot(): WsClientSnapshot {
    return this.snapshot
  }

  getStatus(): ConnectionStatus {
    return this.snapshot.status
  }

  /** 상태 변경 구독 — useSyncExternalStore 호환. 해지 함수를 돌려준다. */
  subscribe(listener: () => void): () => void {
    this.listeners = [...this.listeners, listener]
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  connect(): void {
    this.selectSent = false
    this.setStatus('connecting')
    const socket = this.socketFactory(this.url)
    this.socket = socket
    socket.onopen = () => this.setStatus('connected')
    socket.onclose = () => {
      this.socket = null
      this.setStatus('disconnected')
    }
    socket.onerror = () => this.pushError({ kind: 'socket', message: 'socket error' })
    socket.onmessage = (ev) => this.handleMessage(ev)
  }

  disconnect(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      this.detachHandlers(socket)
      socket.close()
    }
    this.setStatus('disconnected')
  }

  /**
   * 소켓 핸들러를 떼어낸다. close()는 브라우저에서 onclose를 다음 틱에 발화하므로,
   * 떼어내지 않으면 reconnect 이후 도착한 구 소켓의 onclose가 새 소켓 참조·status를 오염시킨다.
   */
  private detachHandlers(socket: SocketLike): void {
    socket.onopen = null
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
  }

  reconnect(): void {
    this.disconnect()
    this.connect()
  }

  /** ClientCommand를 검증 후 송신. 검증 실패·미연결 시 false를 돌려주고 프레임을 보내지 않는다. */
  send(cmd: unknown): boolean {
    const parsed = clientCommandSchema.safeParse(cmd)
    if (!parsed.success) {
      this.pushError({ kind: 'send-validation', message: parsed.error.message })
      return false
    }
    if (!this.socket) {
      this.pushError({ kind: 'not-connected', message: 'socket is not connected' })
      return false
    }
    this.socket.send(JSON.stringify(parsed.data))
    return true
  }

  /** debug:echo ClientCommand를 조립해 송신한다. 빈 text는 freeText min(1) 위반으로 차단된다. */
  sendEcho(text: string): void {
    const command: ClientCommand = { type: 'debug:echo', text }
    this.send(command)
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data !== 'string') {
      this.pushError({ kind: 'parse', message: 'frame data is not a string' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(ev.data)
    } catch {
      this.pushError({ kind: 'parse', message: 'frame is not valid JSON' })
      return
    }
    const result = serverEventSchema.safeParse(parsed)
    if (!result.success) {
      this.pushError({ kind: 'receive-validation', message: result.error.message })
      return
    }
    this.recordEvent(result.data)
    this.dispatch(result.data)
  }

  private dispatch(event: ServerEvent): void {
    switch (event.type) {
      case 'system:hello':
        this.send({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION })
        this.setStatus('negotiating')
        break
      case 'session:characterList':
        this.autoSelect(event.characters)
        break
      case 'session:entered':
      case 'session:resumed':
        this.setStatus('ready')
        break
      default:
        break
    }
  }

  private autoSelect(characters: readonly CharacterSummary[]): void {
    if (this.selectSent) return
    const first = characters[0]
    if (!first) return
    this.selectSent = true
    this.send({ type: 'session:selectCharacter', characterId: first.characterId })
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.snapshot.status === status) return
    this.snapshot = { ...this.snapshot, status }
    this.notify()
  }

  private recordEvent(event: ServerEvent): void {
    this.snapshot = { ...this.snapshot, events: [...this.snapshot.events, event] }
    this.notify()
  }

  private pushError(error: WsError): void {
    this.snapshot = { ...this.snapshot, errors: [...this.snapshot.errors, error] }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
