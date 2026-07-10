import { buildApp } from './app.js'
import { getConfig } from './config/env.js'
import { createDevSeedAuthAdapterFromEnv } from './auth/devSeedSessionAuth.js'
import { connectMongo } from './db/connection.js'
import { pingDb } from './db/health.js'
import { ObjectRepository } from './repo/objectRepository.js'
import { CharacterRepository } from './repo/characterRepository.js'
import { BankRepository } from './repo/bankRepository.js'
import { WorldRepository } from './repo/worldRepository.js'
import { SaveEngine } from './save/saveEngine.js'
import type { SaveLogger } from './save/logger.js'
import { loadWorldGraph } from './world/worldGraph.js'

// 부팅 엔트리 — env 검증(fail-fast) → DB 연결(fail-fast) → 앱 구성 → SaveEngine 배선 → listen.
// 커버리지에서 제외(배선 코드). PORT는 getConfig().PORT 단일 출처를 쓴다(인라인 파싱 소거).
// SaveEngine.shutdown()의 drain+flush 로직은 테스트 가능한 곳(saveEngine.ts)에 두고, 여기서는
// 시그널 핸들러 등록만 한다.
async function boot(): Promise<void> {
  const config = getConfig()

  // 부팅 시 DB 연결. 실패하면 connectMongo가 throw → 아래 boot().catch에서 fail-fast.
  const conn = await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME)

  // 저장소 인덱스를 프로덕션에서 보장한다. WorldRepository는 _id=roomId 자연키라 init 없음.
  const objects = new ObjectRepository(conn.db)
  const characters = new CharacterRepository(conn.db, objects)
  const bank = new BankRepository(conn.db, objects)
  const world = new WorldRepository(conn.db)
  await Promise.all([objects.init(), characters.init(), bank.init()])

  // 정본 방 번들을 인메모리 그래프로 로드한다(부팅 스코프에 보관). 템플릿·리스폰은 E4 범위.
  const worldGraph = loadWorldGraph()

  // ping을 /health의 진실 원천으로 주입한다. DEV_LOGIN_ENABLED가 true일 때만 dev 시드 어댑터와
  // /dev/login 라우트를 배선한다. 플래그 off(프로덕션)면 미주입 → buildApp이 빈 어댑터로 부팅하고
  // 라우트가 마운트되지 않아 유효 쿠키가 0개다(기존 동작 불변).
  const app = buildApp({
    pingDb: () => pingDb(conn.db),
    ...(config.DEV_LOGIN_ENABLED
      ? {
          sessionAuth: createDevSeedAuthAdapterFromEnv(config),
          devLoginSeedCookie: config.DEV_SEED_COOKIE,
        }
      : {}),
  })
  app.log.info(`world graph loaded: ${worldGraph.size} rooms`)

  // console 금지 — SaveLogger를 fastify app.log.error에 위임하는 어댑터로 구성한다.
  const saveLogger: SaveLogger = {
    error: (context, message) => app.log.error(context, message),
  }
  const saveEngine = new SaveEngine(characters, bank, world, saveLogger)
  saveEngine.start()

  // graceful shutdown — SaveEngine.shutdown()으로 잔여 dirty를 flush·drain한 뒤 DB 연결을 닫는다.
  // 캐시된 Promise로 idempotent 보장: SIGTERM 중복 도착이나 shutdown 진행 중 재수신 시 같은
  // Promise를 반환해 두 번 실행하지 않는다.
  let shuttingDown: Promise<void> | null = null
  const gracefulShutdown = (signal: string): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown
    shuttingDown = (async () => {
      app.log.info(`${signal} 수신 — graceful shutdown 시작`)
      await saveEngine.shutdown()
      await conn.close()
      process.exit(0)
    })()
    return shuttingDown
  }
  // async 핸들러의 unhandled rejection을 차단한다(void + catch). 실패 시 로그 후 비정상 종료.
  const onSignal = (signal: string): void => {
    void gracefulShutdown(signal).catch((err: unknown) => {
      app.log.error(err)
      process.exit(1)
    })
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))

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
