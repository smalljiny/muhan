import { describe, it, expect, vi } from 'vitest'
import type { WebSocket } from 'ws'
import {
  createConnectionContext,
  cleanupConnection,
  type ConnectionContext,
  type IdleTimer,
} from './connection.js'
import type { Deadline } from './deadline.js'

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
