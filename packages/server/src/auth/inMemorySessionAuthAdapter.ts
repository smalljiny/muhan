import type { CharacterSummary } from 'shared'
import type {
  AccountIdentity,
  CreateCharacterInput,
  SessionAuthPort,
} from './sessionAuthPort.js'
import { OwnershipError } from './sessionAuthPort.js'

/**
 * SessionAuthPort의 인메모리 실 구현.
 *
 * mock이 아니라 실제 인메모리 저장이다 — 쿠키→accountId 매핑과 accountId→캐릭터 요약 목록을
 * 자체 Map으로 소유한다(생성자 주입 관례: 전역 싱글턴을 조회하지 않는다). E5에서 이 어댑터가
 * 실 firebase 세션 검증 + Mongo 영구화 어댑터로 교체된다(포트 뒤 seam).
 *
 * 불변성: listCharacters·createCharacter는 내부 배열·객체 참조를 노출하지 않고 얕은 복사본을
 * 반환한다(CharacterSummary는 원시 필드만 가지므로 얕은 복사로 충분). 호출자가 반환값을
 * 변형해도 저장소가 오염되지 않는다.
 */
export class InMemorySessionAuthAdapter implements SessionAuthPort {
  /** 세션 쿠키 문자열 → accountId. 유효 쿠키의 단일 출처. */
  private readonly cookieToAccount: Map<string, string>

  /** accountId → 캐릭터 요약 배열(내부 저장본). */
  private readonly charactersByAccount: Map<string, CharacterSummary[]>

  /** characterId 생성용 단조 증가 카운터. */
  private nextCharacterSeq = 1

  /**
   * 선택적 초기 상태를 받아 저장소를 구성한다. 인자를 생략하면 빈 어댑터가 된다.
   * 시드는 createSeededAuthAdapter가 이 생성자로 주입한다(포트 표면에 register 메서드를 두지 않음).
   */
  constructor(seed?: {
    cookieToAccount?: Record<string, string>
    characters?: Record<string, CharacterSummary[]>
  }) {
    this.cookieToAccount = new Map(Object.entries(seed?.cookieToAccount ?? {}))
    this.charactersByAccount = new Map(
      Object.entries(seed?.characters ?? {}).map(([accountId, list]) => [
        accountId,
        list.map((c) => ({ ...c })),
      ]),
    )
  }

  validateSessionCookie(cookie: string): AccountIdentity | null {
    const accountId = this.cookieToAccount.get(cookie)
    if (accountId === undefined) {
      return null
    }
    return { accountId }
  }

  listCharacters(accountId: string): CharacterSummary[] {
    const list = this.charactersByAccount.get(accountId)
    if (list === undefined) {
      return []
    }
    return list.map((c) => ({ ...c }))
  }

  createCharacter(accountId: string, dto: CreateCharacterInput): CharacterSummary {
    const summary: CharacterSummary = {
      characterId: `char-${this.nextCharacterSeq++}`,
      name: dto.name,
      class: dto.class,
      race: dto.race,
      level: 1,
    }
    const existing = this.charactersByAccount.get(accountId) ?? []
    // summary는 이 함수에서만 만든 미별칭 로컬이라 저장본으로 그대로 넘긴다. 저장본과 반환본이
    // 다른 참조이기만 하면 저장소 오염이 막히므로 복사는 반환 경로에만 둔다.
    this.charactersByAccount.set(accountId, [...existing, summary])
    return { ...summary }
  }

  assertOwnership(accountId: string, characterId: string): void {
    const list = this.charactersByAccount.get(accountId) ?? []
    const owns = list.some((c) => c.characterId === characterId)
    if (!owns) {
      throw new OwnershipError(accountId, characterId)
    }
  }
}

/** 시드 어댑터가 심는 알려진 유효 세션 쿠키 상수. Story 3·7의 실 소켓 테스트가 결정적으로 재사용한다. */
export const SEED_VALID_COOKIE = 'seed-valid-session-cookie'

/** 시드 유효 쿠키가 매핑되는 account 식별자. */
export const SEED_ACCOUNT_ID = 'seed-account-1'

/** 시드 account가 미리 보유하는 캐릭터 식별자. */
export const SEED_CHARACTER_ID = 'seed-char-1'

/**
 * 테스트·조립 루트가 재사용하는 시드 팩토리. 알려진 유효 쿠키(SEED_VALID_COOKIE)를
 * SEED_ACCOUNT_ID로 매핑하고, 그 account에 캐릭터 1개(SEED_CHARACTER_ID)를 미리 심은
 * 어댑터를 반환한다. 실 소켓 테스트가 결정적 유효 쿠키를 확보하게 한다.
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
