import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'

/**
 * repo 통합 테스트용 공유 인메모리 Mongo 하네스.
 *
 * 파일당 1개의 MongoMemoryServer + MongoClient를 세운다 — beforeAll에서 create,
 * afterAll에서 cleanup으로 client.close + mongod.stop을 순서대로 수행한다.
 * 컬렉션별 격리(deleteMany)는 컬렉션 목록이 파일마다 다르므로 각 테스트 파일이
 * beforeEach에서 자체 수행한다.
 *
 * 테스트 인프라이므로 coverage(vitest exclude)·dist(tsconfig.build exclude)에서 모두 제외한다.
 * 단선 팩토리라 검증할 분기가 없다.
 */
export type MongoTestDb = {
  db: Db
  cleanup: () => Promise<void>
}

export async function createMongoTestDb(dbName: string): Promise<MongoTestDb> {
  const mongod = await MongoMemoryServer.create()
  const client = new MongoClient(mongod.getUri())
  await client.connect()
  const db = client.db(dbName)

  const cleanup = async (): Promise<void> => {
    await client.close()
    await mongod.stop()
  }

  return { db, cleanup }
}
