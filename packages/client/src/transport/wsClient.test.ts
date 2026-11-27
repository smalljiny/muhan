import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerEvent } from 'shared'
import { PROTOCOL_VERSION, serverEventSchema } from 'shared'
import {
  EVENT_LOG_LIMIT,
  TRANSPORT_ERROR_LIMIT,
  WsClient,
  type SocketLike,
  type WsClientSnapshot,
} from './wsClient.js'
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
    // 브라우저는 close() 이후 onclose를 다음 틱에 실행한다 — reconnect 후 도착한 구 소켓 onclose 시뮬레이션.
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
    expect(sentFrames(last())).toContainEqual({
      type: 'session:selectCharacter',
      characterId: 'c1',
    })
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
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        (f as { type: string }).type === 'session:selectCharacter',
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

describe('WsClient world:presence', () => {
  type PresenceFrame = Extract<ServerEvent, { type: 'world:presence' }>
  type Change = PresenceFrame['change']

  // 기본 대상은 roomA 점유자(c1)에 없는 c2다.
  function presenceEvent(change: Change, roomId = roomA.roomId): PresenceFrame {
    return {
      type: 'world:presence',
      roomId,
      subject: { kind: 'player', characterId: 'c2', name: '개발전사' },
      change,
    }
  }

  // 연결 후 roomA에 들어간 상태의 하네스.
  function enteredHarness() {
    const h = makeHarness()
    h.client.connect()
    h.last().fireOpen()
    h.last().emit(roomEvent(roomA))
    return h
  }

  const C2 = { characterId: 'c2', name: '개발전사' }
  const ARRIVED = '개발전사님이 도착하였습니다.'

  it('ignores presence while there is no room state but still records the event', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    const event = presenceEvent({ change: 'moved-in', announce: true })
    last().emit(event)
    expect(client.getSnapshot().room).toBeNull()
    expect(client.getSnapshot().events.map((e) => e.event)).toContainEqual(event)
  })

  it('ignores a late presence for another roomId but still records the event', () => {
    const { client, last } = enteredHarness()
    const before = client.getSnapshot().room
    const event = presenceEvent({ change: 'moved-in', announce: true }, roomA.roomId + 1)
    last().emit(event)
    expect(client.getSnapshot().room).toBe(before)
    expect(client.getSnapshot().events.map((e) => e.event)).toContainEqual(event)
  })

  it('adds an announced arrival to occupants and notices for the current room', () => {
    const { client, last } = enteredHarness()
    last().emit(presenceEvent({ change: 'moved-in', announce: true }))
    const room = client.getSnapshot().room
    expect(room?.occupants).toEqual([...roomA.occupants, C2])
    expect(room?.notices).toEqual([ARRIVED])
  })

  it('clears notices when a world:room for a different room arrives', () => {
    const { client, last } = enteredHarness()
    last().emit(presenceEvent({ change: 'moved-in', announce: true }))
    last().emit(roomEvent(roomB))
    expect(client.getSnapshot().room?.notices).toEqual([])
  })

  it('keeps notices when a world:room for the same room arrives', () => {
    const { client, last } = enteredHarness()
    last().emit(presenceEvent({ change: 'moved-in', announce: true }))
    last().emit(roomEvent(makeRoom({ creatures: [] })))
    const room = client.getSnapshot().room
    expect(room?.notices).toEqual([ARRIVED])
    // 스냅샷 자체는 교체된다 — 점유자는 서버 스냅샷 값으로 수렴한다.
    expect(room?.creatures).toEqual([])
    expect(room?.occupants).toEqual(roomA.occupants)
  })

  it.each([
    ['moved-out without direction', { change: { change: 'moved-out', announce: true } }],
    ['exited with announce true', { change: { change: 'exited', announce: true } }],
  ])('rejects a %s frame as receive-validation without touching state', (_label, patch) => {
    const { client, last } = enteredHarness()
    const before = client.getSnapshot()
    last().emitRaw(
      JSON.stringify({ ...presenceEvent({ change: 'moved-in', announce: true }), ...patch }),
    )
    const after = client.getSnapshot()
    expect(after.errors.map((e) => e.kind)).toEqual(['receive-validation'])
    expect(after.events).toBe(before.events)
    expect(after.room).toBe(before.room)
  })

  // G3 재현 1 — 은신 도착: 목록에는 들어오지만 문장은 없다.
  it('adds a silent moved-in to occupants without a notice', () => {
    const { client, last } = enteredHarness()
    last().emit(presenceEvent({ change: 'moved-in', announce: false }))
    const room = client.getSnapshot().room
    expect(room?.occupants).toEqual([...roomA.occupants, C2])
    expect(room?.notices).toEqual([])
  })

  // G3 재현 2 — DM 투명 퇴장: 목록에서는 빠지지만 문장은 없다.
  it('removes a silent moved-out from occupants without a notice', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit(roomEvent(makeRoom({ occupants: [...roomA.occupants, C2] })))
    last().emit(presenceEvent({ change: 'moved-out', direction: '북', announce: false }))
    const room = client.getSnapshot().room
    expect(room?.occupants).toEqual(roomA.occupants)
    expect(room?.notices).toEqual([])
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
    expect(sentFrames(last())).toContainEqual({
      type: 'session:selectCharacter',
      characterId: 'c1',
    })
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
    expect(client.getSnapshot().events.map((e) => e.event)).toContainEqual({
      type: 'debug:echo:result',
      text: 'pong',
    })
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

type ErrorFrame = Extract<ServerEvent, { type: 'error' }>
type Code = ErrorFrame['code']

function errorEvent(code: Code, message = `${code} message`): ErrorFrame {
  return { type: 'error', code, message }
}

const SYSTEM_HELLO: ServerEvent = { type: 'system:hello', protocolVersion: PROTOCOL_VERSION }
const CHARACTER_LIST: ServerEvent = {
  type: 'session:characterList',
  characters: [{ characterId: 'c1', name: '타이', class: 1, race: 1, level: 1 }],
}

describe('WsClient lastError lifetime', () => {
  const COMBAT_ATTACKED: Extract<ServerEvent, { type: 'combat:attacked' }> = {
    type: 'combat:attacked',
    targetInstanceId: 'm1',
    targetName: '들쥐',
    hit: true,
    damage: 5,
    critical: false,
    fumble: false,
    died: false,
    attacks: [],
  }

  // 해제 이벤트 7종 — 전부 serverEventSchema를 통과해야 한다(통과하지 않으면 receive-validation으로
  // 빠져 해제가 아닌 이유로 실패한다). 아래 'payload fixtures' 케이스가 이를 단정한다.
  const CLEARING_EVENTS: readonly [string, ServerEvent][] = [
    ['world:room', roomEvent(makeRoom())],
    ['session:prompt', { type: 'session:prompt', promptId: 'create:class', kind: 'createField' }],
    ['session:entered', { type: 'session:entered', characterId: 'c1' }],
    ['session:resumed', { type: 'session:resumed', characterId: 'c1' }],
    [
      'progress:trained',
      {
        type: 'progress:trained',
        level: 2,
        levelsGained: 1,
        experience: 100,
        gold: 50,
        hpCurrent: 30,
        mpCurrent: 10,
        stats: [10, 11, 12, 13, 14],
        prestige: 'none',
      },
    ],
    [
      'progress:studied',
      {
        type: 'progress:studied',
        spellNo: 3,
        spellName: '화염',
        spells: Array.from({ length: 16 }, () => 0),
        consumedObjectId: 'o1',
      },
    ],
    ['combat:attacked', COMBAT_ATTACKED],
  ]

  const WORLD_PRESENCE: ServerEvent = {
    type: 'world:presence',
    roomId: makeRoom().roomId,
    subject: { kind: 'player', characterId: 'c2', name: '개발전사' },
    change: { change: 'moved-in', announce: true },
  }

  // 해제 집합에서 제외된 비오류 이벤트 7종.
  const NON_CLEARING_EVENTS: readonly [string, ServerEvent][] = [
    ['world:presence', WORLD_PRESENCE],
    ['chat:said', { type: 'chat:said', channel: 'say', speakerCharacterId: 'c2', text: '안녕' }],
    [
      'character:stats',
      {
        type: 'character:stats',
        hpCurrent: 20,
        hpMax: 30,
        mpCurrent: 5,
        mpMax: 10,
        experience: 100,
        level: 2,
      },
    ],
    ['system:hello', SYSTEM_HELLO],
    ['system:reload', { type: 'system:reload', reason: '월드 리로드' }],
    ['debug:echo:result', { type: 'debug:echo:result', text: 'pong' }],
    ['session:characterList', CHARACTER_LIST],
  ]

  // 연결·open을 마치고, world:room으로 방을 세운 뒤 선행 오류를 받은 하네스.
  function harnessWithError(code: Code | null) {
    const h = makeHarness()
    h.client.connect()
    h.last().fireOpen()
    h.last().emit(roomEvent(makeRoom()))
    if (code !== null) h.last().emit(errorEvent(code))
    return h
  }

  function lastErrorCode(client: WsClient): Code | null {
    return client.getSnapshot().session.lastError?.code ?? null
  }

  // 유지 사례 — 오류 유지와 함께 정상 수신(새 errors 없음, events 마지막 type 일치)을 단정한다.
  function expectRetainedWithNormalReceive(
    h: ReturnType<typeof makeHarness>,
    event: ServerEvent,
    code: Code,
  ): void {
    const errorsBefore = h.client.getSnapshot().errors.length
    h.last().emit(event)
    const after = h.client.getSnapshot()
    expect(after.errors).toHaveLength(errorsBefore)
    expect(after.events[after.events.length - 1]?.event.type).toBe(event.type)
    expect(after.session.lastError?.code).toBe(code)
  }

  it.each([...CLEARING_EVENTS, ...NON_CLEARING_EVENTS])(
    'payload fixture %s passes serverEventSchema',
    (_type, event) => {
      expect(serverEventSchema.safeParse(event).success).toBe(true)
    },
  )

  it.each(CLEARING_EVENTS.map(([t, e], i) => [`A${i + 1}`, t, e] as const))(
    '%s clears a transient rule_rejected on %s',
    (_id, _type, event) => {
      const { client, last } = harnessWithError('rule_rejected')
      expect(lastErrorCode(client)).toBe('rule_rejected')
      last().emit(event)
      expect(client.getSnapshot().session.lastError).toBeNull()
    },
  )

  it.each(CLEARING_EVENTS.map(([t, e], i) => [`B${i + 1}`, t, e] as const))(
    '%s keeps a sticky unauthorized on %s',
    (_id, _type, event) => {
      const h = harnessWithError('unauthorized')
      expectRetainedWithNormalReceive(h, event, 'unauthorized')
    },
  )

  it('B8 keeps a sticky forbidden on world:room', () => {
    const h = harnessWithError('forbidden')
    expectRetainedWithNormalReceive(h, roomEvent(makeRoom()), 'forbidden')
  })

  it.each(NON_CLEARING_EVENTS.map(([t, e], i) => [`C${i + 1}`, t, e] as const))(
    '%s keeps a transient rule_rejected on non-clearing %s',
    (_id, _type, event) => {
      const h = harnessWithError('rule_rejected')
      expectRetainedWithNormalReceive(h, event, 'rule_rejected')
    },
  )

  it('C1b world:presence actually applies to the current room while keeping rule_rejected', () => {
    const { client, last } = harnessWithError('rule_rejected')
    last().emit(WORLD_PRESENCE)
    expect(client.getSnapshot().room?.occupants).toContainEqual({
      characterId: 'c2',
      name: '개발전사',
    })
    expect(lastErrorCode(client)).toBe('rule_rejected')
  })

  it('D1 replaces a transient rule_rejected with a newer transient session_state', () => {
    const { client, last } = harnessWithError('rule_rejected')
    last().emit(errorEvent('session_state', 'bad state'))
    expect(client.getSnapshot().session.lastError).toEqual({
      code: 'session_state',
      message: 'bad state',
    })
  })

  it('D2 does not overwrite a sticky unauthorized with a transient rule_rejected', () => {
    const { client, last } = harnessWithError('unauthorized')
    last().emit(errorEvent('rule_rejected'))
    expect(client.getSnapshot().session.lastError).toEqual({
      code: 'unauthorized',
      message: 'unauthorized message',
    })
  })

  it('D3 replaces a sticky unauthorized with a newer sticky forbidden', () => {
    const { client, last } = harnessWithError('unauthorized')
    last().emit(errorEvent('forbidden', 'no rights'))
    expect(client.getSnapshot().session.lastError).toEqual({
      code: 'forbidden',
      message: 'no rights',
    })
  })

  it('D4 replaces a transient rule_rejected with a sticky forbidden', () => {
    const { client, last } = harnessWithError('rule_rejected')
    last().emit(errorEvent('forbidden'))
    expect(lastErrorCode(client)).toBe('forbidden')
  })

  it('D5 sets unauthorized when there is no previous lastError', () => {
    const { client, last } = harnessWithError(null)
    expect(client.getSnapshot().session.lastError).toBeNull()
    last().emit(errorEvent('unauthorized'))
    expect(lastErrorCode(client)).toBe('unauthorized')
  })

  it('E1 clears a session_state error on the next createField prompt', () => {
    const { client, last } = makeHarness()
    client.connect()
    last().fireOpen()
    last().emit({ type: 'session:prompt', promptId: 'create:name', kind: 'createField' })
    last().emit(errorEvent('session_state', 'bad name'))
    expect(lastErrorCode(client)).toBe('session_state')
    last().emit({ type: 'session:prompt', promptId: 'create:class', kind: 'createField' })
    const session = client.getSnapshot().session
    expect(session.lastError).toBeNull()
    expect(session.activePrompt?.promptId).toBe('create:class')
  })

  // E2·E3 — 재연결 시퀀스를 단계별로 진행하며 각 단계의 lastError를 단정한다.
  function runReconnectSequence(code: Code, expectedAfterPrompt: Code | null): void {
    const { client, created, last } = harnessWithError(code)
    client.reconnect()
    expect(created).toHaveLength(2)
    last().fireOpen()
    expect(lastErrorCode(client)).toBe(code)
    last().emit(SYSTEM_HELLO)
    expect(lastErrorCode(client)).toBe(code)
    last().emit(CHARACTER_LIST)
    expect(lastErrorCode(client)).toBe(code)
    last().emit({ type: 'session:prompt', promptId: 'select', kind: 'selectCharacter' })
    expect(lastErrorCode(client)).toBe(expectedAfterPrompt)
  }

  it('E2 keeps rule_rejected through reconnect until the selectCharacter prompt clears it', () => {
    runReconnectSequence('rule_rejected', null)
  })

  it('E3 keeps unauthorized through the whole reconnect sequence including the prompt', () => {
    runReconnectSequence('unauthorized', 'unauthorized')
  })

  it('E4 clears rule_rejected after combat:attacked followed by world:room (kill success)', () => {
    const { client, last } = harnessWithError('rule_rejected')
    last().emit({ ...COMBAT_ATTACKED, died: true })
    last().emit(roomEvent(makeRoom({ creatures: [] })))
    expect(client.getSnapshot().session.lastError).toBeNull()
  })

  it('F1 does not replace the session object on combat:attacked when lastError is null', () => {
    const { client, last } = harnessWithError(null)
    const before = client.getSnapshot().session
    last().emit(COMBAT_ATTACKED)
    expect(client.getSnapshot().session).toBe(before)
  })

  it('F2 does not replace the session object on combat:attacked when lastError is sticky', () => {
    const { client, last } = harnessWithError('unauthorized')
    const before = client.getSnapshot().session
    last().emit(COMBAT_ATTACKED)
    expect(client.getSnapshot().session).toBe(before)
  })
})

describe('WsClient dismissError', () => {
  function connectedWithError(code: 'rule_rejected' | 'unauthorized' | null) {
    const h = makeHarness()
    h.client.connect()
    h.last().fireOpen()
    if (code !== null) h.last().emit(errorEvent(code))
    return h
  }

  it.each(['rule_rejected', 'unauthorized'] as const)(
    'clears a %s lastError regardless of lifetime',
    (code) => {
      const { client } = connectedWithError(code)
      client.dismissError()
      expect(client.getSnapshot().session.lastError).toBeNull()
    },
  )

  it('does not notify listeners or replace the snapshot when lastError is null', () => {
    const { client } = connectedWithError(null)
    const listener = vi.fn()
    client.subscribe(listener)
    const before = client.getSnapshot()
    client.dismissError()
    expect(listener).toHaveBeenCalledTimes(0)
    expect(client.getSnapshot()).toBe(before)
  })

  it('leaves a previously held snapshot untouched and hands out a new session object', () => {
    const { client } = connectedWithError('rule_rejected')
    const before = client.getSnapshot()
    client.dismissError()
    const after = client.getSnapshot()
    expect(before.session.lastError).toEqual({
      code: 'rule_rejected',
      message: 'rule_rejected message',
    })
    expect(after.session).not.toBe(before.session)
    expect(after.session.lastError).toBeNull()
  })
})

describe('WsClient event log bound', () => {
  // connect→fireOpen 뒤 world:room을 count건 흘려보낸다.
  function emitRooms(h: ReturnType<typeof makeHarness>, count: number): void {
    for (let i = 0; i < count; i++) h.last().emit(roomEvent(makeRoom()))
  }

  function openHarness(): ReturnType<typeof makeHarness> {
    const h = makeHarness()
    h.client.connect()
    h.last().fireOpen()
    return h
  }

  it('exports the log and error limits', () => {
    expect(EVENT_LOG_LIMIT).toBe(200)
    expect(TRANSPORT_ERROR_LIMIT).toBe(50)
  })

  it('keeps only the latest EVENT_LOG_LIMIT events with contiguous seq after 1000 events', () => {
    const h = openHarness()
    emitRooms(h, 1000)
    const events = h.client.getSnapshot().events
    // 길이 200, 첫 seq 800, 마지막 seq 999, 인접 차이 1을 한 번에 단정한다.
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 200 }, (_, i) => 800 + i))
    expect(events.every((e) => e.event.type === 'world:room')).toBe(true)
  })

  it('preserves seq and reference of retained entries when the oldest one is dropped', () => {
    const h = openHarness()
    emitRooms(h, 200)
    const second = h.client.getSnapshot().events[1]
    expect(second?.seq).toBe(1)
    emitRooms(h, 1)
    const after = h.client.getSnapshot().events
    expect(after).toHaveLength(200)
    expect(after[0]).toBe(second)
    expect(after[0]?.seq).toBe(1)
  })

  it('continues seq across reconnect without clearing the log', () => {
    const h = openHarness()
    emitRooms(h, 3)
    const beforeReconnect = h.client.getSnapshot().events
    h.client.reconnect()
    h.last().fireOpen()
    emitRooms(h, 3)
    const events = h.client.getSnapshot().events
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    beforeReconnect.forEach((entry, i) => expect(events[i]).toBe(entry))
  })

  it('keeps only the latest TRANSPORT_ERROR_LIMIT errors in arrival order', () => {
    const h = openHarness()
    const validCommand = { type: 'debug:echo', text: 'x' }
    h.last().fireError()
    for (let i = 0; i < 25; i++) h.last().emitRaw('}{')
    h.client.disconnect()
    for (let i = 0; i < 24; i++) h.client.send(validCommand)

    const atLimit = h.client.getSnapshot().errors
    expect(atLimit).toHaveLength(50)
    expect(atLimit[0]?.kind).toBe('socket')

    h.client.send(validCommand)
    const errors = h.client.getSnapshot().errors
    expect(errors).toHaveLength(50)
    expect(errors.map((e) => e.kind)).toEqual([
      ...Array<string>(25).fill('parse'),
      ...Array<string>(25).fill('not-connected'),
    ])
    for (let i = 0; i < 49; i++) expect(errors[i]).toBe(atLimit[i + 1])
    // 51번째 오류는 클라이언트 안에서 만들어져 미리 잡을 참조가 없으므로, 새 객체임만 단정한다.
    expect(atLimit).not.toContain(errors[49])
  })
})
