import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient, type Db } from 'mongodb'

/**
 * repo 통합 테스트용 공유 인메모리 Mongo 하네스.
 *
 * 파일당 1개의 MongoMemoryReplSet(단일노드 replica set) + MongoClient를 세운다 —
 * beforeAll에서 create, afterAll에서 cleanup으로 client.close + replset.stop을
 * 순서대로 수행한다. standalone 모드는 `session.withTransaction`을 지원하지 않아
 * ("Transaction numbers are only allowed on a replica set member or mongos")
 * 단일노드 replset으로 승격했다.
 * 컬렉션별 격리(deleteMany)는 컬렉션 목록이 파일마다 다르므로 각 테스트 파일이
 * beforeEach에서 자체 수행한다.
 *
 * 테스트 인프라이므로 coverage(vitest exclude)·dist(tsconfig.build exclude)에서 모두 제외한다.
 * 단선 팩토리라 검증할 분기가 없다.
 */
export type MongoTestDb = {
  db: Db
  // MongoClient를 노출한다 — session.withTransaction은 client.startSession()이 필요하므로
  // 트랜잭션 서비스를 테스트에서 조립하려면 client 핸들이 있어야 한다. 기존 소비자는
  // { db, cleanup }만 구조분해하므로 이 필드 추가는 하위호환이다.
  client: MongoClient
  cleanup: () => Promise<void>
}

export async function createMongoTestDb(dbName: string): Promise<MongoTestDb> {
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const client = new MongoClient(replset.getUri())
  await client.connect()
  const db = client.db(dbName)

  const cleanup = async (): Promise<void> => {
    await client.close()
    await replset.stop()
  }

  return { db, client, cleanup }
}
