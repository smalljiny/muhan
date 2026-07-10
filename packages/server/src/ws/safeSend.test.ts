import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { WebSocket } from 'ws'
import type { ServerEvent } from 'shared'
import { createSafeSend } from './plugin.js'
import { resetConfigForTests } from '../config/env.js'

// T4.2 — safeSend backpressure·전송오류 단위 스펙. 가짜 소켓을 주입해 backpressure 분기(1013 close)·
// 전송 오류 콜백(codeless close)·OPEN 가드를 관찰한다. getConfig()가 전체 EnvSchema를 파싱하므로
// no-default 필드(MONGODB_URI·WS_ALLOWED_ORIGINS)를 채워 process.exit fail-fast를 피한다.

const OPEN = 1 as const

// getConfig가 캐시하기 전에 process.env를 세팅하므로 loose 타입 fake logger로 충분하다(.error만 소비).
function createFakeLog(): FastifyBaseLogger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'info',
  }
}

// 필수 필드를 갖춘 가짜 소켓. send/close는 spy라 호출 여부·인자를 단언한다.
interface FakeSocket {
  readyState: number
  OPEN: number
  bufferedAmount: number
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function createFakeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  return {
    readyState: OPEN,
    OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

const SAMPLE_EVENT: ServerEvent = { type: 'system:hello', protocolVersion: 1 }

describe('createSafeSend', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = 'http://localhost'
    process.env.WS_MAX_BUFFERED_BYTES = '1000'
    resetConfigForTests()
  })

  afterEach(() => {
    process.env = savedEnv
    resetConfigForTests()
    vi.clearAllMocks()
  })

  it('bufferedAmount가 상한을 초과하면 1013으로 close하고 send하지 않는다', () => {
    const log = createFakeLog()
    const socket = createFakeSocket({ bufferedAmount: 1001 })

    createSafeSend(log)(socket as unknown as WebSocket, SAMPLE_EVENT)

    expect(socket.close).toHaveBeenCalledWith(1013)
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('bufferedAmount에 payload를 더해도 상한 이하이면 send하고 close하지 않는다', () => {
    const log = createFakeLog()
    // 900 + payloadBytes(<100)이 상한(1000) 이하라 hard cap을 통과한다.
    const socket = createFakeSocket({ bufferedAmount: 900 })

    createSafeSend(log)(socket as unknown as WebSocket, SAMPLE_EVENT)

    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('bufferedAmount 자체는 상한 이하지만 payload를 더하면 초과하면 1013으로 close하고 send하지 않는다', () => {
    const log = createFakeLog()
    // bufferedAmount(1000) === 상한(1000)이라 사전 직렬화 검사(>)는 통과하지만,
    // payloadBytes를 더하면 상한을 넘는다 — hard cap이 enqueue 전에 잘라야 한다.
    const socket = createFakeSocket({ bufferedAmount: 1000 })

    createSafeSend(log)(socket as unknown as WebSocket, SAMPLE_EVENT)

    expect(socket.close).toHaveBeenCalledWith(1013)
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('readyState가 OPEN이 아니면 send도 close도 하지 않는다', () => {
    const log = createFakeLog()
    const socket = createFakeSocket({ readyState: 3, bufferedAmount: 1001 })

    createSafeSend(log)(socket as unknown as WebSocket, SAMPLE_EVENT)

    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('send 콜백에 오류가 전달되면 codeless close하고 throw하지 않으며 로깅한다', () => {
    const log = createFakeLog()
    const socket = createFakeSocket({
      bufferedAmount: 0,
      send: vi.fn((_data: string, cb: (err?: Error) => void) => cb(new Error('boom'))),
    })

    expect(() =>
      createSafeSend(log)(socket as unknown as WebSocket, SAMPLE_EVENT),
    ).not.toThrow()

    expect(socket.close).toHaveBeenCalledWith()
    expect(log.error).toHaveBeenCalled()
  })
})
