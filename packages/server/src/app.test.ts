import { describe, it, expect } from 'vitest'
import { buildApp } from './app.js'

describe('buildApp /health', () => {
  it('ping이 true면 200과 {status:"ok", db:"up"}를 반환한다', async () => {
    const app = buildApp({ pingDb: () => Promise.resolve(true) })
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', db: 'up' })

    await app.close()
  })

  it('ping이 false면 {status:"degraded", db:"down"}를 반환한다', async () => {
    const app = buildApp({ pingDb: () => Promise.resolve(false) })
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'degraded', db: 'down' })

    await app.close()
  })

  it('ping 의존성이 주입되지 않으면 degraded/down을 반환한다(DB 상태 미상=degraded)', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'degraded', db: 'down' })

    await app.close()
  })
})
