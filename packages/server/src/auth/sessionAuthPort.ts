import type { CharacterSummary } from 'shared'

/**
 * 세션 인증 포트 — server 도메인이 소유하는 계정·캐릭터 세션 어휘의 단일 계약.
 *
 * 이 인터페이스는 firebase-admin API(예: verifySessionCookie·getUser)를 표현하지 않는다.
 * 게임 세션 도메인 언어(쿠키 검증→계정 신원, 캐릭터 목록·생성, 소유권 확인)로만 표현하며,
 * 실 백엔드(firebase-admin·Mongo)는 포트 뒤 어댑터 교체로 붙는다(DIP seam). E5에서
 * 실 firebase 세션 쿠키 검증 어댑터와 accountId↔character의 Mongo 영구화가 이 포트를
 * 구현한다 — 여기(E3)에는 실 firebase·Mongo 구현을 두지 않고 인메모리 어댑터로만 만족한다.
 *
 * async 시그니처: 네 메서드가 모두 `Promise`를 반환한다. E5의 실 어댑터는 네트워크·DB I/O로
 * async가 필수이므로, 인메모리 stub 단계에서 미리 포트를 async로 확정해 호출부(어댑터·FSM·플러그인)를
 * await로 정렬했다 — 실 어댑터 교체 시 시그니처 변경 없이 구현만 바꾸면 된다. 인메모리 구현은 즉시
 * resolve하는 Promise를 돌려주지만, 셸은 소켓 프레임을 per-connection 큐로 직렬화해 await 도중 *프레임 대
 * 프레임* 재진입(다음 프레임이 공유 상태를 동시 변이)이 없도록 보장한다. 프레임 큐와 별개 리스너인 소켓
 * 'close'는 이 큐로 못 막으므로, FSM이 포트 await 재개 후 ctx.closed 가드로 죽은 연결의 월드 등록을 건너뛴다.
 */

/**
 * 검증된 세션 쿠키가 식별하는 계정 신원. 필요한 최소 필드(accountId)만 담는다.
 * E5에서 실 firebase 클레임(이메일·표시명 등)이 필요해지면 이 타입을 확장한다.
 */
export interface AccountIdentity {
  accountId: string
}

/**
 * 캐릭터 생성 입력 DTO — 최소 필드(이름·클래스 코드·종족 코드)만 받는다.
 * level 등 파생 값은 어댑터가 기본값으로 채운다.
 */
export type CreateCharacterInput = {
  name: string
  class: number
  race: number
}

/**
 * 세션 인증 포트 계약. 구현체는 자체 저장소를 생성자로 소유한다(서비스 로케이터·전역 싱글턴 금지).
 */
export interface SessionAuthPort {
  /** 세션 쿠키를 검증해 계정 신원을 반환한다. 유효하지 않으면 null. */
  validateSessionCookie(cookie: string): Promise<AccountIdentity | null>

  /** account가 보유한 캐릭터 요약 목록을 반환한다. 없으면 빈 배열. */
  listCharacters(accountId: string): Promise<CharacterSummary[]>

  /**
   * account에 최소 필드 dto로 캐릭터를 생성하고 그 요약을 반환한다.
   * 입력 검증(이름 비어있지 않음·클래스/종족 정수)은 호출자 계약이다 — 어댑터는 유효 DTO를
   * 가정한다. Story 5의 create 상태 핸들러가 Zod로 검증한 뒤 호출한다. 클래스/종족 코드의
   * 범위·유효성 제약은 코드 테이블이 확정되는 E5로 유예한다(E3엔 테이블이 없어 강제하지 않는다).
   */
  createCharacter(accountId: string, dto: CreateCharacterInput): Promise<CharacterSummary>

  /** characterId가 accountId 소유가 아니면 reject한다(OwnershipError). 소유하면 resolve. */
  assertOwnership(accountId: string, characterId: string): Promise<void>
}

/**
 * 소유권 검증 실패 시 던지는 에러 — `assertOwnership`이 characterId가 요청 account의 소유가
 * 아니거나 존재하지 않을 때 던진다(존재 여부 비노출을 위해 두 경우를 한 에러로 합친다).
 *
 * 어댑터 구현이 아니라 포트 계약에 산다 — 이 에러는 `SessionAuthPort`의 assertOwnership 계약이며
 * Story 3의 소켓 경계가 이를 catch해 프로토콜 error로 매핑한다. E5에서 어댑터가 교체돼도 계약
 * 에러는 그대로 유지된다(repo/types.ts가 DocumentNotFoundError를 계약 모듈에 두는 선례와 동일).
 */
export class OwnershipError extends Error {
  constructor(accountId: string, characterId: string) {
    super(`캐릭터 소유권이 없습니다: account=${accountId} character=${characterId}`)
    this.name = 'OwnershipError'
  }
}
