import { describe, it, expect } from 'vitest'
import { dispatch, createCommandRegistry, type HandlerRegistry } from './router.js'
import { echoHandler } from './handlers/echo.js'

// T6.5 — 라우터 디스패치의 순수 단위 스펙. 소켓 I/O 없이 결정적으로 검증한다.
// 레이어링(allowlist → payload → 예외 격리), correlationId 반향, Map 안전성, echo 왕복을 커버한다.
describe('dispatch', () => {
  describe('allowlist 가드 (Map 기반)', () => {
    it('미등록 type은 error{unknown_type}로 차단하고 디스패치하지 않는다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'system:teleport', text: '핑' })
      expect(event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it('type 필드가 없는 프레임은 error{unknown_type}로 차단한다', () => {
      const event = dispatch(createCommandRegistry(), { foo: 1 })
      expect(event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it.each([['__proto__'], ['constructor'], ['prototype']])(
      'prototype-chain type(%s)은 실제 Map lookup이라 error{unknown_type}로 차단한다',
      (type) => {
        const event = dispatch(createCommandRegistry(), { type, text: '핑' })
        expect(event).toMatchObject({ type: 'error', code: 'unknown_type' })
      },
    )

    it('type이 문자열이 아니면(숫자) error{unknown_type}로 차단한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 123, text: '핑' })
      expect(event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it('unknown_type 응답은 correlationId를 싣지 않는다 (type 판별 이전이라 id 미추출)', () => {
      const event = dispatch(createCommandRegistry(), { type: 'nope', id: 'c1' })
      expect(event).not.toHaveProperty('correlationId')
    })
  })

  describe('payload 검증 (등록된 type + 잘못된 payload)', () => {
    it('등록된 type이지만 payload 위반(text 누락)은 error{bad_payload}로 응답한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo' })
      expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
    })

    it('bad_payload 응답은 id가 있으면 correlationId로 반향한다 (payload 검증 이전 추출)', () => {
      // text=''는 min(1) 위반이지만 id는 유효 문자열 → 실패를 상관지을 수 있게 반향한다.
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '', id: 'c7' })
      expect(event).toMatchObject({ type: 'error', code: 'bad_payload', correlationId: 'c7' })
    })

    it('bad_payload 응답은 id가 없으면 correlationId 키를 생략한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '' })
      expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
      expect(event).not.toHaveProperty('correlationId')
    })

    it('id가 문자열이 아니면(숫자) correlationId 키를 생략한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '', id: 42 })
      expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
      expect(event).not.toHaveProperty('correlationId')
    })
  })

  describe('핸들러 예외 격리', () => {
    const throwingRegistry = (): HandlerRegistry =>
      new Map([
        [
          'debug:echo',
          () => {
            throw new Error('handler boom')
          },
        ],
      ])

    it('핸들러 throw는 error{internal}로 격리한다', () => {
      const event = dispatch(throwingRegistry(), { type: 'debug:echo', text: '핑' })
      expect(event).toMatchObject({ type: 'error', code: 'internal' })
    })

    it('internal 응답은 id가 있으면 correlationId로 반향한다', () => {
      const event = dispatch(throwingRegistry(), { type: 'debug:echo', text: '핑', id: 'c9' })
      expect(event).toMatchObject({ type: 'error', code: 'internal', correlationId: 'c9' })
    })
  })

  describe('echo 왕복', () => {
    it('debug:echo{text}는 debug:echo:result{text}로 되돌린다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '핑' })
      expect(event).toEqual({ type: 'debug:echo:result', text: '핑' })
    })

    it('id가 있으면 correlationId로 반향한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '핑', id: 'c1' })
      expect(event).toEqual({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })
    })

    it('id가 없으면 correlationId 키를 생략한다', () => {
      const event = dispatch(createCommandRegistry(), { type: 'debug:echo', text: '핑' })
      expect(event).not.toHaveProperty('correlationId')
    })
  })
})

// echoHandler 직접 단위 — 디스패처가 판별한 뒤에만 도달하지만, narrow의 양 갈래를 결정적으로 고정한다.
describe('echoHandler', () => {
  it('debug:echo를 debug:echo:result로 되돌린다', () => {
    expect(echoHandler({ type: 'debug:echo', text: '퐁' })).toEqual({
      type: 'debug:echo:result',
      text: '퐁',
    })
  })

  it('id를 correlationId로 반향한다', () => {
    expect(echoHandler({ type: 'debug:echo', text: '퐁', id: 'x1' })).toEqual({
      type: 'debug:echo:result',
      text: '퐁',
      correlationId: 'x1',
    })
  })

  it('debug:echo가 아닌 명령은 undefined (구조적으로 도달 불가한 방어 갈래)', () => {
    expect(echoHandler({ type: 'system:ready', protocolVersion: 1 })).toBeUndefined()
  })
})
