import { describe, it, expect } from 'vitest'
import {
  errorCodeSchema,
  serverEventSchema,
  type ErrorCode,
  type ServerEvent,
} from 'shared/protocol'
import {
  CLEARS_TRANSIENT_ERROR,
  ERROR_LIFETIME,
  clearsTransientError,
  isStickyError,
  type ErrorLifetime,
} from './errorLifetime.js'

const EXPECTED_LIFETIMES: ReadonlyArray<readonly [ErrorCode, ErrorLifetime]> = [
  ['handshake_required', 'transient'],
  ['unknown_type', 'transient'],
  ['bad_payload', 'transient'],
  ['internal', 'transient'],
  ['unauthorized', 'sticky'],
  ['session_state', 'transient'],
  ['forbidden', 'sticky'],
  ['rate_limited', 'transient'],
  ['rule_rejected', 'transient'],
]

const CLEARING_TYPES: ReadonlyArray<ServerEvent['type']> = [
  'world:room',
  'session:prompt',
  'session:entered',
  'session:resumed',
  'progress:trained',
  'progress:studied',
  'combat:attacked',
]

const NON_CLEARING_TYPES: ReadonlyArray<ServerEvent['type']> = [
  'world:presence',
  'chat:said',
  'character:stats',
  'combat:round',
  'system:hello',
  'system:reload',
  'debug:echo:result',
  'session:characterList',
  'error',
]

describe('ERROR_LIFETIME', () => {
  it.each(EXPECTED_LIFETIMES)('%s 코드는 %s 수명이다', (code, lifetime) => {
    expect(ERROR_LIFETIME[code]).toBe(lifetime)
  })

  it('분류표 키 집합이 errorCodeSchema의 코드 집합과 같다', () => {
    expect(Object.keys(ERROR_LIFETIME).sort()).toEqual([...errorCodeSchema.options].sort())
  })
})

describe('isStickyError', () => {
  it.each(EXPECTED_LIFETIMES)('%s 코드(%s)의 sticky 여부가 분류표와 일치한다', (code, lifetime) => {
    expect(isStickyError(code)).toBe(lifetime === 'sticky')
  })
})

describe('clearsTransientError', () => {
  it.each(CLEARING_TYPES)('%s 이벤트는 일시 오류를 해제한다', (type) => {
    expect(clearsTransientError(type)).toBe(true)
  })

  it.each(NON_CLEARING_TYPES)('%s 이벤트는 일시 오류를 해제하지 않는다', (type) => {
    expect(clearsTransientError(type)).toBe(false)
  })
})

describe('CLEARS_TRANSIENT_ERROR', () => {
  it('키 집합이 serverEventSchema의 type 리터럴 집합과 같다', () => {
    const schemaTypes = serverEventSchema.options.map((option) => option.shape.type.value)
    expect(Object.keys(CLEARS_TRANSIENT_ERROR).sort()).toEqual([...schemaTypes].sort())
  })

  it('포함·제외 목록이 이벤트 타입 전체를 빠짐없이 나눈다', () => {
    expect([...CLEARING_TYPES, ...NON_CLEARING_TYPES].sort()).toEqual(
      Object.keys(CLEARS_TRANSIENT_ERROR).sort(),
    )
  })
})
