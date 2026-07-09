import { InMemorySessionAuthAdapter } from './inMemorySessionAuthAdapter.js'

/**
 * 시드 세션 인증 테스트 유틸 — 실 소켓·FSM 테스트가 결정적으로 재사용하는 알려진 유효 쿠키·계정·캐릭터.
 *
 * `.testutil.ts`라 tsconfig.build.json이 프로덕션 빌드(dist)에서 제외한다 — 알려진 유효 쿠키
 * 상수와 시드 팩토리가 배포 산출물에 실리지 않게 격리한다(잠재 인증 우회 표면 제거). 프로덕션
 * 어댑터(InMemorySessionAuthAdapter)는 빈 저장소로만 부팅되고, 시드 주입은 테스트에서만 일어난다.
 */

/** 시드 어댑터가 심는 알려진 유효 세션 쿠키 상수. Story 3·7의 실 소켓 테스트가 결정적으로 재사용한다. */
export const SEED_VALID_COOKIE = 'seed-valid-session-cookie'

/** 시드 유효 쿠키가 매핑되는 account 식별자. */
export const SEED_ACCOUNT_ID = 'seed-account-1'

/** 시드 account가 미리 보유하는 캐릭터 식별자. */
export const SEED_CHARACTER_ID = 'seed-char-1'

/**
 * 테스트가 재사용하는 시드 팩토리. 알려진 유효 쿠키(SEED_VALID_COOKIE)를 SEED_ACCOUNT_ID로
 * 매핑하고, 그 account에 캐릭터 1개(SEED_CHARACTER_ID)를 미리 심은 어댑터를 반환한다. 실 소켓
 * 테스트가 결정적 유효 쿠키를 확보하게 한다.
 */
export function createSeededAuthAdapter(): InMemorySessionAuthAdapter {
  return new InMemorySessionAuthAdapter({
    cookieToAccount: { [SEED_VALID_COOKIE]: SEED_ACCOUNT_ID },
    characters: {
      [SEED_ACCOUNT_ID]: [
        { characterId: SEED_CHARACTER_ID, name: '무한전사', class: 1, race: 1, level: 5 },
      ],
    },
  })
}
