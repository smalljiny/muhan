import { describe, it, expect, vi } from 'vitest'
import type { WebSocket } from 'ws'
import {
  createConnectionContext,
  cleanupConnection,
  type ConnectionContext,
  type IdleTimer,
} from './connection.js'
import { ConnectionState } from './fsm/sessionFsm.js'
import type { Deadline } from './deadline.js'
import type { ConnectionRateLimiter } from './messageRateLimiter.js'

// cleanupConnection의 누수 방어선을 소켓 없이 단위 검증한다(플러그인 e2e는 size만 보므로 clear 회귀를
// 못 잡는다). Map 키는 fake 소켓을 WebSocket으로 캐스팅해 참조 동등성만 쓴다(메서드 미호출).

/** 참조 키로만 쓰는 fake 소켓. cleanupConnection은 소켓 메서드를 부르지 않는다. */
function fakeSocket(): WebSocket {
  return {} as unknown as WebSocket
}

/** clear를 스파이하는 fake Deadline. */
function fakeDeadline(): Deadline & { clear: ReturnType<typeof vi.fn> } {
  return { rearm: vi.fn(), clear: vi.fn() }
}

/** clear를 스파이하는 fake IdleTimer. 팩토리는 Story 6이라 여기선 슬롯 clear만 검증한다. */
function fakeIdle(): IdleTimer & { clear: ReturnType<typeof vi.fn> } {
  return { arm: vi.fn(), clear: vi.fn() }
}

/**
 * fake ConnectionRateLimiter. 슬롯 참조로만 쓴다 — cleanupConnection은 이 핸들의 메서드를 부르지 않는다
 * (계정 버킷 반납은 close 리스너 소유, cleanup은 슬롯 null화만 한다).
 */
function fakeRateLimiter(): ConnectionRateLimiter {
  return {
    check: vi.fn(() => 'accept' as const),
    shouldTerminate: vi.fn(() => false),
    peekConnectionTokens: vi.fn(() => 0),
    peekAccountTokens: vi.fn(() => 0),
  }
}

describe('cleanupConnection', () => {
  it('createConnectionContext는 deadline 슬롯을 null로 둔다', () => {
    const ctx = createConnectionContext()
    expect(ctx.deadline).toBeNull()
  })

  it('createConnectionContext는 idle 슬롯을 null로 둔다', () => {
    const ctx = createConnectionContext()
    expect(ctx.idle).toBeNull()
  })

  it('idle 슬롯이 non-null이면 clear한다(누수 방어선)', () => {
    const socket = fakeSocket()
    const idle = fakeIdle()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    ctx.heartbeat = null
    ctx.deadline = null
    ctx.idle = idle
    connections.set(socket, ctx)

    cleanupConnection(connections, socket)

    expect(idle.clear).toHaveBeenCalledTimes(1)
    expect(connections.has(socket)).toBe(false)
  })

  it('deadline 슬롯이 non-null이면 clear한 뒤 null로 비운다(누수 방어선)', () => {
    const socket = fakeSocket()
    const deadline = fakeDeadline()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    // 하트비트 분기를 격리하기 위해 heartbeat는 null로 두고 deadline만 배선한다.
    ctx.heartbeat = null
    ctx.deadline = deadline
    connections.set(socket, ctx)

    cleanupConnection(connections, socket)

    expect(deadline.clear).toHaveBeenCalledTimes(1)
    expect(ctx.deadline).toBeNull()
    expect(connections.has(socket)).toBe(false)
  })

  it('createConnectionContext는 rateLimiter 슬롯을 null로 둔다', () => {
    const ctx = createConnectionContext()
    expect(ctx.rateLimiter).toBeNull()
  })

  it('rateLimiter 슬롯이 non-null이면 null로 비운다(계정 반납은 close 리스너 소유, 슬롯만 정리)', () => {
    const socket = fakeSocket()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    // 다른 슬롯 분기를 격리하기 위해 heartbeat·deadline·idle은 null로 두고 rateLimiter만 배선한다.
    ctx.heartbeat = null
    ctx.deadline = null
    ctx.idle = null
    ctx.rateLimiter = fakeRateLimiter()
    connections.set(socket, ctx)

    cleanupConnection(connections, socket)

    // 슬롯을 null로 비운다 — releaseAccount는 여기서 부르지 않는다(별도 close 리스너 소유).
    expect(ctx.rateLimiter).toBeNull()
    expect(connections.has(socket)).toBe(false)
  })

  it('rateLimiter가 null이어도 안전하게 정리한다(idempotent 방어선)', () => {
    const socket = fakeSocket()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    ctx.heartbeat = null
    ctx.deadline = null
    ctx.idle = null
    ctx.rateLimiter = null
    connections.set(socket, ctx)

    expect(() => cleanupConnection(connections, socket)).not.toThrow()
    expect(ctx.rateLimiter).toBeNull()
    expect(connections.has(socket)).toBe(false)
  })

  it('deadline이 null이어도 안전하게 정리한다(idempotent 방어선)', () => {
    const socket = fakeSocket()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    ctx.heartbeat = null
    ctx.deadline = null
    connections.set(socket, ctx)

    expect(() => cleanupConnection(connections, socket)).not.toThrow()
    expect(connections.has(socket)).toBe(false)
  })
})

describe('create 도중 연결 종료 = 폐기 (T6.6 — mid-abort discard)', () => {
  it('create 진행 중 disconnect는 createProgress를 컨텍스트째 폐기한다 (부분 상태 미보존)', () => {
    const socket = fakeSocket()
    const connections = new Map<WebSocket, ConnectionContext>()
    const ctx = createConnectionContext()
    // 인터뷰 중반(stats 단계)에서 연결이 끊긴 상황을 모사한다 — createProgress에 부분 누적이 살아 있다.
    ctx.state = ConnectionState.create
    ctx.createProgress = {
      step: 'stats',
      collected: { name: '중도하차', gender: 1, class: 2 },
    }
    connections.set(socket, ctx)

    cleanupConnection(connections, socket)

    // createProgress는 per-connection 컨텍스트에 살고, cleanup이 컨텍스트를 맵에서 제거해 폐기한다.
    // create 상태는 세션 레지스트리에 등록되지 않으므로(월드 진입 전) 재연결 시 되살릴 부분 상태가 없다.
    expect(connections.has(socket)).toBe(false)
  })

  it('신규 연결은 항상 characterSelect·createProgress=null로 시작한다 (재연결은 인터뷰 앞에서 재시작)', () => {
    // 재연결은 새 소켓의 새 컨텍스트다 — 이전 create 부분 상태를 이어받지 않고 characterSelect부터 다시 시작한다.
    const fresh = createConnectionContext()
    expect(fresh.state).toBe(ConnectionState.characterSelect)
    expect(fresh.createProgress).toBeNull()
  })
})
