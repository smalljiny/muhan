import { describe, it, expect } from 'vitest'
import { buildApp } from '../app.js'

/** Set-Cookie 헤더를 단일 문자열로 정규화한다(Fastify가 string 또는 string[]로 준다). */
function firstSetCookie(header: string | string[] | undefined): string {
  if (header === undefined) return ''
  return Array.isArray(header) ? (header[0] ?? '') : header
}

describe('dev 로그인 라우트 게이팅', () => {
  it('devLoginSeedCookie 미주입이면 /dev/login이 마운트되지 않는다(404)', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/dev/login' })

    expect(res.statusCode).toBe(404)

    await app.close()
  })

  it('devLoginSeedCookie 주입이면 /dev/login이 200으로 응답한다', async () => {
    const app = buildApp({ devLoginSeedCookie: 'dev-seed-cookie' })
    const res = await app.inject({ method: 'GET', url: '/dev/login' })

    expect(res.statusCode).toBe(200)

    await app.close()
  })

  it('/dev/login이 __session 쿠키를 시드 값으로 Set-Cookie한다', async () => {
    const app = buildApp({ devLoginSeedCookie: 'dev-seed-cookie' })
    const res = await app.inject({ method: 'GET', url: '/dev/login' })

    const setCookie = firstSetCookie(res.headers['set-cookie'])
    expect(setCookie).toContain('__session=dev-seed-cookie')

    await app.close()
  })

  it('Set-Cookie는 Path=/ 이며 Secure 속성이 없다(dev 평문 loopback 첨부)', async () => {
    const app = buildApp({ devLoginSeedCookie: 'dev-seed-cookie' })
    const res = await app.inject({ method: 'GET', url: '/dev/login' })

    const setCookie = firstSetCookie(res.headers['set-cookie'])
    expect(setCookie).toMatch(/;\s*Path=\//i)
    expect(setCookie).not.toMatch(/;\s*Secure/i)

    await app.close()
  })
})
