import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerEvent } from 'shared'
import { PROTOCOL_VERSION } from 'shared'
import { WsClient, type SocketLike, type WsClientSnapshot } from './wsClient.js'
import { makeRoom, makeEmptyRoom, roomEvent } from '../test/roomFixtures.testutil.js'

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
    expect(session.characterId).toBeNull()
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

  // 두 진입 결과가 phase만 다르고 나머지 계약(ready 상태 + 본인 characterId 보관)은 동일하다.
  it.each([
    ['session:entered', 'entered'],
    ['session:resumed', 'resumed'],
  ] as const)('reaches %s phase, ready status, and remembers own characterId', (type, phase) => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type, characterId: 'c1' })
    expect(client.getSnapshot().session.phase).toBe(phase)
    expect(client.getStatus()).toBe('ready')
    expect(client.getSnapshot().session.characterId).toBe('c1')
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

// world:room 픽스처 — 확장 7필드를 모두 채운 방(roomA)과, 덮어쓰기를 증명하기 위해
// 목록 필드를 전부 비운 두 번째 방(roomB). 기대값도 이 두 상수를 그대로 재사용한다.
const roomA = makeRoom()
const roomB = makeEmptyRoom()

describe('WsClient room state', () => {
  it('starts with a null room before any world:room arrives', () => {
    const { client } = makeHarness()
    expect(client.getSnapshot().room).toBeNull()
  })

  it('stores every world:room field except type on the room snapshot', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit(roomEvent(roomA))
    // toEqual은 잉여 속성에서 실패한다 — type이 새어 들어오면 여기서 잡힌다.
    expect(client.getSnapshot().room).toEqual(roomA)
  })

  it('replaces the previous room on a later world:room instead of accumulating', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit(roomEvent(roomA))
    last().emit(roomEvent(roomB))
    // 두 번째 방은 목록이 전부 비어 있다 — 배열 누적(concat) 버그면 이전 방 항목이 남는다.
    // (얕은 병합은 7필드가 전부 required라 교체와 결과가 같아 이 테스트로 구분되지 않는다.)
    expect(client.getSnapshot().room).toEqual(roomB)
  })

  it('does not mutate the snapshot object handed to subscribers when a room arrives', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const before = client.getSnapshot()
    // handleMessage는 recordEvent(새 스냅샷 + notify) → dispatch → setRoom 순서다. 따라서
    // `before`는 setRoom이 만지는 객체가 아니라, 그것만 붙들면 in-place 변형을 놓친다.
    // setRoom이 겨냥하는 객체는 recordEvent 알림 시점의 스냅샷이므로 구독으로 그것을 포착한다.
    const seen: WsClientSnapshot[] = []
    client.subscribe(() => seen.push(client.getSnapshot()))
    last().emit(roomEvent(roomA))

    expect(seen[0]?.room).toBeNull()
    expect(seen[seen.length - 1]?.room).not.toBeNull()
    // room 갱신은 session 서브객체를 복제하지 않는다 — 구조 공유 유지.
    expect(client.getSnapshot().session).toBe(before.session)
  })
})

describe('WsClient self character identity', () => {
  // 초기 null·entered/resumed 세팅은 위 'session state & commands' 블록이 함께 단정한다
  // (같은 setup·같은 emit이라 별도 케이스를 두면 시퀀스가 그림자 복제된다).
  // 여기는 setSession 불변식 회귀 가드만 둔다 — 이번 확장이 characterId 키를 그 경로에 얹었다.
  it('does not mutate a previously handed out session object', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const beforeSession = client.getSnapshot().session
    last().emit({ type: 'session:entered', characterId: 'c1' })
    expect(beforeSession.characterId).toBeNull()
    expect(client.getSnapshot().session).not.toBe(beforeSession)
  })
})

describe('WsClient move command', () => {
  it('sends a world:move frame with the given direction', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const ok = client.move('북')
    expect(ok).toBe(true)
    expect(sentFrames(last())).toContainEqual({ type: 'world:move', direction: '북' })
  })

  it('blocks an empty direction (min 1) at send validation without touching the socket', () => {
    const { client, last } = makeHarness()
    client.connect()
    // 소켓이 연결된 상태 — not-connected 가드를 통과시켜야 스키마 가드를 검증할 수 있다.
    last().fireOpen()
    const ok = client.move('')
    expect(ok).toBe(false)
    const errors = client.getSnapshot().errors
    expect(errors[errors.length - 1]?.kind).toBe('send-validation')
    expect(last().sent).toHaveLength(0)
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
