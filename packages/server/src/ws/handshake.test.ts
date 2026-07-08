import { describe, it, expect } from 'vitest'
import { PROTOCOL_VERSION } from 'shared'
import { handleHandshakeFrame } from './handshake.js'
import { createConnectionContext, type ConnectionContext } from './connection.js'

// T4.4 — 핸드셰이크 상태 전이표의 단위 스펙. 소켓 I/O 없이 순수 함수로 전이를 고정한다.
// 서버 버전 권위 대조(client === server)·pre-ready 게이트·중복 ready·post-ready pass-through를 모두 커버한다.
describe('handleHandshakeFrame', () => {
  const pending = (): ConnectionContext => createConnectionContext()
  const established = (): ConnectionContext => ({ ...createConnectionContext(), ready: true })

  it('pre-ready + 버전 일치 system:ready → accept', () => {
    const result = handleHandshakeFrame(pending(), {
      type: 'system:ready',
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(result).toEqual({ action: 'accept' })
  })

  it('pre-ready + 버전 불일치 system:ready → reload 이벤트', () => {
    const result = handleHandshakeFrame(pending(), {
      type: 'system:ready',
      protocolVersion: PROTOCOL_VERSION + 1,
    })
    expect(result.action).toBe('reload')
    if (result.action === 'reload') {
      expect(result.event.type).toBe('system:reload')
      if (result.event.type === 'system:reload') {
        expect(result.event.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('pre-ready + protocolVersion 누락 system:ready → reload (정확 대조라 불일치 취급)', () => {
    const result = handleHandshakeFrame(pending(), { type: 'system:ready' })
    expect(result.action).toBe('reload')
  })

  it('pre-ready + 문자열 protocolVersion → reload (타입 불일치도 정확 대조로 불일치)', () => {
    const result = handleHandshakeFrame(pending(), {
      type: 'system:ready',
      protocolVersion: String(PROTOCOL_VERSION),
    })
    expect(result.action).toBe('reload')
  })

  it('pre-ready + system:ready 아닌 명령 → handshake_required error', () => {
    const result = handleHandshakeFrame(pending(), { type: 'debug:echo', text: '핑' })
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.event).toMatchObject({ type: 'error', code: 'handshake_required' })
    }
  })

  it('pre-ready + type 없는 객체 → handshake_required error', () => {
    const result = handleHandshakeFrame(pending(), { foo: 1 })
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.event).toMatchObject({ type: 'error', code: 'handshake_required' })
    }
  })

  // 적대적 입력: 유효 JSON이지만 객체가 아닌 top-level 형태(null·원시값·배열)도 message 핸들러에
  // 도달한다. frameType의 non-object/null 가드가 throw 없이 handshake_required로 수렴해야 한다
  // — 이 회귀 핀이 없으면 null 가드를 떨어뜨리는 리팩터가 'type' in null throw를 되살린다.
  it.each([
    ['null', null],
    ['숫자', 42],
    ['문자열', 'system:ready'],
    ['불리언', true],
    ['배열', []],
  ])('pre-ready + 비객체 top-level JSON(%s) → handshake_required error', (_label, parsed) => {
    const result = handleHandshakeFrame(pending(), parsed)
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.event).toMatchObject({ type: 'error', code: 'handshake_required' })
    }
  })

  it('ready 이후 중복 system:ready → error (첫 메시지로만 유효)', () => {
    const result = handleHandshakeFrame(established(), {
      type: 'system:ready',
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.event.type).toBe('error')
    }
  })

  it('ready 이후 일반 명령 → pass (Story 6 라우터로 넘김)', () => {
    const result = handleHandshakeFrame(established(), { type: 'debug:echo', text: '핑' })
    expect(result).toEqual({ action: 'pass' })
  })
})
