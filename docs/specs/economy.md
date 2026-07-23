# 경제 (금화·상점·전당포·수리·소지 한도)

> 무한의 금화 경제와 상거래(구매·몹구매·전당포 판매·수리)·소지 한도를 순수 트랜잭션 함수 + 선언 가격 config로 이식한 시스템. A8 §7~8 이식(이슈 #87).

## 개요

이 시스템은 금화(gold)의 이동과 상거래 규칙을 **순수 함수**로 소유한다 — MongoDB·`Character`·`ObjectInstance`에 의존하지 않고 좁은 숫자·구조 입력만 다룬다. 영속화·바닥 배치·인벤토리 배선·재고 소싱·소유자 배선은 라이브 command 라우팅 계층(#106)의 책임이다.

네 축으로 구성된다:

- **금화 경제**(`moneyService`) — MONEY 오브젝트의 드롭·줍기·양도를 gold↔디스크립터 변환으로 통일.
- **가격 config**(`priceConfig`) — 구매·몹구매·판매·수리 가격 배수·상한을 선언 테이블 하나로 외부화.
- **상점 서비스**(`shopService`) — 상점 구매(buy)·몹상점 구매(purchase)·전당포 판매(sell)·수리(repair)의 게이트·거부조건·복제·RNG.
- **소지 한도**(`carry`) — 무게(재귀 합, `maxWeight` 소비)·개수 두 상한을 순수 predicate 하나로.

가격·판매·수리·소지 한도에는 골든 fixture가 있다(fixture 규약은 [`golden-fixture-harness.md`](golden-fixture-harness.md)). 결정적 RNG는 combat의 `CombatRng` seam([`combat.md`](combat.md))을 재사용한다.

**스키마 동결(D1)**: 어떤 모듈도 `object.ts`·`character.ts`·`schemaVersion`을 import하지 않는다. 각 서비스는 필요한 필드만 로컬 좁은 타입으로 선언해 cross-package import를 가격 공식 하나로 최소화한다 — 동시 워크트리의 schemaVersion bump와 병합 충돌을 원천 차단한다. gold는 기존 `character.gold` 필드를 소비만 한다.

## 구조

| 위치 | 모듈 | 책임 |
|------|------|------|
| `packages/shared/src/economy/` | `priceConfig.ts` | `PRICE_CONFIG` 선언 테이블 + `buyPrice`/`mobBuyPrice`/`sellPrice`/`repairCost` 순수 함수 |
| | `carry.ts` | `canCarry`·`weightOf`(재귀·OWTLES 제외) 순수 predicate |
| | `index.ts` | economy 배럴 재노출 |
| `packages/server/src/economy/` | `moneyService.ts` | MONEY 드롭/줍기/양도 — gold↔디스크립터 변환 |
| | `shopService.ts` | buy·purchase·sell·repair 트랜잭션 서비스 — 게이트·거부·복제·RNG |
| `packages/shared/src/oracle/` | `generators/priceFixture.ts`·`pawnFixture.ts`·`repairFixture.ts`·`carryFixture.ts` | 골든 fixture 생성기(SUT 독립 표현) |
| | `fixtures/price.json`·`pawn.json`·`repair.json`·`carry.json` | 체크인 골든 fixture(drift guard) |

## 동작

### 금화 경제 (moneyService)

MONEY 오브젝트(objnum 0 "동전", type 10)의 이동을 gold↔디스크립터 순수 변환으로 이식한다. 반환 `MoneyDescriptor`는 `{ objnum: 0, type: 10, value }`인 **소유자 없는 bare 디스크립터**이며 영속 `ObjectInstance`가 아니다 — 바닥 배치·소유자 배선은 #106의 몫이다.

| 함수 | 동작 | 거부 |
|------|------|------|
| `dropMoney(gold, amt)` | `goldAfter = gold − amt`, `money = {objnum:0,type:10,value:amt}` | `amt<1`(비양수·소수·NaN) · `amt>gold` |
| `pickupMoney(gold, money)` | `goldAfter = gold + money.value`(객체 흡수, free는 호출자) | (없음) |
| `giveMoney(fromGold, toGold, amt)` | `from−=amt`·`to+=amt`, 수수료 0(A8 §7 `give_money`) | `amt<1` · `amt>fromGold` |

거부 시 `InvalidMoneyAmountError`를 던지고 부분 결과를 반환하지 않는다. 금액(`amt`)은 `assertPositiveIntAmount`(≥1), 잔액(`gold`·`fromGold`·`toGold`·`money.value`)은 `assertNonNegativeIntBalance`(≥0 정수)로 진입점에서 검증한다 — 잔액은 0일 수 있어 금액 가드와 분리한다.

**gold 상한**은 서비스 계층에서 min0-only로 강제한다(스키마 `.max()` 미도입). 어떤 연산도 gold를 음수로 만들지 않는다(`amt>gold` 거부로 보장). 상한 VALUE는 유예 — `bankTransactionService.withdraw`가 min0-only인 것과 대칭이다.

### 가격 config (priceConfig)

원본이 각 명령 핸들러에 흩어 하드코딩한 배수·상한을 선언 테이블 `PRICE_CONFIG`(`mobFloor:10`·`sellCap:100000`·`sellDivisor:2`·`repairDivisor:4`) 하나로 모은다. 네 함수가 이 테이블만 소비한다.

| 함수 | 공식 | 오라클 |
|------|------|--------|
| `buyPrice(value)` | `value`(정가 1:1, 복제·무소진이라 배수 1) | `command7.c:169` |
| `mobBuyPrice(value)` | `max(10, value)`(저가도 최소 10) | `command10.c:573` |
| `sellPrice(value)` | `min(trunc(value/2), 100000)`(50% 환급, 10만 상한) | `command7.c:258` |
| `repairCost(value)` | `trunc(value/4)`(정가 25%) | `command8.c:249` |

정수 나눗셈은 `Math.trunc`(0 방향 절삭)로 C 정수 나눗셈 의미를 명시한다(`value` 비음수라 `Math.floor`와 결과 동일). 입력 검증은 두지 않는다 — 소비자가 검증된 `object.value`를 넘긴다.

### 상점 구매 (buy, RSHOPP)

`buy(char, shopItem)` — 상점은 복제·무소진이므로 재고 원본을 변이하지 않고 **소유자 없는 클론 디스크립터**를 반환한다. 클론(`cloneShopItem`)은 좁은 필드를 명시 선택해 구성한다(spread 아님) — 넓은 인스턴스를 넘겨도 `_id`·`owner` 여분 필드가 새 나가지 않는다.

- 게이트: `gold < buyPrice(value)` → `insufficient-gold`.
- 개수: 구매 *전* `invCount > 200` → `count-limit`(오라클 pre-purchase strict `>` 경계, 정확히 200 보유자는 성공).
- 성공: `goldAfter = gold − value`.

재고 소싱 위치는 유예한다 — `shopItem`을 파라미터로 받고 `rom_num+1` 인접방 규칙(D5)을 재현하지 않는다. 오라클이 클론 직후 하는 영구 플래그 해제(OPERM2/OPERMT/OTEMPP)는 `ShopItem`이 플래그를 담지 않으므로 완전 인스턴스 배선 시점에 #106이 수행한다.

### 몹상점 구매 (purchase, MPURIT)

`purchase(char, item)` — 몹은 템플릿을 무한 복제하므로 buy와 동일하게 소유자 없는 클론을 반환한다. 어느 템플릿을 클론할지(몹 `carry[]`에서 itemRef→템플릿 해석)는 #106의 책임이며, purchase는 이미 해석된 템플릿 아이템을 받는다.

- 게이트: `gold < mobBuyPrice(value)`(= `max(10, value)`) → `insufficient-gold`.
- 개수: 취득 *전* `invCount > 150` → `count-limit`(buy와 동일 strict `>` 경계, 정확히 150 보유자는 성공).
- 성공: `goldAfter = gold − price`.

### 전당포 판매 (sell, RPAWNS)

`sell(char, item, ctx)` — 판매가는 `sellPrice(value)`를 소비한다. 거부 매트릭스는 오라클 cascade 순서를 그대로 따르며, 다섯 게이트를 **모두 통과한 뒤에만** RNG를 1회 굴린다(거부 케이스는 RNG 미소비).

| 순서 | 거부 조건 | reason |
|------|-----------|--------|
| 1 | `payout < 20`(= `value<40`과 동치; 100000 상한은 이 경계 무영향) | `low-value` |
| 2 | 저품질: `(type≤MISSILE(4) \|\| type==ARMOR(5)) && shotscur ≤ trunc(shotsmax/8)`(마모 장비·투척) 또는 `(type==WAND(8) \|\| type==KEY(11)) && shotscur < 1`(방전 충전물) | `low-quality` |
| 3 | `onewev`(ONEWEV, 개인 귀속) | `bound-item` |
| 4 | `hasContents`(비빈 컨테이너) | `non-empty-container` |
| 5 | `type == SCROLL(7) \|\| type == POTION(6)` | `unsellable-type` |

**1/250 이중 지급**: 다섯 게이트 통과 후 `ctx.rng(1, 250) === 9`(오라클 `((time(0)+mrand(1,100))%250)==9`의 `==9` 상수)이면 payout에 `sellPrice`를 한 번 더 더한다 → lucky payout = `2*sellPrice`. A8 §10-e에 따라 오라클의 `time(0)` 벽시계 의존은 버리고 확률 1/250(콘텐츠)만 보존한다.

### 수리 (repair, RREPAI)

`repair(char, item, ctx)` — 수리비를 선차감한 뒤 piety 보정 실패 굴림을 던진다. 실패하면 수리비를 환불(net 0)하고 아이템을 파괴(`item: null`)하며, 성공하면 내구도를 복원한다.

1. `cost = repairCost(value)`(= `trunc(value/4)`). `gold < cost` → `insufficient-gold`.
2. `gold −= cost`(선차감) 후 `broke = rng(1,100) + bonusOf(piety)`([`stats-core.md`](stats-core.md) `bonusOf` 소비).
3. **실패** = `(broke ≤ 15 && shotscur < 1) || (broke ≤ 5 && shotscur > 0)` → `gold += cost`(환불) + 아이템 파괴.
4. **성공** = `shotscur' = trunc(shotsmax * rng(5,9) / 10)`(곱 위에서 절삭). `goldAfter = gold − cost`.

RNG 순서: `broke(1,100)`를 먼저 굴리고, **성공일 때만** `durability(5,9)`를 굴린다 — 실패는 굴림 1회, 성공은 2회다.

### 소지 한도 (carry)

원본이 각 명령 핸들러에 흩어 검사하는 무게 상한(`object.c weight_obj` 재귀 + `player.c max_weight`)과 개수 상한을 순수 predicate 하나로 모은다. 예외를 던지지 않고 boolean을 반환한다 — 거부 처리는 server 소관.

- `weightOf(node)` — 재귀 무게 합(`object.c weight_obj` 이식). `n = node.weight`에서 시작해 **자식이** `weightless`(OWTLES, bit 7)가 아닐 때만 그 서브트리 무게를 더한다.
- `canCarry(char, node, mode)`:
  - 개수: `invCount > limit`이면 `false`(strict `>`). limit는 `buy` 200, `get`/`give`/`purchase` 150.
  - 무게: `weightCarried + weightOf(node) > maxWeight(context)`이면 `false`. `maxWeight`는 [`stats-core.md`](stats-core.md) `stats/derived`가 정본이다 — `20 + str*10 + barbarian` 공식을 재유도하지 않는다.

**OWTLES 재귀 규칙(결정적 함정)**: OWTLES 자식은 자기 무게도 내용물도 합산에서 제외된다(서브트리 전체 skip). 반면 무게를 재는 **최상위 노드 자신의 무게는 항상 계산된다** — OWTLES 플래그는 오직 부모의 순회에서만 소비되기 때문이다. `owner`/`template` 해결(플래그를 어디서 읽는지)은 이 모듈 밖(#106)이며, 소비자가 순수 `WeightNode` 트리로 구조를 넘긴다.

## 제약사항

- **스키마 무변경(D1)** — `object.ts`·`character.ts`·`characterSchema`·`schemaVersion` 무변경. gold는 기존 `gold: int().min(0)` 필드를 소비만 한다.
- **입력 self-defense** — 각 서비스는 진입점에서 gold·value·shotscur 등을 0 이상 정수로 강제한다(`assertNonNegativeInt`/`assertNonNegativeIntBalance`). 음수·소수·NaN은 가격/잔액 산술을 gold 생성·손실 벡터로 만들므로 `invalid-input`으로 거부한다. 유효 입력의 동작은 바꾸지 않는다.
- **RNG seam(D4)** — 새 seam 파일을 만들지 않는다. sell·repair는 combat의 `CombatRng`(`packages/server/src/combat/dice.ts`)를 직접 주입받고, RNG 분기 결정은 server 서비스에 둔다. 오라클의 `time(0)` 벽시계 의존은 버리고 확률·공식은 콘텐츠로 보존한다.
- **재고 소싱 위치 유예(D5, Open Q#2)** — buy는 `shopItem`을, purchase는 해석된 템플릿을 파라미터로 받는다. 월드 데이터 확장 vs 상점 config vs 인접방 규칙 이식은 결정하지 않으며, `rom_num+1` 인접 규칙은 재현하지 않는다.
- **gold 상한 값 유예(Open Q#3)** — service-layer·min0-only. 수치 상한은 발명하지 않으며 `bankTransactionService` Open Q3와 함께 확정한다.
- **라이브 command 라우팅 유예** — `구매`/`판매`/`수리`/`양도` 명령 파싱·라우팅, 영속화·바닥 배치·인벤토리 이동·소유자 배선은 #106 소관이다. 이 시스템은 순수 서비스·seam만 제공한다.
- **trade 물물교환 미이식(Open Q#4)** — A8 §8·§10-g의 미완성 로직은 유예한다.

## 관련 문서

- **oracle**: `docs/notes/game-analysis-20260625/a8-items-economy.md`(§7 금화 경제·§8 상점/전당포/수리·§10 형상버그) · `legacy/muhan/src/`(`command7.c` buy/sell·`command8.c` repair·`command10.c` purchase·`command2.c` money·`creature.c` drop)
- **의존 스펙**: [items-equipment.md](items-equipment.md)(object·value·weight·owner 소비) · [stats-core.md](stats-core.md)(`maxWeight`·`bonusOf` 소비) · [combat.md](combat.md)(`CombatRng` seam 재사용) · [golden-fixture-harness.md](golden-fixture-harness.md)(fixture 규약)
- **형제 시스템**: [bank-items.md](bank-items.md)(은행 물품 보관 G8) · [save-policy.md](save-policy.md)(은행 현금 트랜잭션 `bankTransactionService`)
- **후속**: #106(라이브 command 라우팅) · #43(write-behind 라이브 강제)
