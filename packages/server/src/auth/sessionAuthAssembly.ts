/**
 * 부팅 세션 인증 조립 — DEV_LOGIN_ENABLED 플래그로 dev 시드 경로와 Firebase 경로를 분기한다.
 * firebase-admin 결합을 부팅 엔트리로 국한하기 위해 verifier 팩토리를 `deps.createVerifier`로 주입받는다.
 */
import type { Env } from '../config/env.js'
import type { AccountRepository } from '../repo/accountRepository.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
import { createDevSeedAuthAdapterFromEnv } from './devSeedSessionAuth.js'
import { seedDevCharacter } from './devSeedCharacter.js'
import { FirebaseSessionAuthAdapter } from './firebaseSessionAuthAdapter.js'
import type { SessionAuthPort } from './sessionAuthPort.js'
import type { SessionCookieVerifier } from './sessionCookieVerifier.js'

type SessionAuthAssemblyConfig = Pick<
  Env,
  | 'NODE_ENV'
  | 'DEV_LOGIN_ENABLED'
  | 'DEV_SEED_COOKIE'
  | 'DEV_SEED_ACCOUNT_ID'
  | 'FIREBASE_PROJECT_ID'
>

type SessionAuthAssemblyDeps = {
  accounts: AccountRepository
  characters: CharacterRepository
  createVerifier: (projectId: string) => SessionCookieVerifier
}

type SessionAuthAssembly = {
  sessionAuth: SessionAuthPort
  devLoginSeedCookie?: string
  devSeedResult?: 'inserted' | 'kept'
}

/**
 * 실 FirebaseSessionAuthAdapter를 조립한다(DEV_LOGIN off 경로). FIREBASE_PROJECT_ID가 없으면
 * throw해 fail-fast한다 — 검증 불능 어댑터(모든 쿠키를 무효 처리)가 프로덕션에 배포되는 것을 막는다.
 * 어댑터는 주입된 verifier seam에만 의존한다.
 */
function buildFirebaseSessionAuth(
  config: SessionAuthAssemblyConfig,
  deps: SessionAuthAssemblyDeps,
): FirebaseSessionAuthAdapter {
  const projectId = config.FIREBASE_PROJECT_ID
  if (projectId === undefined || projectId.length === 0) {
    throw new Error(
      'FIREBASE_PROJECT_ID가 필요하다 (DEV_LOGIN_ENABLED=false 프로덕션 세션 인증 경로)',
    )
  }
  const verifier = deps.createVerifier(projectId)
  return new FirebaseSessionAuthAdapter(verifier, deps.accounts, deps.characters)
}

/**
 * 세션 인증 어댑터를 조립한다.
 * - DEV_LOGIN_ENABLED true(dev): dev 시드 어댑터를 먼저 조립해 쿠키·계정 ID를 검증하고, 성공한 뒤에만
 *   시드 캐릭터 문서를 보장한다(없으면 삽입, 있으면 정합 확인). 정합 실패는 호출자로 전파된다.
 * - false(프로덕션): Firebase 어댑터를 조립한다. 시드 쓰기는 일어나지 않는다.
 *
 * dev 경로는 NODE_ENV가 development·test일 때만 조립한다. getConfig()의 같은 게이트와 겹치지만,
 * getConfig()를 거치지 않은 config로 호출돼도 시드 인증·시드 쓰기가 열리지 않게 여기서도 막는다.
 */
export async function assembleSessionAuth(
  config: SessionAuthAssemblyConfig,
  deps: SessionAuthAssemblyDeps,
): Promise<SessionAuthAssembly> {
  if (!config.DEV_LOGIN_ENABLED) {
    return { sessionAuth: buildFirebaseSessionAuth(config, deps) }
  }
  if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
    throw new Error('DEV_LOGIN_ENABLED requires NODE_ENV=development or test')
  }
  const sessionAuth = createDevSeedAuthAdapterFromEnv(config)
  const devSeedResult = await seedDevCharacter(deps.characters, config.DEV_SEED_ACCOUNT_ID)
  return { sessionAuth, devLoginSeedCookie: config.DEV_SEED_COOKIE, devSeedResult }
}
