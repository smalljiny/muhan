import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerEvent } from 'shared'
import { PROTOCOL_VERSION } from 'shared'
import { WsClient, type SocketLike } from './wsClient.js'

// 테스트용 최소 fake WebSocket — send를 기록하고, open/close/message를 수동 트리거한다.
// DOM 없이 wsClient 로직만 검증하기 위해 socketFactory로 주입한다.
class FakeSocket implements SocketLike {
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

  // 테스트 헬퍼 — 소켓 이벤트를 수동으로 발화한다.
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
function makeHarness() {
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
function sentFrames(s: FakeSocket): unknown[] {
  return s.sent.map((raw) => JSON.parse(raw) as unknown)
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('WsClient connect/disconnect/reconnect', () => {
  it('starts disconnected before connect', () => {
    const { client } = makeHarness()
    expect(client.getStatus()).toBe('disconnected')
  })

  it('transitions disconnected -> connecting -> connected across open', () => {
    const { client, last } = makeHarness()
    client.connect()
    expect(client.getStatus()).toBe('connecting')
    last().fireOpen()
    expect(client.getStatus()).toBe('connected')
  })

  it('disconnect closes the socket and returns to disconnected', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    client.disconnect()
    expect(last().closed).toBe(true)
    expect(client.getStatus()).toBe('disconnected')
  })

  it('reconnect creates a fresh socket', () => {
    const { client, created, last } = makeHarness()
    client.connect()
    last().fireOpen()
    client.reconnect()
    expect(created).toHaveLength(2)
    expect(client.getStatus()).toBe('connecting')
  })

  it('detaches stale handlers on reconnect so a late onclose cannot corrupt the new socket', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const oldSocket = last()
    client.reconnect()
    // 브라우저는 close() 이후 onclose를 다음 틱에 발화한다 — reconnect 후 도착한 구 소켓 onclose 시뮬레이션.
    oldSocket.onclose?.(new CloseEvent('close'))
    // 새 소켓이 살아남아야 한다 — 구 소켓 핸들러가 this.socket/status를 오염시키면 안 된다.
    expect(client.getStatus()).toBe('connecting')
  })

  it('returns to disconnected when the socket closes remotely', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().onclose?.(new CloseEvent('close'))
    expect(client.getStatus()).toBe('disconnected')
  })

  it('records a not-connected error when sending with no socket', () => {
    const { client } = makeHarness()
    const ok = client.send({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION })
    expect(ok).toBe(false)
    expect(client.getSnapshot().errors.some((e) => e.kind === 'not-connected')).toBe(true)
  })
})

describe('WsClient version negotiation', () => {
  it('sends system:ready with PROTOCOL_VERSION on system:hello', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
    const frames = sentFrames(last())
    expect(frames).toContainEqual({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION })
    expect(client.getStatus()).toBe('negotiating')
  })
})

describe('WsClient session state & commands', () => {
  it('starts with session.phase connecting and empty session state', () => {
    const { client } = makeHarness()
    const session = client.getSnapshot().session
    expect(session.phase).toBe('connecting')
    expect(session.characterList).toEqual([])
    expect(session.activePrompt).toBeNull()
    expect(session.lastError).toBeNull()
  })

  it('selectCharacter sends a session:selectCharacter frame', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const ok = client.selectCharacter('c1')
    expect(ok).toBe(true)
    expect(sentFrames(last())).toContainEqual({ type: 'session:selectCharacter', characterId: 'c1' })
  })

  it('replyPrompt sends a session:reply frame with the caller value verbatim', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const ok = client.replyPrompt('create:name', '철수')
    expect(ok).toBe(true)
    expect(sentFrames(last())).toContainEqual({
      type: 'session:reply',
      promptId: 'create:name',
      value: '철수',
    })
  })

  it('blocks selectCharacter with an empty characterId (min 1) via send validation', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const ok = client.selectCharacter('')
    expect(ok).toBe(false)
    expect(last().sent).toHaveLength(0)
    expect(client.getSnapshot().errors.some((e) => e.kind === 'send-validation')).toBe(true)
  })

  it('stores the character list on session:characterList without auto-selecting', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({
      type: 'session:characterList',
      characters: [
        { characterId: 'c1', name: 'A', class: 0, race: 0, level: 1 },
        { characterId: 'c2', name: 'B', class: 0, race: 0, level: 1 },
      ],
    })
    expect(client.getSnapshot().session.characterList).toEqual([
      { characterId: 'c1', name: 'A', class: 0, race: 0, level: 1 },
      { characterId: 'c2', name: 'B', class: 0, race: 0, level: 1 },
    ])
    const selects = sentFrames(last()).filter(
      (f) => typeof f === 'object' && f !== null && (f as { type: string }).type === 'session:selectCharacter',
    )
    expect(selects).toHaveLength(0)
  })

  it('enters selecting phase and stores activePrompt on a selectCharacter prompt', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({
      type: 'session:prompt',
      promptId: 'select',
      kind: 'selectCharacter',
      options: [{ value: 'c1', label: 'A' }],
    })
    const session = client.getSnapshot().session
    expect(session.phase).toBe('selecting')
    expect(session.activePrompt).toEqual({
      promptId: 'select',
      kind: 'selectCharacter',
      options: [{ value: 'c1', label: 'A' }],
    })
  })

  it('enters creating phase on a createField prompt', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'session:prompt', promptId: 'create:name', kind: 'createField' })
    const session = client.getSnapshot().session
    expect(session.phase).toBe('creating')
    expect(session.activePrompt?.promptId).toBe('create:name')
  })

  it('reaches entered phase and echo-ready status on session:entered', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'session:entered', characterId: 'c1' })
    expect(client.getSnapshot().session.phase).toBe('entered')
    expect(client.getStatus()).toBe('ready')
  })

  it('reaches resumed phase and echo-ready status on session:resumed', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'session:resumed', characterId: 'c1' })
    expect(client.getSnapshot().session.phase).toBe('resumed')
    expect(client.getStatus()).toBe('ready')
  })

  it('records lastError without clearing activePrompt on error', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'session:prompt', promptId: 'create:name', kind: 'createField' })
    last().emit({ type: 'error', code: 'session_state', message: 'bad name' })
    const session = client.getSnapshot().session
    expect(session.lastError).toEqual({ code: 'session_state', message: 'bad name' })
    expect(session.activePrompt?.promptId).toBe('create:name')
  })
})

describe('WsClient send validation', () => {
  it('sends a valid ClientCommand', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const ok = client.send({ type: 'session:selectCharacter', characterId: 'c1' })
    expect(ok).toBe(true)
    expect(sentFrames(last())).toContainEqual({ type: 'session:selectCharacter', characterId: 'c1' })
  })

  it('blocks an invalid ClientCommand before sending and records an error', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    // characterId min(1) 위반 — 빈 문자열
    const ok = client.send({ type: 'session:selectCharacter', characterId: '' })
    expect(ok).toBe(false)
    expect(last().sent).toHaveLength(0)
    expect(client.getSnapshot().errors.some((e) => e.kind === 'send-validation')).toBe(true)
  })
})

describe('WsClient sendEcho', () => {
  it('assembles and sends a debug:echo command', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    client.sendEcho('hello')
    expect(sentFrames(last())).toContainEqual({ type: 'debug:echo', text: 'hello' })
  })

  it('blocks an empty echo (freeText min 1) and records an error', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    client.sendEcho('')
    expect(last().sent).toHaveLength(0)
    expect(client.getSnapshot().errors.some((e) => e.kind === 'send-validation')).toBe(true)
  })
})

describe('WsClient receive validation', () => {
  it('records valid ServerEvents into the event stream', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'debug:echo:result', text: 'pong' })
    expect(client.getSnapshot().events).toContainEqual({ type: 'debug:echo:result', text: 'pong' })
  })

  it('rejects an invalid ServerEvent and records a receive-validation error', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emitRaw(JSON.stringify({ type: 'not:a:real:event', foo: 1 }))
    expect(client.getSnapshot().errors.some((e) => e.kind === 'receive-validation')).toBe(true)
    expect(client.getSnapshot().events).toHaveLength(0)
  })

  it('records a parse error on non-JSON frames', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emitRaw('}{ not json')
    expect(client.getSnapshot().errors.some((e) => e.kind === 'parse')).toBe(true)
  })

  it('records a parse error on non-string frame data', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emitRaw(42)
    expect(client.getSnapshot().errors.some((e) => e.kind === 'parse')).toBe(true)
  })
})

describe('WsClient observability', () => {
  it('notifies subscribers on state change and stops after unsubscribe', () => {
    const { client, last } = makeHarness()
    const listener = vi.fn()
    const unsub = client.subscribe(listener)
    client.connect()
    expect(listener).toHaveBeenCalled()
    unsub()
    const before = listener.mock.calls.length
    last().fireOpen()
    expect(listener.mock.calls.length).toBe(before)
  })

  it('returns a referentially stable snapshot when nothing changes', () => {
    const { client } = makeHarness()
    const a = client.getSnapshot()
    const b = client.getSnapshot()
    expect(a).toBe(b)
  })

  it('returns a new snapshot object after a change', () => {
    const { client } = makeHarness()
    const a = client.getSnapshot()
    client.connect()
    const b = client.getSnapshot()
    expect(a).not.toBe(b)
  })

  it('records an error on socket error events', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireError()
    expect(client.getSnapshot().errors.length).toBeGreaterThan(0)
  })
})

describe('WsClient default socket factory', () => {
  it('uses the global WebSocket when no factory is injected', () => {
    const instances: string[] = []
    class StubWebSocket {
      onopen: ((ev: Event) => void) | null = null
      onclose: ((ev: CloseEvent) => void) | null = null
      onmessage: ((ev: MessageEvent) => void) | null = null
      onerror: ((ev: Event) => void) | null = null
      constructor(url: string) {
        instances.push(url)
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', StubWebSocket)
    const client = new WsClient({ url: 'ws://global' })
    client.connect()
    expect(instances).toContain('ws://global')
  })
})
