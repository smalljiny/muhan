import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { connectMongo, type MongoConnection } from './connection.js'
import { pingDb } from './health.js'

describe('connectMongo (integration)', () => {
  let mongod: MongoMemoryServer

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
  }, 60_000)

  afterAll(async () => {
    await mongod.stop()
  })

  it('유효한 URI에 연결하면 사용 가능한 Db를 반환하고 연결 상태를 감시한다', async () => {
    let conn: MongoConnection | undefined
    try {
      conn = await connectMongo(mongod.getUri(), 'muhan_conn_test')
      await expect(pingDb(conn.db)).resolves.toBe(true)
      // connect 이전에 리스너를 붙였으므로 초기 handshake heartbeat로 플래그가 true다.
      expect(conn.isConnected()).toBe(true)
    } finally {
      await conn?.close()
    }
  })

  it('잘못된 URI는 빠르게 reject한다(fail-fast)', async () => {
    // serverSelectionTimeoutMS를 짧게 줘 30s 기본값으로 인한 hang을 피한다.
    await expect(
      connectMongo('mongodb://127.0.0.1:1/nope', 'db', { serverSelectionTimeoutMS: 500 }),
    ).rejects.toThrow()
  })
})
