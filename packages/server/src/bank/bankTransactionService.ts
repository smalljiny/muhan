import type { Collection, Db, MongoClient } from 'mongodb'
import { MAX_BANK_GOLD, type BankAccount, type Character } from 'shared'
import { DocumentNotFoundError } from '../repo/types.js'

/**
 * 은행 거래 서비스 — 캐릭터↔은행 gold 이동을 2-문서 원자적 트랜잭션으로 수행한다.
 *
 * 돈 무결성이 임무이므로 입금·출금은 반드시 all-or-nothing으로 커밋한다. 두 컬렉션
 * (characters·bankAccounts)에 걸친 갱신을 `session.withTransaction`으로 감싸, 부분 커밋
 * (한쪽만 반영)이 절대 발생하지 않게 한다. Convenient API인 withTransaction은 transient
 * transaction 에러·commit 재시도를 내장하므로 그대로 사용한다. 트랜잭션 콜백 내 단계는
 * 같은 세션에서 순차 실행한다 — 드라이버가 동일 세션의 병렬 작업(Promise.all)을 금지한다.
 *
 * 잔액·상한 가드는 findOneAndUpdate의 조건부 필터로 구현한다(read-modify-write race 없이
 * 원자적 CAS). 필터에 매칭되는 문서가 0건이면 결과가 null이며, 콜백에서 에러를 throw해
 * withTransaction이 트랜잭션을 abort하게 한다(swallow 금지 → 부분 커밋 없음).
 *
 * 이 서비스는 repo 계층(IRepository)의 Zod 경계 검증을 우회해 컬렉션에 직접 findOneAndUpdate한다
 * — repo.updateById는 session·조건부 필터를 지원하지 않기 때문이다. 대신 CAS 가드 필터가 같은
 * 불변식을 인라인으로 강제한다: `$gte:amt`가 비음수(음수 잔액 불가), `$lte:3억−amt`가 상한을
 * 대신한다. 스키마 위반 write는 도달 불가능하다.
 *
 * 에러 구분의 한계(가드-CAS 본질): 가드된 필터의 매칭0은 "문서 부재"와 "값 위반"을 구분하지
 * 못한다 — 존재하지 않는 은행 계좌 입금은 BankCapExceededError로, 존재하지 않는 캐릭터 차감은
 * InsufficientFundsError로 표면화된다. 어느 경우든 돈은 이동하지 않고 트랜잭션이 abort되므로
 * 무결성 문제가 아닌 진단 정확도 한계다. 호출자가 부재/위반을 구분해야 하면 트랜잭션 내 존재
 * 사전조회를 추가한다(후속 seam).
 *
 * 불변식 6(은행 gold 상한 3억, 오라클 bank.c:314 유래): 입금은 value+amt ≤ 3억일 때만
 * 성공한다. MAX_BANK_GOLD 조건부 필터가 이를 원자적으로 강제한다.
 *
 * Open Q 3(character.gold 상한 유예): character 스키마는 min0-only(상한 없음)다. 출금
 * 크레딧은 character.gold에 상한을 부과하지 않는다 — 상한 정책이 확정되면 이 seam에
 * 대칭 가드를 추가한다.
 */

// 불변식 6(은행 gold 상한 3억)의 단일 출처는 shared의 MAX_BANK_GOLD다 — 스키마 `.max()`와
// 아래 CAS 가드가 같은 상수를 공유해 상한이 분열하지 않는다. 로컬 재정의를 두지 않는다.

const CHARACTERS_COLLECTION = 'characters'
const BANK_ACCOUNTS_COLLECTION = 'bankAccounts'

/** 잔액·잔고 부족(조건부 필터가 매칭0)으로 거래가 불가능할 때 던진다. */
export class InsufficientFundsError extends Error {
  constructor(collection: string, id: string, amount: number) {
    super(`잔액이 부족하거나 대상이 없습니다: ${collection}/${id} (요청 ${amount})`)
    this.name = 'InsufficientFundsError'
  }
}

/** 입금이 은행 gold 상한(3억, 불변식 6)을 초과할 때 던진다. */
export class BankCapExceededError extends Error {
  constructor(id: string, amount: number) {
    super(`은행 잔고 상한(${MAX_BANK_GOLD})을 초과합니다: bankAccounts/${id} (입금 ${amount})`)
    this.name = 'BankCapExceededError'
  }
}

/** amount가 양의 정수인지 검증한다. 아니면 트랜잭션 시작 전 throw. */
function assertPositiveIntAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`거래 금액은 양의 정수여야 합니다: ${amount}`)
  }
}

/**
 * id가 비어 있지 않은 문자열인지 검증한다. TypeScript 타입은 런타임에 소거되므로, characterId·
 * bankAccountId가 객체로 유입되면 findOneAndUpdate 필터의 `_id` 자리에서 Mongo 연산자 주입
 * (`{$ne:...}`, `{$gt:''}` 등)으로 임의 문서를 대상 삼아 gold를 이동시킬 수 있다. 이 서비스는
 * repo 계층의 Zod 경계를 우회하므로, money 이동 진입점에서 id 형태를 직접 강제한다(security.md).
 */
function assertDocumentId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}는 비어 있지 않은 문자열이어야 합니다`)
  }
}

export class BankTransactionService {
  // 생성자 주입: MongoClient(startSession용)와 Db. 전역 싱글턴을 조회하지 않는다.
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}

  private get characters(): Collection<Character> {
    return this.db.collection<Character>(CHARACTERS_COLLECTION)
  }

  private get bankAccounts(): Collection<BankAccount> {
    return this.db.collection<BankAccount>(BANK_ACCOUNTS_COLLECTION)
  }

  /**
   * 입금(캐릭터→은행). character.gold −amt, bankAccount.gold +amt를 한 트랜잭션에서 커밋한다.
   *
   * step1: character.gold ≥ amt 조건에서 차감(부족·부재 시 매칭0 → InsufficientFundsError).
   * step2: bankAccount.gold ≤ 3억−amt 조건에서 가산(상한 초과·부재 시 매칭0 → BankCapExceededError).
   * 두 단계 중 하나라도 매칭0이면 콜백 throw → withTransaction abort(부분 커밋 없음).
   */
  async deposit(characterId: string, bankAccountId: string, amount: number): Promise<void> {
    assertPositiveIntAmount(amount)
    assertDocumentId(characterId, 'characterId')
    assertDocumentId(bankAccountId, 'bankAccountId')

    const session = this.client.startSession()
    try {
      await session.withTransaction(async () => {
        const debited = await this.characters.findOneAndUpdate(
          { _id: characterId, gold: { $gte: amount } },
          { $inc: { gold: -amount } },
          { session, returnDocument: 'after' },
        )
        if (debited === null) {
          throw new InsufficientFundsError(CHARACTERS_COLLECTION, characterId, amount)
        }

        const credited = await this.bankAccounts.findOneAndUpdate(
          { _id: bankAccountId, gold: { $lte: MAX_BANK_GOLD - amount } },
          { $inc: { gold: amount } },
          { session, returnDocument: 'after' },
        )
        if (credited === null) {
          throw new BankCapExceededError(bankAccountId, amount)
        }
      })
    } finally {
      await session.endSession()
    }
  }

  /**
   * 출금(은행→캐릭터). bankAccount.gold −amt, character.gold +amt를 한 트랜잭션에서 커밋한다.
   *
   * step1: bankAccount.gold ≥ amt 조건에서 차감(부족·부재 시 매칭0 → InsufficientFundsError).
   * step2: character.gold 가산(상한 미부과, Open Q 3). character 부재 시 매칭0 →
   *        DocumentNotFoundError(repo 계층 관례와 일관). 어느 단계든 매칭0이면 abort.
   */
  async withdraw(characterId: string, bankAccountId: string, amount: number): Promise<void> {
    assertPositiveIntAmount(amount)
    assertDocumentId(characterId, 'characterId')
    assertDocumentId(bankAccountId, 'bankAccountId')

    const session = this.client.startSession()
    try {
      await session.withTransaction(async () => {
        const debited = await this.bankAccounts.findOneAndUpdate(
          { _id: bankAccountId, gold: { $gte: amount } },
          { $inc: { gold: -amount } },
          { session, returnDocument: 'after' },
        )
        if (debited === null) {
          throw new InsufficientFundsError(BANK_ACCOUNTS_COLLECTION, bankAccountId, amount)
        }

        // character.gold 상한 미부과(Open Q 3) — 존재만 확인한다.
        const credited = await this.characters.findOneAndUpdate(
          { _id: characterId },
          { $inc: { gold: amount } },
          { session, returnDocument: 'after' },
        )
        if (credited === null) {
          throw new DocumentNotFoundError(CHARACTERS_COLLECTION, characterId)
        }
      })
    } finally {
      await session.endSession()
    }
  }
}
