import type { CharacterSummary } from 'shared'
import { InMemorySessionAuthAdapter } from './inMemorySessionAuthAdapter.js'

/**
 * dev 전용 시드 세션 인증 어댑터 조립 — env(DEV_SEED_COOKIE·DEV_SEED_ACCOUNT_ID)에서 읽은 시드 값으로
 * InMemorySessionAuthAdapter를 구성한다(Story 4, G1 서버측).
 *
 * testutil 격리: 이 모듈은 `seedSessionAuth.testutil.ts`를 import하지 않는다 — 그 파일은 하드코딩된
 * 유효 쿠키 상수를 담아 tsconfig.build.json이 dist에서 제외하므로, 배포 산출물에는 유효 쿠키가 실리지
 * 않는다. 여기서는 유효 쿠키를 컴파일 상수가 아니라 런타임 env에서 주입받아, 이 build-included 모듈이
 * dist에 나가도 하드코딩된 유효 쿠키 문자열은 남지 않는다(캐릭터 값만 고정 상수로 노출된다 — 비밀 아님).
 */

/**
 * 시드 account가 보유하는 고정 캐릭터 1개. 비밀이 아닌 dev 개발용 값이다(id·이름 고정).
 * class·race·level은 정수 코드이며 E5 코드 테이블 확정 전 임의 dev 기본값이다.
 */
export const DEV_SEED_CHARACTER: CharacterSummary = {
  characterId: 'dev-char-1',
  name: '개발전사',
  class: 1,
  race: 1,
  level: 1,
}

/**
 * 시드 쿠키·계정 값으로 인메모리 세션 인증 어댑터를 조립하는 순수 팩토리.
 *
 * 시드 쿠키를 accountId로 매핑하고, 그 account에 고정 캐릭터 1개(DEV_SEED_CHARACTER)를 심는다.
 * cookie 또는 accountId가 빈 문자열이면 조립을 거부한다(fail-fast) — 플래그 on인데 시드 값이 비면
 * 배포에 빈/무의미한 유효 쿠키가 심기는 오설정이므로, 기존 env fail-fast 관례를 따라 즉시 막는다.
 */
export function createDevSeedAuthAdapter(
  cookie: string,
  accountId: string,
): InMemorySessionAuthAdapter {
  if (cookie.length === 0 || accountId.length === 0) {
    throw new Error(
      'dev 시드 인증 조립 실패: DEV_LOGIN_ENABLED가 true이면 DEV_SEED_COOKIE·DEV_SEED_ACCOUNT_ID가 필요하다',
    )
  }
  return new InMemorySessionAuthAdapter({
    cookieToAccount: { [cookie]: accountId },
    characters: { [accountId]: [{ ...DEV_SEED_CHARACTER }] },
  })
}

/**
 * env 파생 값에서 시드 쿠키·계정을 읽어 어댑터를 조립하는 얇은 래퍼. 순수 팩토리를 재사용한다.
 * 부팅(index.ts)이 DEV_LOGIN_ENABLED가 true일 때 이 래퍼로 sessionAuth를 주입한다.
 */
export function createDevSeedAuthAdapterFromEnv(config: {
  DEV_SEED_COOKIE: string
  DEV_SEED_ACCOUNT_ID: string
}): InMemorySessionAuthAdapter {
  return createDevSeedAuthAdapter(config.DEV_SEED_COOKIE, config.DEV_SEED_ACCOUNT_ID)
}
