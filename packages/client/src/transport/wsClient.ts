// WebSocket 전송 레이어 — 순수 TS(프레임워크 비의존). React UI는 subscribe/getSnapshot을
// useSyncExternalStore로 소비한다. 송신 전 clientCommandSchema 검증, 수신 후 serverEventSchema parse,
// hello→ready 버전 협상, 세션 상태(phase·characterList·activePrompt·lastError) 노출과
// selectCharacter/replyPrompt 사용자 구동 명령, debug:echo 송신을 제공한다.

import {
  clientCommandSchema,
  serverEventSchema,
  PROTOCOL_VERSION,
  type CharacterSummary,
  type ClientCommand,
  type ErrorCode,
  type PromptKind,
  type PromptOption,
  type ServerEvent,
} from 'shared/protocol'

/** 연결 라이프사이클 상태. ready = echo 가능(session:entered/resumed 도달). */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'negotiating'
  | 'ready'

/** 세션 진입 단계 — status(전송 라이프사이클)와 독립적으로 갱신되는 파생 필드. */
export type SessionPhase =
  | 'connecting'
  | 'negotiating'
  | 'selecting'
  | 'creating'
  | 'entered'
  | 'resumed'

/** 진행 중 prompt 요약 — 캐릭터 선택·생성 필드 입력 대화의 활성 질문. */
export interface ActivePrompt {
  promptId: string
  kind: PromptKind
  options?: readonly PromptOption[]
}

/** 세션 진입 서브상태 — phase·characterList·activePrompt·lastError. */
export interface SessionState {
  phase: SessionPhase
  characterList: readonly CharacterSummary[]
  activePrompt: ActivePrompt | null
  lastError: { code: ErrorCode; message: string } | null
}

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
  session: SessionState
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
  private listeners: readonly (() => void)[] = []
  private snapshot: WsClientSnapshot = {
    status: 'disconnected',
    events: [],
    errors: [],
    session: {
      phase: 'connecting',
      characterList: [],
      activePrompt: null,
      lastError: null,
    },
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

  /** 캐릭터 선택 명령 송신. send 검증 경로를 재사용하며, characterId min(1) 위반은 차단된다. */
  selectCharacter(characterId: string): boolean {
    return this.send({ type: 'session:selectCharacter', characterId })
  }

  /** prompt 응답 송신. value는 호출자가 넘긴 그대로 전달한다(sentinel·confirm 값 하드코딩 없음). */
  replyPrompt(promptId: string, value: string): boolean {
    return this.send({ type: 'session:reply', promptId, value })
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
        this.setSession({ phase: 'negotiating' })
        break
      case 'session:characterList':
        this.setSession({ characterList: event.characters })
        break
      case 'session:prompt':
        this.setSession({
          phase: event.kind === 'selectCharacter' ? 'selecting' : 'creating',
          activePrompt: { promptId: event.promptId, kind: event.kind, options: event.options },
        })
        break
      case 'session:entered':
        this.setStatus('ready')
        this.setSession({ phase: 'entered' })
        break
      case 'session:resumed':
        this.setStatus('ready')
        this.setSession({ phase: 'resumed' })
        break
      case 'error':
        this.setSession({ lastError: { code: event.code, message: event.message } })
        break
      default:
        break
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.snapshot.status === status) return
    this.snapshot = { ...this.snapshot, status }
    this.notify()
  }

  /** 세션 서브상태를 불변 재할당한다 — 변경된 키만 새 session 객체로 교체하고 나머지는 보존한다. */
  private setSession(partial: Partial<SessionState>): void {
    this.snapshot = {
      ...this.snapshot,
      session: { ...this.snapshot.session, ...partial },
    }
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
