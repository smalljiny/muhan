import { describe, it, expect } from 'vitest'
import { buildApp } from './app.js'

describe('buildApp /health', () => {
  it('GET /health가 200과 {status:"ok"}를 반환한다', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })

    await app.close()
  })
})
