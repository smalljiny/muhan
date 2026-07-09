import { describe, it, expect } from 'vitest'
import { parseCookieHeader, extractSessionCookie } from './cookies.js'

// D2 — Cookie 헤더 손수 파싱 유틸. @fastify/cookie 의존 없이 한 헤더 문자열을 파싱한다.
describe('parseCookieHeader', () => {
  it('단일 쿠키를 key→value로 파싱한다', () => {
    expect(parseCookieHeader('__session=abc')).toEqual({ __session: 'abc' })
  })

  it('여러 쿠키를 모두 파싱한다', () => {
    expect(parseCookieHeader('a=1; __session=tok; b=2')).toEqual({
      a: '1',
      __session: 'tok',
      b: '2',
    })
  })

  it('key·value의 앞뒤 공백을 trim한다', () => {
    expect(parseCookieHeader('  __session = tok ')).toEqual({ __session: 'tok' })
  })

  it('값에 포함된 = 는 첫 = 이후 전체를 값으로 보존한다', () => {
    expect(parseCookieHeader('__session=a=b=c')).toEqual({ __session: 'a=b=c' })
  })

  it('헤더가 undefined면 빈 객체를 반환한다', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
  })

  it('빈 문자열이면 빈 객체를 반환한다', () => {
    expect(parseCookieHeader('')).toEqual({})
  })

  it('= 없는 조각과 빈 key는 무시한다', () => {
    expect(parseCookieHeader('novalue; =orphan; a=1')).toEqual({ a: '1' })
  })

  it('예약 key(__proto__)는 프로토타입 오염 없이 무시한다', () => {
    const result = parseCookieHeader('__proto__=x; a=1')
    expect(result).toEqual({ a: '1' })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })
})

describe('extractSessionCookie', () => {
  it('__session 쿠키 값을 추출한다', () => {
    expect(extractSessionCookie('a=1; __session=tok')).toBe('tok')
  })

  it('__session이 없으면 undefined', () => {
    expect(extractSessionCookie('a=1; b=2')).toBeUndefined()
  })

  it('헤더가 undefined면 undefined', () => {
    expect(extractSessionCookie(undefined)).toBeUndefined()
  })

  it('빈 __session 값은 빈 문자열로 추출된다', () => {
    expect(extractSessionCookie('__session=')).toBe('')
  })
})
