import { randomUUID } from 'node:crypto'
import type { Character, CharacterSummary } from 'shared'
import type { AccountRepository } from '../repo/accountRepository.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
import { seedVitals, CURRENT_CHARACTER_SCHEMA_VERSION } from '../repo/characterBackfill.js'
import type {
  AccountIdentity,
  CreateCharacterInput,
  SessionAuthPort,
} from './sessionAuthPort.js'
import { OwnershipError } from './sessionAuthPort.js'
import { applyRaceModifiers } from './raceModifiers.js'
import type { SessionCookieVerifier } from './sessionCookieVerifier.js'

/**
 * 신규 캐릭터의 기본 시작 방. dev 기본값이다 — 정본 스폰 방은 world-entry #74 / Story 6-7에서
 * 확정된다. 생성 경로를 실행 가능하게 하려는 placeholder이므로 정본값 탐색은 유예한다.
 */
const START_ROOM = 1

/** 신규 캐릭터의 시작 소지금 기본값(dev). */
const STARTING_GOLD = 500

/**
 * 현재 Character 스키마 버전 — characterBackfill의 backfill 게이트와 단일 출처를 공유한다.
 * 시딩 경로(createCharacter)와 backfill 게이트가 같은 상수를 참조해 버전 드리프트를 차단한다.
 */
const CHARACTER_SCHEMA_VERSION = CURRENT_CHARACTER_SCHEMA_VERSION

/** 신규 캐릭터의 시작 레벨(dev). up_level 성장식은 계승하되 생성은 1레벨에서 출발한다. */
const STARTING_LEVEL = 1

/**
 * SessionAuthPort의 실 어댑터 — 주입된 verifier seam + Mongo 저장소 위에 구현한다.
 *
 * firebase-admin을 직접 import하지 않는다(Story 7이 부팅에서 조립). 생성자로 verifier·
 * accounts·characters를 주입받으며 전역 싱글턴을 조회하지 않는다.
 *
 * 매핑 규약: CharacterSummary.characterId = Character._id. level은 v2에서 영속 필드가 됐으므로
 * 요약의 level은 문서 값을 그대로 투영한다(생성 시 seedVitals와 함께 1레벨로 시딩).
 */
export class FirebaseSessionAuthAdapter implements SessionAuthPort {
  // 최초 validate에서 upsert를 이미 수행한 accountId 집합(중복 write 방지용 dedup 캐시).
  private readonly upsertedAccounts = new Set<string>()

  constructor(
    private readonly verifier: SessionCookieVerifier,
    private readonly accounts: AccountRepository,
    private readonly characters: CharacterRepository,
  ) {}

  async validateSessionCookie(cookie: string): Promise<AccountIdentity | null> {
    // verify 실패는 두 형태(null resolve 또는 throw)로 온다 — firebase-admin은 만료·위조 시
    // throw한다. 둘 다 인증 실패로 동일 취급하고 throw를 삼켜 호출부로 누출하지 않는다.
    let verified: { uid: string } | null
    try {
      verified = await this.verifier(cookie)
    } catch {
      return null
    }
    if (verified === null) return null

    const accountId = verified.uid
    await this.ensureAccountUpserted(accountId)
    // account.status='banned' 강제는 여기 없다 — ban을 세팅하는 admin 명령이 A13으로 유예됐고,
    // 즉시 세션 차단은 쿠키 revocation(checkRevoked) 결정과 얽힌다. A13에서 ban 명령을 붙일 때
    // 이 지점에 접속 시 banned 거부를 추가한다(accountRepository.setStatus 주석 참조).
    return { accountId }
  }

  // verify RESULT는 캐싱하지 않는다 — verify는 연결/업그레이드당 1회 실행이지 프레임당 실행이
  // 아니므로 결과 캐시가 불필요하다. dedup은 오직 멱등 upsert WRITE의 반복만 막는다(Open Q #1/#3).
  // A13 주의: banned-status 강제를 붙일 때 이 dedup 경로에 status 검사를 얹지 말 것 — 캐시 hit면
  // upsert가 skip돼 재검증에서 status 검사도 함께 건너뛴다. 강제는 validateSessionCookie 본체(매 검증
  // 실행)에 두고, dedup은 insert-write 회피 용도로만 한정한다.
  private async ensureAccountUpserted(accountId: string): Promise<void> {
    if (this.upsertedAccounts.has(accountId)) return
    await this.accounts.upsert({ _id: accountId })
    this.upsertedAccounts.add(accountId)
  }

  async listCharacters(accountId: string): Promise<CharacterSummary[]> {
    // findByAccount는 이미 status='deleted'를 제외한다.
    const docs = await this.characters.findByAccount(accountId)
    return docs.map((doc) => this.toSummary(doc))
  }

  async createCharacter(accountId: string, dto: CreateCharacterInput): Promise<CharacterSummary> {
    // 종족 보정을 포인트바이 raw 스탯에 적용한 값을 저장한다(종족 수학은 server E5 코드 소유, 재클램프 없음).
    const doc: Character = {
      _id: randomUUID(),
      name: dto.name,
      class: dto.class,
      race: dto.race,
      stats: applyRaceModifiers(dto.stats, dto.race),
      gold: STARTING_GOLD,
      currentRoom: START_ROOM,
      // 전투 필수 vitals를 1레벨 최대치로 시딩한다(만피·만마 출발). backfill과 동일 산술 출처.
      level: STARTING_LEVEL,
      ...seedVitals(dto.class, STARTING_LEVEL),
      // 누적 경험치는 1레벨 신규라 0으로 시딩한다(backfillCharacterV3의 level<=1 시딩과 일치).
      experience: 0,
      schemaVersion: CHARACTER_SCHEMA_VERSION,
      accountId,
      status: 'active',
      // 생성 인터뷰가 고른 선택 스칼라(선택 필드로 영속).
      gender: dto.gender,
      weapon: dto.weapon,
      alignment: dto.alignment,
    }
    await this.characters.insert(doc)
    return this.toSummary(doc)
  }

  async assertOwnership(accountId: string, characterId: string): Promise<void> {
    const doc = await this.characters.findById(characterId)
    // 미존재·타 계정 소유·무덤(status='deleted')을 한 에러로 합친다(존재 여부 비노출 — 포트 계약 준수).
    // status 검사가 핵심: findById는 findByAccount와 달리 status를 필터하지 않으므로(감사·복원 여지),
    // 이 게이트에서 걸러내지 않으면 소유자가 자기 삭제 캐릭터의 id로 select→command 진입해 재로그인
    // 차단 불변식(Story 8)을 우회한다. deleteCharacter의 이중 assert 경로도 이 검사를 공유한다 —
    // 이미 삭제된 캐릭터 재삭제는 OwnershipError로 fail(중복 deletedAt 재기록 방지).
    if (doc === null || doc.accountId !== accountId || doc.status === 'deleted') {
      throw new OwnershipError(accountId, characterId)
    }
  }

  async deleteCharacter(accountId: string, characterId: string): Promise<void> {
    // 내부 이중 assert(TOCTOU 방어) — 소프트 삭제 직전 소유권을 재확인한다. 대상 선택과 확정
    // 사이에 형제 세션이 같은 캐릭터를 지목해도, 이 assert가 타 계정·미존재 삭제를 막는다.
    await this.assertOwnership(accountId, characterId)
    // 하드 삭제·무덤 이동 셸(system("mv")) 없이 status='deleted'로만 표시한다(재로그인 차단).
    await this.characters.softDelete(characterId)
  }

  /** 영속 Character → 와이어 CharacterSummary 매핑(characterId=_id, level은 영속 필드 반영). */
  private toSummary(doc: Character): CharacterSummary {
    return {
      characterId: doc._id,
      name: doc.name,
      class: doc.class,
      race: doc.race,
      // level은 이제 영속 필드다(v2) — dev 기본값 대신 문서 값을 그대로 투영한다.
      level: doc.level,
    }
  }
}
