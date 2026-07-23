import { DocumentNotFoundError } from '../repo/types.js'
import type { ObjectRepository } from '../repo/objectRepository.js'
import type { BankRepository } from '../repo/bankRepository.js'

/**
 * 은행 아이템 보관/인출 서비스 — 오브젝트를 캐릭터↔은행 계좌 사이에서 owner 재지정으로 이동한다
 * (A8 §9, 오라클 bank.c input_bank/output_bank).
 *
 * 스키마 불변(D1/D6): bankAccount 문서에 items[] 배열을 두지 않는다. 은행 보관 집합은
 * object.owner={type:'bank', id: bankAccountId} 역참조로 파생하며(hydrateHoldings), slot
 * 사용량도 이 파생 집합의 길이로 계산한다 — 별도 카운터를 저장하지 않는다. 보관/인출은
 * object.owner만 바꾸고 slot·equipped·shotscur 등 다른 필드는 건드리지 않는다.
 *
 * 오라클 거부 순서(input_bank, bank.c:167-179)를 그대로 따른다:
 *   1) slot 한도 검사(shotscur >= shotsmax=200) FIRST — 은행이 가득 차면 거부.
 *   2) OCONTN 컨테이너 검사 SECOND — "보따리 종류는 보관할 수 없습니다".
 * 이 순서가 관찰 가능하다: 가득 찬 은행에 컨테이너를 넣으면 slot 한도 에러가 먼저 난다.
 *
 * OCONTN(컨테이너) 판정은 caller가 해결한다(isContainer). object.ts는 flags 필드가 없고
 * OCONTN은 템플릿(objmon) bit-6 플래그이므로, 서비스는 이를 저장 문서에서 읽지 않고 caller가
 * 템플릿에서 해석한 결과를 받는다(object.ts 고정, D1/D6).
 *
 * 보안(security.md): objectId·bankAccountId·characterId는 findById/updateById/역참조 필터의
 * `_id`·owner.id 자리에 들어가므로, DB 접근 전에 형태를 강제해 Mongo 연산자 주입
 * (`{$ne:...}` 등)을 차단한다.
 *
 * #106 caller-wiring으로 유예된 검증(기록된 결정):
 *   - 재지정 *대상* 존재 확인 미포함: bankStore는 목적지 bankAccount 존재를, bankWithdraw는
 *     목적지 character 존재를 검증하지 않는다(존재하지 않는 id로 재지정하면 오브젝트가 고아가 될
 *     수 있다). #106이 인증된 actor의 계좌/캐릭터 id를 공급하므로 seam 범위에선 유예한다 —
 *     라이브 배선 시 bankStore 앞에 `banks.findById` 존재 확인을 추가해 deposit CAS와 대칭화한다.
 *   - fetch 순서 divergence: 오라클은 find_obj(인벤토리 조회)를 slot·OCONTN 검사보다 먼저 하지만,
 *     본 서비스는 slot·OCONTN을 먼저 검사한 뒤 findById한다. 가득 찬 은행에 미소유 오브젝트를
 *     넣으면 오라클은 "그런 물건 없음"을, 본 서비스는 BankSlotFullError를 낸다 — #106이 호출 전
 *     인벤토리에서 오브젝트를 해석하므로 배선 경로에선 관찰되지 않는 양성 재정렬이다.
 */

/** slot 한도(오라클 shotsmax, A8 §9). 보관 집합 길이가 이 값 이상이면 거부한다. */
export const BANK_SLOT_LIMIT = 200

/** 은행 slot 한도(200)를 초과한 보관 시도에서 던진다(오라클 shotscur>=shotsmax). */
export class BankSlotFullError extends Error {
  constructor(bankAccountId: string) {
    super(`은행에 더이상 넣을 수 없습니다(한도 ${BANK_SLOT_LIMIT}): bankAccounts/${bankAccountId}`)
    this.name = 'BankSlotFullError'
  }
}

/** 컨테이너(OCONTN, 보따리 종류) 보관 시도에서 던진다. */
export class ContainerNotStorableError extends Error {
  constructor(objectId: string) {
    super(`보따리 종류는 보관할 수 없습니다: objects/${objectId}`)
    this.name = 'ContainerNotStorableError'
  }
}

/** 오브젝트가 기대한 소유 상태가 아닐 때 던진다(보관은 character 소유만, 인출은 해당 은행 소유만). */
export class InvalidOwnerError extends Error {
  constructor(objectId: string, expected: string) {
    super(`오브젝트 소유 상태가 올바르지 않습니다: objects/${objectId} (기대: ${expected})`)
    this.name = 'InvalidOwnerError'
  }
}

/**
 * id가 비어 있지 않은 문자열인지 검증한다. TypeScript 타입은 런타임에 소거되므로, id가 객체로
 * 유입되면 `_id`·owner.id 필터 자리에서 Mongo 연산자 주입이 가능하다. DB 접근 전에 강제한다.
 */
function assertDocumentId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}는 비어 있지 않은 문자열이어야 합니다`)
  }
}

export class BankItemService {
  // 생성자 주입: 저장소를 외부에서 주입받는다(전역 싱글턴 미사용).
  constructor(
    private readonly objects: ObjectRepository,
    private readonly banks: BankRepository,
  ) {}

  /**
   * 보관(캐릭터→은행). object.owner를 {type:'bank', id: bankAccountId}로 재지정한다.
   *
   * 오라클 순서: 가드 → slot 한도(FIRST) → OCONTN(SECOND) → 소유권 확인 → owner 재지정.
   * slot 한도는 hydrateHoldings 길이로 파생하며, 가득 차면 아이템을 fetch·이동하지 않는다.
   */
  async bankStore(params: { objectId: string; bankAccountId: string; isContainer: boolean }): Promise<void> {
    const { objectId, bankAccountId, isContainer } = params
    assertDocumentId(objectId, 'objectId')
    assertDocumentId(bankAccountId, 'bankAccountId')

    // 1) slot 한도 검사 FIRST(오라클 shotscur >= shotsmax). 파생 카운트 = holdings 길이.
    const holdings = await this.banks.hydrateHoldings(bankAccountId)
    if (holdings.length >= BANK_SLOT_LIMIT) {
      throw new BankSlotFullError(bankAccountId)
    }

    // 2) OCONTN 컨테이너 거부 SECOND(caller가 템플릿에서 해석한 isContainer).
    if (isContainer) {
      throw new ContainerNotStorableError(objectId)
    }

    // 3) fetch + 소유권 확인 — character 소유 아이템만 보관 가능(이미 은행/바닥 아이템 불가).
    const obj = await this.objects.findById(objectId)
    if (obj === null) {
      throw new DocumentNotFoundError('objects', objectId)
    }
    if (obj.owner.type !== 'character') {
      throw new InvalidOwnerError(objectId, 'character 소유')
    }

    // 4) owner만 재지정한다(다른 필드 불변).
    await this.objects.updateById(objectId, { owner: { type: 'bank', id: bankAccountId } })
  }

  /**
   * 인출(은행→캐릭터). object.owner를 {type:'character', id: characterId}로 재지정한다.
   *
   * 해당 은행 계좌 소유 아이템만 인출 가능하다 — 다른 계좌·캐릭터 소유면 InvalidOwnerError.
   */
  async bankWithdraw(params: { objectId: string; bankAccountId: string; characterId: string }): Promise<void> {
    const { objectId, bankAccountId, characterId } = params
    assertDocumentId(objectId, 'objectId')
    assertDocumentId(bankAccountId, 'bankAccountId')
    assertDocumentId(characterId, 'characterId')

    const obj = await this.objects.findById(objectId)
    if (obj === null) {
      throw new DocumentNotFoundError('objects', objectId)
    }
    if (obj.owner.type !== 'bank' || obj.owner.id !== bankAccountId) {
      throw new InvalidOwnerError(objectId, `bank 소유(${bankAccountId})`)
    }

    // owner만 재지정한다(다른 필드 불변).
    await this.objects.updateById(objectId, { owner: { type: 'character', id: characterId } })
  }
}
