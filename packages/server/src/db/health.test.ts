import { describe, it, expect } from 'vitest'
import { type Db } from 'mongodb'
import { pingDb } from './health.js'

// pingDb는 순수 유닛으로 검증한다 — command 성공/실패만 분기하므로 스텁이면 충분하다.
// 실제 mongod 대상 ping 성공 경로는 connection.test.ts(연결 통합 테스트)가 소유한다.
describe('pingDb', () => {
  it('command가 성공하면 true를 반환한다', async () => {
    const okDb = { command: () => Promise.resolve({ ok: 1 }) } as unknown as Db
    await expect(pingDb(okDb)).resolves.toBe(true)
  })

  it('command가 throw하면 false를 반환한다(예외를 밖으로 던지지 않는다)', async () => {
    const brokenDb = { command: () => Promise.reject(new Error('boom')) } as unknown as Db
    await expect(pingDb(brokenDb)).resolves.toBe(false)
  })
})
