import { randomUUID } from 'node:crypto'
import type { Character, CharacterSummary } from 'shared'
import type { AccountRepository } from '../repo/accountRepository.js'
import type { CharacterRepository } from '../repo/characterRepository.js'
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

/** 현재 Character 스키마 버전 — 기존 픽스처·스키마와 동일 정수. */
const CHARACTER_SCHEMA_VERSION = 1

/**
 * SessionAuthPort의 실 어댑터 — 주입된 verifier seam + Mongo 저장소 위에 구현한다.
 *
 * firebase-admin을 직접 import하지 않는다(Story 7이 부팅에서 조립). 생성자로 verifier·
 * accounts·characters를 주입받으며 전역 싱글턴을 조회하지 않는다.
 *
 * 매핑 규약: CharacterSummary.characterId = Character._id. 영속 Character에는 level 필드가
 * 없으므로(파생 스탯, #80 stats-core로 유예) 요약의 level은 dev 기본값 1로 채운다.
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
    return { accountId }
  }

  // verify RESULT는 캐싱하지 않는다 — verify는 연결/업그레이드당 1회 실행이지 프레임당 실행이
  // 아니므로 결과 캐시가 불필요하다. dedup은 오직 멱등 upsert WRITE의 반복만 막는다(Open Q #1/#3).
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
    // 미존재와 타 계정 소유를 한 에러로 합친다(존재 여부 비노출 — 포트 계약 준수).
    if (doc === null || doc.accountId !== accountId) {
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

  /** 영속 Character → 와이어 CharacterSummary 매핑(characterId=_id, level=1 dev 기본값). */
  private toSummary(doc: Character): CharacterSummary {
    return {
      characterId: doc._id,
      name: doc.name,
      class: doc.class,
      race: doc.race,
      // level은 영속에 없다 — 파생 level은 #80 stats-core에서 온다. 그때까지 dev 기본값 1.
      level: 1,
    }
  }
}
