# 은행 물품 보관

> 오브젝트를 캐릭터↔은행 계좌 사이에서 owner 재지정으로 이동하는 서비스. A8 §9(오라클 `bank.c` `input_bank`/`output_bank`) 이식(이슈 #87). 은행 **현금** 입출금은 별도([`save-policy.md`](save-policy.md) `bankTransactionService`).

## 개요

은행 물품 보관(`보관물`)·인출(`받아`)을 **object.owner 재지정**으로 이식한다. 보관 집합은 `object.owner={type:'bank', id: bankAccountId}` 역참조로 파생하며, slot 사용량도 이 파생 집합의 길이로 계산한다 — 별도 카운터·`items[]` 배열을 저장하지 않는다(스키마 무변경 D1/D6). 보관/인출은 `object.owner`만 바꾸고 `slot`·`equipped`·`shotscur` 등 다른 필드는 건드리지 않는다.

`BankItemService`는 생성자 주입으로 `ObjectRepository`·`BankRepository`를 받는다(전역 싱글턴 미사용). 두 저장소는 DIP seam이며, 서비스는 `object.ts`·`bankAccount` 스키마를 import하지 않는다.

## 구조

`packages/server/src/bank/bankItemService.ts` — `BankItemService` 클래스. 상수·에러:

| 심볼 | 의미 |
|------|------|
| `BANK_SLOT_LIMIT = 200` | slot 한도(오라클 `shotsmax`). 보관 집합 길이가 이 값 이상이면 거부 |
| `BankSlotFullError` | slot 200 초과 보관 시도(오라클 `shotscur >= shotsmax`) |
| `ContainerNotStorableError` | 컨테이너(OCONTN, "보따리 종류") 보관 시도 |
| `InvalidOwnerError` | 오브젝트가 기대 소유 상태가 아님(보관=해당 캐릭터 소유, 인출=해당 은행 소유) |
| `assertDocumentId` | `objectId`·`bankAccountId`·`characterId`가 비어 있지 않은 문자열인지 강제 |

slot 파생은 `BankRepository.hydrateHoldings(bankAccountId)`(= `objects.findByOwner({type:'bank', id})`) 길이로 계산한다.

## 동작

### 보관 (bankStore, 캐릭터→은행)

`object.owner`를 `{type:'character', id}` → `{type:'bank', id: bankAccountId}`로 재지정한다. 오라클 순서(`input_bank`, `bank.c:167-179`)를 그대로 따른다:

1. **가드** — `objectId`·`bankAccountId`·`characterId`를 `assertDocumentId`로 강제(Mongo 연산자 주입 차단).
2. **slot 한도 FIRST** — `hydrateHoldings` 길이 `>= 200`이면 `BankSlotFullError`. 은행이 가득 차면 아이템을 fetch·이동하지 않는다.
3. **OCONTN 컨테이너 SECOND** — `isContainer`(caller가 템플릿에서 해석)이면 `ContainerNotStorableError`.
4. **소유권 확인** — `findById` 후 `obj.owner.type==='character' && obj.owner.id===characterId`가 아니면 `InvalidOwnerError`. 보관하는 캐릭터 *자신*의 아이템만 보관 가능(다른 캐릭터·은행·바닥 아이템 불가) — `bankWithdraw`의 `owner.id===bankAccountId`와 대칭(actor↔item 바인딩).
5. **owner 재지정** — `objects.updateById(objectId, { owner: {type:'bank', id: bankAccountId} })`. 다른 필드 불변.

slot·OCONTN 검사가 관찰 가능한 순서다: 가득 찬 은행에 컨테이너를 넣으면 slot 한도 에러가 먼저 난다.

### 인출 (bankWithdraw, 은행→캐릭터)

`object.owner`를 `{type:'bank', id}` → `{type:'character', id: characterId}`로 재지정한다. `findById` 후 `obj.owner.type==='bank' && obj.owner.id===bankAccountId`가 아니면 `InvalidOwnerError` — 해당 은행 계좌 소유 아이템만 인출 가능하다.

### OCONTN 판정 위치

OCONTN(컨테이너, bit-6)은 템플릿(objmon) 플래그이고 `object.ts`에는 `flags` 필드가 없다(D1/D6 동결). 서비스는 이를 저장 문서에서 읽지 않고 caller가 템플릿에서 해석한 `isContainer` 결과를 받는다.

## 제약사항

- **스키마 무변경(D1/D6)** — `bankAccount` 문서에 `items[]` 배열을 두지 않는다. 보관 집합은 `object.owner={type:'bank'}` 역참조로 파생하고 slot 사용량도 파생 집합 길이로 계산한다. `object.ts`·`bankAccount` 스키마 무변경.
- **은행 tenant 인증 유예(#106/전용 이슈)** — 서비스는 아이템이 해당 은행/캐릭터 소유인지는 보지만, 넘어온 `bankAccountId`가 `characterId` *본인의* 계좌인지는 검증하지 않는다(`bankAccount.owner`를 소비하지 않는다). caller가 타인의 `bankAccountId`를 주입/재생하면 타 계좌 아이템을 인출할 수 있다. 이는 이미-머지된 `bankTransactionService`(`_id`+gold 조건만 필터, `bankAccount.owner` 미검증)와 **동일한 표준 아키텍처**이며, 인증은 인증된 actor/계좌를 공급하는 #106 live-routing 계층에 할당된다. 서비스 계층 tenant-auth는 두 은행 서비스+spec을 함께 고치는 별도 하드닝 결정이다(리뷰 [critical] deferred).
- **재지정 대상 존재 확인 미포함(#106)** — `bankStore`는 목적지 `bankAccount` 존재를, `bankWithdraw`는 목적지 `character` 존재를 검증하지 않는다(존재하지 않는 id로 재지정하면 오브젝트 고아 가능). #106이 인증된 actor의 계좌/캐릭터 id를 공급하므로 seam 범위에선 유예하며, 라이브 배선 시 `banks.findById` 존재 확인을 추가해 deposit CAS와 대칭화한다.
- **check-then-write 비원자성 TOCTOU(#106/atomicity)** — 소유권·slot 검사와 이어지는 `updateById`(owner 재지정)는 원자적이지 않다 — 동시 호출이 검사를 통과한 뒤 서로의 write와 레이스할 수 있다(같은 아이템 이중 이동, slot 한도 오버슈트). 라이브 배선은 조건부 `findOneAndUpdate`(owner를 필터에 넣은 CAS, 새 `ObjectRepository` 조건부 갱신 primitive 필요)로 검사-쓰기를 하나의 원자 연산으로 합치거나 soft-limit 오버슈트를 수용해야 한다. 단일 프로세스 1Hz 틱이 현재는 실질적으로 레이스를 완화한다(리뷰 [high]·M2 deferred).
- **fetch 순서 divergence** — 오라클은 `find_obj`(인벤토리 조회)를 slot·OCONTN 검사보다 먼저 하지만, 본 서비스는 slot·OCONTN을 먼저 검사한 뒤 `findById`한다. 가득 찬 은행에 미소유 오브젝트를 넣으면 오라클은 "그런 물건 없음"을, 본 서비스는 `BankSlotFullError`를 낸다 — #106이 호출 전 인벤토리에서 오브젝트를 해석하므로 배선 경로에선 관찰되지 않는 양성 재정렬이다.
- **라이브 command 라우팅 유예(#106)** — `보관물`/`받아` 명령 파싱·라우팅은 #106 소관이다.

## 관련 문서

- **oracle**: `docs/notes/game-analysis-20260625/a8-items-economy.md`(§9 은행) · `legacy/muhan/src/bank.c`(`input_bank`/`output_bank`)
- **의존 자산**: [persistence.md](persistence.md)(`object.owner` 단일소유·`BankRepository.hydrateHoldings`·bankAccount 스키마) · [items-equipment.md](items-equipment.md)(object owner)
- **형제 시스템**: [economy.md](economy.md)(금화·상점·전당포·수리·소지 한도 G1~G7) · [save-policy.md](save-policy.md)(은행 현금 트랜잭션 `bankTransactionService`)
- **후속**: #106(라이브 command 라우팅·tenant 인증·이동 원자성)
