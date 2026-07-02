import { buildApp } from './app.js'
import { getConfig } from './config/env.js'
import { connectMongo } from './db/connection.js'
import { pingDb } from './db/health.js'
import { ObjectRepository } from './repo/objectRepository.js'
import { CharacterRepository } from './repo/characterRepository.js'
import { BankRepository } from './repo/bankRepository.js'

// 부팅 엔트리 — env 검증(fail-fast) → DB 연결(fail-fast) → 앱 구성 → listen.
// 커버리지에서 제외(배선 코드). PORT는 getConfig().PORT 단일 출처를 쓴다(인라인 파싱 소거).
async function boot(): Promise<void> {
  const config = getConfig()

  // 부팅 시 DB 연결. 실패하면 connectMongo가 throw → 아래 boot().catch에서 fail-fast.
  const conn = await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME)

  // 저장소 인덱스를 프로덕션에서 보장한다. WorldRepository는 _id=roomId 자연키라 init 없음.
  const objects = new ObjectRepository(conn.db)
  const characters = new CharacterRepository(conn.db, objects)
  const bank = new BankRepository(conn.db, objects)
  await Promise.all([objects.init(), characters.init(), bank.init()])

  // ping을 /health의 진실 원천으로 주입한다.
  const app = buildApp({ pingDb: () => pingDb(conn.db) })

  try {
    const address = await app.listen({ port: config.PORT, host: '0.0.0.0' })
    app.log.info(`server listening at ${address}`)
  } catch (err) {
    app.log.error(err)
    await conn.close()
    process.exit(1)
  }
}

boot().catch((err: unknown) => {
  // env·DB 연결 fail-fast 경로. 자격증명(URI)이 로그로 새지 않도록 메시지만 출력한다.
  console.error('부팅 실패:', err instanceof Error ? err.message : err)
  process.exit(1)
})
