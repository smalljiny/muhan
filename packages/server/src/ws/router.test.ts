import { describe, it, expect, vi } from 'vitest'
import { dispatch, createCommandRegistry, type HandlerRegistry } from './router.js'
import { echoHandler } from './handlers/echo.js'
import type { ActorContext } from './actorContext.js'
import type { ChannelPort } from './channelPort.js'

// dispatch/echoHandler 시그니처에 추가된 actor 인자용 fixture. 이 스펙에서 actor는 inert(무영향)이며,
// 레이어 순서·correlationId 반향·Map 안전성·echo 왕복 단언은 actor 값과 무관하게 성립한다.
const testActor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

// createCommandRegistry가 요구하는 ChannelPort fixture. 이 스펙은 debug:echo 디스패치 레이어만
// 검증하므로 채널 포트는 inert(무영향)다 — deliver는 호출되지 않는다.
const testChannelPort: ChannelPort = { deliver: () => {} }

// T6.5 — 라우터 디스패치의 순수 단위 스펙. 소켓 I/O 없이 결정적으로 검증한다.
// 레이어링(allowlist → payload → 예외 격리), correlationId 반향, Map 안전성, echo 왕복을 커버한다.
// T2.4 — dispatch 반환이 DispatchResult로 승격되어 outcome('handled'|'rejected')·event 구조로 검증한다.
describe('dispatch', () => {
  describe('allowlist 가드 (Map 기반)', () => {
    it('미등록 type은 rejected{unknown_type}로 차단하고 디스패치하지 않는다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'system:teleport', text: '핑' }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it('type 필드가 없는 프레임은 rejected{unknown_type}로 차단한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { foo: 1 }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it.each([['__proto__'], ['constructor'], ['prototype']])(
      'prototype-chain type(%s)은 실제 Map lookup이라 rejected{unknown_type}로 차단한다',
      (type) => {
        const result = dispatch(createCommandRegistry(testChannelPort), { type, text: '핑' }, testActor)
        expect(result.outcome).toBe('rejected')
        expect(result.event).toMatchObject({ type: 'error', code: 'unknown_type' })
      },
    )

    it('type이 문자열이 아니면(숫자) rejected{unknown_type}로 차단한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 123, text: '핑' }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({ type: 'error', code: 'unknown_type' })
    })

    it('unknown_type 응답은 correlationId를 싣지 않는다 (type 판별 이전이라 id 미추출)', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'nope', id: 'c1' }, testActor)
      expect(result.event).not.toHaveProperty('correlationId')
    })
  })

  describe('payload 검증 (등록된 type + 잘못된 payload)', () => {
    it('등록된 type이지만 payload 위반(text 누락)은 rejected{bad_payload}로 응답한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo' }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({ type: 'error', code: 'bad_payload' })
    })

    it('bad_payload 응답은 id가 있으면 correlationId로 반향한다 (payload 검증 이전 추출)', () => {
      // text=''는 min(1) 위반이지만 id는 유효 문자열 → 실패를 상관지을 수 있게 반향한다.
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '', id: 'c7' }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({
        type: 'error',
        code: 'bad_payload',
        correlationId: 'c7',
      })
    })

    it('bad_payload 응답은 id가 없으면 correlationId 키를 생략한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '' }, testActor)
      expect(result.event).toMatchObject({ type: 'error', code: 'bad_payload' })
      expect(result.event).not.toHaveProperty('correlationId')
    })

    it('id가 문자열이 아니면(숫자) correlationId 키를 생략한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '', id: 42 }, testActor)
      expect(result.event).toMatchObject({ type: 'error', code: 'bad_payload' })
      expect(result.event).not.toHaveProperty('correlationId')
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

    it('핸들러 throw는 rejected{internal}로 격리한다', () => {
      const result = dispatch(throwingRegistry(), { type: 'debug:echo', text: '핑' }, testActor)
      expect(result.outcome).toBe('rejected')
      expect(result.event).toMatchObject({ type: 'error', code: 'internal' })
    })

    it('internal 응답은 id가 있으면 correlationId로 반향한다', () => {
      const result = dispatch(throwingRegistry(), { type: 'debug:echo', text: '핑', id: 'c9' }, testActor)
      expect(result.event).toMatchObject({ type: 'error', code: 'internal', correlationId: 'c9' })
    })
  })

  describe('echo 왕복', () => {
    it('debug:echo{text}는 handled{debug:echo:result{text}}로 되돌린다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '핑' }, testActor)
      expect(result.outcome).toBe('handled')
      expect(result.event).toEqual({ type: 'debug:echo:result', text: '핑' })
    })

    it('id가 있으면 correlationId로 반향한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '핑', id: 'c1' }, testActor)
      expect(result.outcome).toBe('handled')
      expect(result.event).toEqual({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })
    })

    it('id가 없으면 correlationId 키를 생략한다', () => {
      const result = dispatch(createCommandRegistry(testChannelPort), { type: 'debug:echo', text: '핑' }, testActor)
      expect(result.event).not.toHaveProperty('correlationId')
    })
  })

  describe('fire-and-forget 핸들러', () => {
    it('핸들러가 undefined를 반환해도 outcome은 handled이고 event는 undefined다', () => {
      const fireAndForgetRegistry: HandlerRegistry = new Map([['debug:echo', () => undefined]])
      const result = dispatch(fireAndForgetRegistry, { type: 'debug:echo', text: '핑' }, testActor)
      expect(result).toEqual({ outcome: 'handled', event: undefined })
    })
  })

  describe('chat variant 통합 (레지스트리 엔트리 ↔ 스키마 variant 일치)', () => {
    // 등록 type에 스키마 variant가 없으면 safeParse가 매칭 실패해 영구 bad_payload로 떨어진다.
    // 이 스펙은 chat:message·chat:emote가 스키마·레지스트리 양쪽에 함께 랜딩했음을 dispatch 경로로 고정한다.
    it('chat:message가 handled로 디스패치되고 채널 포트로 핸드오프된다', () => {
      const deliver = vi.fn()
      const registry = createCommandRegistry({ deliver })
      const result = dispatch(registry, { type: 'chat:message', channel: 'say', text: 'x' }, testActor)
      expect(result.outcome).toBe('handled')
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(deliver).toHaveBeenCalledWith({ speaker: testActor, channel: 'say', text: 'x' })
    })

    it('chat:emote가 handled로 디스패치되고 channel=emote로 핸드오프된다', () => {
      const deliver = vi.fn()
      const registry = createCommandRegistry({ deliver })
      const result = dispatch(registry, { type: 'chat:emote', emote: '웃음' }, testActor)
      expect(result.outcome).toBe('handled')
      expect(deliver).toHaveBeenCalledWith({ speaker: testActor, channel: 'emote', text: '웃음' })
    })
  })

  describe('actor seam', () => {
    // Story 1의 유일한 산출물은 dispatch→handler로 actor를 전달하는 seam이다. echo는 actor를 무시하므로
    // 행위로 드러나지 않고 tsc는 인자 존재만 강제한다 — capturing 핸들러로 built actor가 그대로 전달되는
    // 계약을 값 단위로 고정한다(Story 2~3가 소비할 foundation seam lock).
    it('dispatch가 built actor를 핸들러 2번째 인자로 그대로 전달한다', () => {
      let received: ActorContext | undefined
      const capturingRegistry: HandlerRegistry = new Map([
        [
          'debug:echo',
          (_command, actor) => {
            received = actor
            return undefined
          },
        ],
      ])
      dispatch(capturingRegistry, { type: 'debug:echo', text: '핑' }, testActor)
      expect(received).toBe(testActor)
    })
  })
})

// echoHandler 직접 단위 — 디스패처가 판별한 뒤에만 도달하지만, narrow의 양 갈래를 결정적으로 고정한다.
describe('echoHandler', () => {
  it('debug:echo를 debug:echo:result로 되돌린다', () => {
    expect(echoHandler({ type: 'debug:echo', text: '퐁' }, testActor)).toEqual({
      type: 'debug:echo:result',
      text: '퐁',
    })
  })

  it('id를 correlationId로 반향한다', () => {
    expect(echoHandler({ type: 'debug:echo', text: '퐁', id: 'x1' }, testActor)).toEqual({
      type: 'debug:echo:result',
      text: '퐁',
      correlationId: 'x1',
    })
  })

  it('debug:echo가 아닌 명령은 undefined (구조적으로 도달 불가한 방어 갈래)', () => {
    expect(echoHandler({ type: 'system:ready', protocolVersion: 1 }, testActor)).toBeUndefined()
  })
})
