import { buildApp } from './app.js'
import { getConfig } from './config/env.js'
import { createDevSeedAuthAdapterFromEnv } from './auth/devSeedSessionAuth.js'
import { FirebaseSessionAuthAdapter } from './auth/firebaseSessionAuthAdapter.js'
import { createFirebaseVerifier } from './auth/firebaseVerifier.js'
import { connectMongo } from './db/connection.js'
import { pingDb } from './db/health.js'
import { ObjectRepository } from './repo/objectRepository.js'
import { CharacterRepository } from './repo/characterRepository.js'
import { AccountRepository } from './repo/accountRepository.js'
import { BankRepository } from './repo/bankRepository.js'
import { WorldRepository } from './repo/worldRepository.js'
import { SaveEngine } from './save/saveEngine.js'
import type { SaveLogger } from './save/logger.js'
import { loadObjectTemplates } from './items/objectTemplate.js'
import { loadWorldGraph } from './world/worldGraph.js'
import { WorldClock, type WorldTickLogger } from './world/worldClock.js'
import { createGameTime } from './world/gameTime.js'
import { createCheckExitsSlot } from './world/checkExits.js'
import { createWorldRuntime } from './world/worldRuntime.js'
import { createLiveCharacterRegistry } from './world/liveCharacterRegistry.js'
import type { LiveWorldWiringBundle } from './ws/liveWorldWiring.js'

// 부팅 엔트리 — env 검증(fail-fast) → DB 연결(fail-fast) → 앱 구성 → SaveEngine 배선 → listen.
// 커버리지에서 제외(배선 코드). PORT는 getConfig().PORT 단일 출처를 쓴다(인라인 파싱 소거).
// SaveEngine.shutdown()의 drain+flush 로직은 테스트 가능한 곳(saveEngine.ts)에 두고, 여기서는
// 시그널 핸들러 등록만 한다.
/**
 * 실 FirebaseSessionAuthAdapter를 조립한다(DEV_LOGIN off 경로). FIREBASE_PROJECT_ID가 없으면
 * throw해 fail-fast한다 — 검증 불능 어댑터(모든 쿠키를 무효 처리)가 프로덕션에 배포되는 것을 막는다.
 * firebase-admin import는 verifier 팩토리로 국한하고, 어댑터는 주입된 verifier seam에만 의존한다.
 */
function buildFirebaseSessionAuth(
  config: ReturnType<typeof getConfig>,
  accounts: AccountRepository,
  characters: CharacterRepository,
): FirebaseSessionAuthAdapter {
  const projectId = config.FIREBASE_PROJECT_ID
  if (projectId === undefined || projectId.length === 0) {
    throw new Error(
      'FIREBASE_PROJECT_ID가 필요하다 (DEV_LOGIN_ENABLED=false 프로덕션 세션 인증 경로)',
    )
  }
  const verifier = createFirebaseVerifier(projectId)
  return new FirebaseSessionAuthAdapter(verifier, accounts, characters)
}

async function boot(): Promise<void> {
  const config = getConfig()

  // 부팅 시 DB 연결. 실패하면 connectMongo가 throw → 아래 boot().catch에서 fail-fast.
  const conn = await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME)

  // 저장소 인덱스를 프로덕션에서 보장한다. WorldRepository는 _id=roomId 자연키라 init 없음.
  const objects = new ObjectRepository(conn.db)
  const characters = new CharacterRepository(conn.db, objects)
  const accounts = new AccountRepository(conn.db)
  const bank = new BankRepository(conn.db, objects)
  const world = new WorldRepository(conn.db)
  await Promise.all([objects.init(), characters.init(), accounts.init(), bank.init()])

  // 정본 방 번들을 인메모리 그래프로 로드한다(부팅 스코프에 보관). 템플릿·리스폰은 E4 범위.
  const worldGraph = loadWorldGraph()

  // 정본 object 템플릿 인덱스를 1회 로드한다(근거: LiveWorldWiringBundle.objectTemplates doc).
  const objectTemplates = loadObjectTemplates()

  // 라이브 캐릭터 레지스트리·게임시각을 만든다 — 라이브 월드 의존 묶음(Story 7)의 원재료다. 레지스트리는
  // 단일 인스턴스로 진입 코어·이동·수명 어댑터·발화자 방 해소자가 공유한다(#3).
  const liveRegistry = createLiveCharacterRegistry()
  const gameTime = createGameTime()

  // 순환 회피(#순서): 라이브 월드 묶음이 saveEngine·worldRuntime를 참조해야 해서 이 둘을 buildApp 전에 const로
  // 조립한다. 두 인스턴스가 의존하는 app.log는 buildApp이 세우지만, 위임 클로저(saveLogger·worldTickLogger·묶음
  // logger)는 호출 시점(save flush·틱·orphan 폴백, 모두 listen 이후)에만 app.log를 읽으므로 buildApp 전 조립이
  // 안전하다 — 로거를 지연 위임하고 인스턴스는 const로 앞당긴다. 슬롯 register·start·shutdown 순서는 불변이다.
  // console 금지 — SaveLogger를 app.log.error에 위임하는 어댑터로 구성한다.
  const saveLogger: SaveLogger = {
    error: (context, message) => app.log.error(context, message),
  }
  const saveEngine = new SaveEngine(characters, bank, world, objects, saveLogger)

  // 1Hz 중앙 월드 틱. worldClock·worldRuntime를 buildApp 전에 조립한다(묶음 원재료). now 도메인 단일 출처로
  // worldClock.currentTick()을 훅 now에 주입한다 — onRoomEntered activate/respawn now가 creatureTick tickSec와
  // 동일 도메인이어야 재생 소급이 성립한다. onRoomEntered/onRoomLeft 훅은 이제 라이브 월드 묶음이 이동(tryMove)·
  // 세션 진입/퇴장에 결선해 활성화된다(Story 7 — 이전 dormant 경계 해소). invasion 슬롯은 실 invasionRng 미주입
  // 시 register 대상에서 제외된다(adversarial 결정 — 기본 stub의 고정 방 누적 회피).
  // console 금지 — 슬롯 실패 격리 logger를 app.log.error에 위임한다.
  const worldTickLogger: WorldTickLogger = {
    error: (context, message) => app.log.error(context, message),
  }
  const worldClock = new WorldClock({ logger: worldTickLogger })
  // 절대 틱 seam — **1회 생성해 공유**한다(liveWorldWiring #3 불변식의 boot 쪽 적용). worldRuntime 훅
  // (활성화·리스폰)과 P-flag 합성이 같은 기준선을 봐야 만료 판정이 갈리지 않는데, 두 번 만들면 나중에
  // 한쪽만 다른 시계로 갈아끼워도 타입·테스트가 잡지 못한다(둘 다 `() => number`다).
  const now = (): number => worldClock.currentTick()
  const worldRuntime = createWorldRuntime(worldGraph, { now })

  // 라이브 월드 의존 묶음 — buildApp/registerWebsocket이 진입·이동(world:move)·세션 수명·방 채널 어댑터를
  // 파생한다. markDirty는 SaveEngine 메서드라 this 바인딩을 유지하도록 화살표로 감싼다. currentHour·
  // onRoomEntered·onRoomLeft는 this-free 클로저(gameTime·worldRuntime 팩토리 산출물)라 직접 전달한다.
  // logger는 app.log를 호출 시점에 지연 조회한다(위 로거 위임 관례 미러). onRoomEntered/onRoomLeft를
  // worldRuntime 훅에 위임해 이동·세션 진입/퇴장이 동일 활성 집합을 갱신하게 한다.
  const liveWorldDeps: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: characters,
    objectTemplates,
    // 사망 seam(소환·perm 리스폰)이 쓰는 두 원재료는 **worldRuntime의 인스턴스를 그대로** 싣는다.
    // 별도 발급기·인덱스를 만들면 소환 크리처 instanceId가 스폰 크리처와 충돌한다(D7 4경로 공유 계약 —
    // worldRuntime.alloc JSDoc이 이 조립 지점을 지목한다).
    spawnTemplates: worldRuntime.templates,
    alloc: worldRuntime.alloc,
    markDirty: (collection, id, snapshot) => saveEngine.markDirty(collection, id, snapshot),
    // markDirty와 짝이 되는 조회 seam — 같은 이유로 this 바인딩 유지를 위해 화살표로 감싼다.
    peekPending: (collection, id) => saveEngine.peekPending(collection, id),
    currentHour: gameTime.currentHour,
    // P-flag 합성 시점 — worldRuntime 훅과 **같은 클로저**를 넘긴다(위 `now` 선언 참조).
    now,
    onRoomEntered: worldRuntime.onRoomEntered,
    onRoomLeft: worldRuntime.onRoomLeft,
    logger: {
      warn: (context, message) => app.log.warn(context, message),
      error: (context, message) => app.log.error(context, message),
    },
  }

  // ping을 /health의 진실 원천으로 주입한다. 세션 인증 어댑터는 플래그로 분기한다:
  // - DEV_LOGIN_ENABLED true(dev): dev 시드 어댑터 + /dev/login 라우트를 배선한다(기존 동작 불변).
  // - false(프로덕션): 실 FirebaseSessionAuthAdapter를 조립해 주입한다. firebase-admin 기반 verifier를
  //   FIREBASE_PROJECT_ID로 세우고, AccountRepository·CharacterRepository를 넘긴다. PROJECT_ID가 없으면
  //   무효 어댑터가 배포되지 않도록 fail-fast한다(optional 스키마의 프로덕션 경로 보강).
  const sessionAuthDeps = config.DEV_LOGIN_ENABLED
    ? {
        sessionAuth: createDevSeedAuthAdapterFromEnv(config),
        devLoginSeedCookie: config.DEV_SEED_COOKIE,
      }
    : { sessionAuth: buildFirebaseSessionAuth(config, accounts, characters) }
  const app = buildApp({
    pingDb: () => pingDb(conn.db),
    ...sessionAuthDeps,
    liveWorldDeps,
  })
  app.log.info(`world graph loaded: ${worldGraph.size} rooms`)
  app.log.info(`object templates loaded: ${objectTemplates.size} objects`)

  // 저장 스케줄러·월드 틱을 기동한다(구성은 buildApp 전에 끝났고, 여기서는 슬롯 등록·start만 수행한다). 게임시각
  // 진행(150초마다 Time++)·출구 자동 재잠금(매 틱)·크리처 tick·스폰 슬롯을 등록한 뒤 start한다.
  saveEngine.start()
  worldClock.register(gameTime.slot)
  worldClock.register(createCheckExitsSlot(worldGraph))
  for (const slot of worldRuntime.slots) worldClock.register(slot)
  worldClock.start()

  // graceful shutdown — SaveEngine.shutdown()으로 잔여 dirty를 flush·drain한 뒤 DB 연결을 닫는다.
  // 캐시된 Promise로 idempotent 보장: SIGTERM 중복 도착이나 shutdown 진행 중 재수신 시 같은
  // Promise를 반환해 두 번 실행하지 않는다.
  let shuttingDown: Promise<void> | null = null
  const gracefulShutdown = (signal: string): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown
    shuttingDown = (async () => {
      app.log.info(`${signal} 수신 — graceful shutdown 시작`)
      // 종료 수렴 순서(spec §3.3): ① 플래그 set으로 뒤늦은 close가 link-dead 처리로 새지 않도록
      // 차단 → ② 월드 틱 정지로 신규 게임 이벤트 유입 차단 → ③ 등록된 세션을 일괄 수렴(clean
      // disconnect) → ④ app.close()로 잔여 소켓·리스너를 정리. 그 다음에야 save flush·DB close.
      //
      // 상위 단계(③④)를 try로 감싸고 flush·DB close를 finally에 둔다 — converge나 app.close가 throw해도
      // saveEngine.shutdown()이 무조건 실행돼 잔여 dirty를 flush한다. saveEngine.shutdown()은 유일한
      // force-flush 지점이라, 스킵되면 미저장 상태가 소실된다(#56 결함 클래스: shutdown 배선 자체가
      // flush 스킵 경로를 만들지 않도록 격리). converge의 바인딩별 격리와 함께 이중 방어를 이룬다.
      try {
        app.wsShutdown.markShuttingDown()
        worldClock.stop()
        app.wsShutdown.converge()
        await app.close()
        // 2차 수렴 — 1차 스냅샷 이후 app.close 대기 중 큐잉 프레임이 enterWorld로 등록한 late 바인딩을
        // 종결한다. app.close 완료 시점엔 소켓이 모두 닫혀 신규 등록이 불가하므로 이 수렴이 레지스트리를
        // 확정적으로 비운다(늦은 등록 레이스 방어 — 그 소켓의 close는 isShuttingDown 가드로 handleClose를
        // 건너뛰어 스스로 종결되지 못한다). converge는 idempotent·바인딩별 격리라 재호출이 안전하다.
        app.wsShutdown.converge()
      } finally {
        await saveEngine.shutdown()
        await conn.close()
      }
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
