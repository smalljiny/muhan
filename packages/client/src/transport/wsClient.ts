// WebSocket 전송 레이어 — 순수 TS(프레임워크 비의존). React UI는 subscribe/getSnapshot을
// useSyncExternalStore로 소비한다. 송신 전 clientCommandSchema 검증, 수신 후 serverEventSchema parse,
// hello→ready 버전 협상, 세션 상태(phase·characterList·activePrompt·lastError·본인 characterId)와
// 방 상태(room) 노출, selectCharacter/replyPrompt/move 사용자 조작 기반 명령, debug:echo 송신을 제공한다.
// 방 상태는 world:room 스냅샷으로 교체되고, 그 사이 world:presence 델타가 점유자·알림(notices)을 고친다.
// lastError 수명: transient 오류는 해제 집합 이벤트(errorLifetime.ts의 CLEARS_TRANSIENT_ERROR) 처리 뒤 지우고,
// sticky 오류(unauthorized·forbidden)는 새 transient 오류로 덮어쓰지 않고 dismissError()로만 지운다.
// 로그 상한: events는 seq를 매긴 최근 EVENT_LOG_LIMIT건, errors는 최근 TRANSPORT_ERROR_LIMIT건만 유지한다.

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
import { appendBounded } from './appendBounded.js'
import { clearsTransientError, isStickyError } from './errorLifetime.js'
import { applyPresence } from './presence.js'

/** 스냅샷 events가 유지하는 최근 수신 이벤트 건수 상한. */
export const EVENT_LOG_LIMIT = 200

/** 스냅샷 errors가 유지하는 최근 전송 오류 건수 상한. */
export const TRANSPORT_ERROR_LIMIT = 50

/**
 * 기록된 수신 이벤트 — seq는 WsClient 인스턴스 단위로 0부터 단조 증가하며 재연결에도 이어진다.
 * 상한으로 앞 항목이 빠져도 남은 항목의 seq·참조는 바뀌지 않아 렌더 키로 쓸 수 있다.
 */
export interface LoggedEvent {
  readonly seq: number
  readonly event: ServerEvent
}

/** 연결 라이프사이클 상태. ready = echo 가능(session:entered/resumed 도달). */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'negotiating' | 'ready'

/** 세션 진입 단계 — status(전송 라이프사이클)와 독립적으로 갱신되는 파생 필드. */
export type SessionPhase =
  'connecting' | 'negotiating' | 'selecting' | 'creating' | 'entered' | 'resumed'

/** 진행 중 prompt 요약 — 캐릭터 선택·생성 필드 입력 대화의 활성 질문. */
export interface ActivePrompt {
  promptId: string
  kind: PromptKind
  options?: readonly PromptOption[]
}

/** 세션 진입 서브상태 — phase·characterList·activePrompt·lastError·본인 characterId. */
export interface SessionState {
  phase: SessionPhase
  characterList: readonly CharacterSummary[]
  activePrompt: ActivePrompt | null
  /**
   * 마지막 서버 error 이벤트. transient 코드는 해제 집합 이벤트(본인 조작 성공·진입 대화의 새 단계)가
   * 오면 null로 돌아가고, sticky 코드(unauthorized·forbidden)는 dismissError() 전까지 남는다.
   * sticky가 걸려 있는 동안 새 transient 오류는 무시되고, 새 sticky 오류는 교체된다.
   */
  lastError: { code: ErrorCode; message: string } | null
  /** 본인 캐릭터 id — session:entered·resumed로 확정된다. 진입 전에는 null. */
  characterId: string | null
}

/**
 * 방 서브상태 — world:room 페이로드에서 판별자 type만 뺀 형태다. 서버의 `RoomView`와 같은
 * shared 계약 파생이라 와이어 계약이 바뀌면 양쪽이 함께 타입 에러로 드러난다.
 * `notices`는 클라이언트 전용 필드로, announce된 world:presence 문장을 최근 20개까지 담는다.
 */
export type RoomState = Omit<Extract<ServerEvent, { type: 'world:room' }>, 'type'> & {
  readonly notices: readonly string[]
}

/** 브라우저 WebSocket과 호환되는 최소 인터페이스 — 테스트가 fake를 주입할 수 있게 한다. */
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

/**
 * 불변 스냅샷 — 변경이 있을 때만 새 객체로 재할당해 참조 안정성을 보장한다.
 *
 * 층 경계: **최상위**는 전송 라이프사이클(`status`·`events`·`errors`)과 서버가 확정해 준 월드
 * 스냅샷(`room`)이고, **`session`**은 command 상태 도달까지의 진입 대화 서브상태다(`phase`·
 * `characterList`·`activePrompt`·`lastError`·`characterId` — 전부 핸드셰이크 산출물).
 * 후속 월드 상태(스탯·인벤·채팅)는 `session`이 아니라 최상위에 놓거나 최상위 `world` 그룹으로
 * 묶는다 — 진입 대화가 아니라 서버가 기준인 상태이기 때문이다.
 */
export interface WsClientSnapshot {
  status: ConnectionStatus
  /**
   * 수신 순서대로 기록한 최근 EVENT_LOG_LIMIT건. seq는 인스턴스 단위로 이어지며
   * connect·disconnect·reconnect로 초기화되지 않는다(로그도 비우지 않는다).
   */
  events: readonly LoggedEvent[]
  /** 최근 TRANSPORT_ERROR_LIMIT건의 전송 오류(들어온 순서). */
  errors: readonly WsError[]
  session: SessionState
  /**
   * 마지막으로 통지받은 방. 방 상태가 없는 구간(서버가 이벤트 발생을 생략한 경우)은 null이다.
   * 같은 방의 world:presence 델타가 점유자 목록과 notices에 반영된다.
   */
  room: RoomState | null
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
  /** 다음 기록 이벤트에 매길 seq — 인스턴스 수명 동안 단조 증가한다. */
  private nextSeq = 0
  private snapshot: WsClientSnapshot = {
    status: 'disconnected',
    events: [],
    errors: [],
    session: {
      phase: 'connecting',
      characterList: [],
      activePrompt: null,
      lastError: null,
      characterId: null,
    },
    room: null,
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
   * 소켓 핸들러를 떼어낸다. close()는 브라우저에서 onclose를 다음 틱에 실행하므로,
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

  /** lastError를 코드와 무관하게 지운다(사용자가 배너를 닫는 조작). 이미 null이면 통지하지 않는다. */
  dismissError(): void {
    if (this.snapshot.session.lastError === null) return
    this.setSession({ lastError: null })
  }

  /** 이동 명령 송신. send 검증 경로를 재사용하며, direction min(1)·max(32) 위반은 차단된다. */
  move(direction: string): boolean {
    return this.send({ type: 'world:move', direction })
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
        this.setSession({ phase: 'entered', characterId: event.characterId })
        break
      case 'session:resumed':
        this.setStatus('ready')
        this.setSession({ phase: 'resumed', characterId: event.characterId })
        break
      case 'world:room': {
        // 스냅샷이지 델타가 아니다 — 판별자만 떼고 방 전체를 통째로 교체한다. 알림은 같은 방
        // 스냅샷(몬스터 사망 등)이면 유지하고, 방이 바뀌었거나 처음이면 비운다.
        const { type: _type, ...wire } = event
        const prev = this.snapshot.room
        const notices = prev !== null && prev.roomId === wire.roomId ? prev.notices : []
        this.setRoom({ ...wire, notices })
        break
      }
      case 'world:presence': {
        // 방 상태가 없거나 다른 방의 늦은 통지(OQ2)는 무시한다 — 이벤트 기록은 이미 끝났다.
        const room = this.snapshot.room
        if (room === null || room.roomId !== event.roomId) break
        this.setRoom(applyPresence(room, event))
        break
      }
      case 'error':
        this.applyError({ code: event.code, message: event.message })
        break
      default:
        break
    }
    if (clearsTransientError(event.type)) this.clearTransientError()
  }

  /** 새 서버 오류를 저장한다 — sticky가 걸려 있으면 transient 오류로 덮어쓰지 않는다. */
  private applyError(next: { code: ErrorCode; message: string }): void {
    const current = this.snapshot.session.lastError
    if (current !== null && isStickyError(current.code) && !isStickyError(next.code)) return
    this.setSession({ lastError: next })
  }

  /** transient lastError만 지운다. null이거나 sticky이면 setSession을 호출하지 않아 참조를 보존한다. */
  private clearTransientError(): void {
    const current = this.snapshot.session.lastError
    if (current === null || isStickyError(current.code)) return
    this.setSession({ lastError: null })
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

  /**
   * 방 서브상태를 불변 재할당한다. setStatus 같은 동등성 조기 반환은 두지 않는다 —
   * 방 페이로드는 매번 새 객체라 참조 비교가 의미 없고, 스킵하면 갱신이 누락된다.
   */
  private setRoom(room: RoomState): void {
    this.snapshot = { ...this.snapshot, room }
    this.notify()
  }

  private recordEvent(event: ServerEvent): void {
    this.snapshot = {
      ...this.snapshot,
      events: appendBounded(this.snapshot.events, { seq: this.nextSeq++, event }, EVENT_LOG_LIMIT),
    }
    this.notify()
  }

  private pushError(error: WsError): void {
    this.snapshot = {
      ...this.snapshot,
      errors: appendBounded(this.snapshot.errors, error, TRANSPORT_ERROR_LIMIT),
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
