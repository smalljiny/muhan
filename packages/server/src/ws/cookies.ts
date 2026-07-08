/**
 * Cookie 헤더 손수 파싱 — `@fastify/cookie` 의존 없이 단일 `Cookie` 헤더 문자열을 key→value 맵으로
 * 분해한다. WS upgrade preValidation 게이트가 `__session` 쿠키 하나만 필요로 하므로 최소 파서로 충분하다.
 *
 * 프로토타입 오염 방어: 예약 key(`__proto__`·`constructor`·`prototype`)는 무시하고, 같은 key는 첫
 * 등장만 채택한다(later-wins 오염 회피). 반환 객체는 순수 데이터 맵이다.
 */

/** 프로토타입 오염을 유발하는 예약 key. 동적 key 쓰기 전에 차단한다(security.md 관례). */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 단일 Cookie 헤더 문자열을 `{ name: value }` 맵으로 파싱한다. 헤더가 없으면 빈 객체. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out

  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key.length === 0) continue
    if (RESERVED_KEYS.has(key)) continue
    if (!Object.hasOwn(out, key)) out[key] = value
  }
  return out
}

/**
 * `Cookie` 헤더에서 `__session` 쿠키 값을 추출한다. 없으면 undefined.
 * `__session`은 Firebase Hosting 세션 쿠키 관례이며 E5 실 어댑터와 정합한다.
 */
export function extractSessionCookie(header: string | undefined): string | undefined {
  const cookies = parseCookieHeader(header)
  return Object.hasOwn(cookies, '__session') ? cookies.__session : undefined
}
