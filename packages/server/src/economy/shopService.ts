/**
 * 상점 서비스 순수 함수 — A8 §8(RSHOPP 상점)의 매매·수리를 gold-게이트 순수 변환으로 이식한다.
 * MongoDB·Character·ObjectInstance에 의존하지 않고 좁은 구조 입력만 다룬다. 영속화·인벤토리
 * 배선(_id·owner·slot·schemaVersion)·재고 소싱은 호출자(#106, 후속 토픽)의 책임이다.
 *
 * 입력 self-defense: 각 함수는 진입점에서 숫자 입력(gold·invCount·value·piety·shotscur·shotsmax)을
 * assertNonNegativeInt로 0 이상 정수로 강제한다 — 음수·소수·NaN이면 가격/잔액 산술이 gold 생성·손실
 * 벡터가 되므로(예: 음의 value → 음의 price → gold 증가) invalid-input으로 거부한다. moneyService/
 * bankTransactionService의 assertPositiveIntAmount 가드와 동형이며 유효 입력의 동작은 바꾸지 않는다.
 *
 * D1(스키마 동결): 이 모듈은 shared의 object.ts·character.ts·schemaVersion을 import하지 않는다.
 * ShopItem·BuyerState를 로컬 좁은 타입으로 정의해 cross-package import를 가격 공식(buyPrice)
 * 하나로 최소화, 동시 worktree의 schemaVersion bump와 병합 충돌을 원천 차단한다.
 *
 * 가격 단일 출처: 구매가는 shared의 buyPrice(정가 1:1, 복제·무소진이므로 배수 1)를 소비한다.
 * 공식을 재유도하지 않는다. 재고 소싱 위치(월드 데이터 vs 상점 설정)는 Open Q#2로 유예하며,
 * shopItem을 파라미터로 받아 D5(rom_num+1 인접 규칙) 같은 방 번호 로직을 두지 않는다.
 *
 * 확장 설계: buy는 shopService.ts의 첫 함수다. 후속 purchase(G4)·sell(G5)·repair(G6)가 같은
 * 파일에 추가되며 ShopRejectError·ShopRejectReason을 재사용한다. buy는 RNG가 없어 ctx 파라미터를
 * 두지 않는다 — G5/G6가 `ctx: { rng }`를 자체 시그니처에 도입한다.
 */

import { buyPrice, mobBuyPrice, sellPrice, repairCost, bonusOf } from 'shared'
import type { CombatRng } from '../combat/dice.js'

/**
 * 상점 재고/취득 아이템의 좁은 구조 입력 — 완전한 ObjectInstance가 아니다. 캐릭터 인벤토리
 * 배선(_id·owner·slot·schemaVersion)은 호출자(#106)가 소유한다.
 */
export interface ShopItem {
  readonly objnum: number
  readonly type: number
  readonly value: number
  readonly shotscur: number
}

/** buy가 char에서 판독하는 좁은 필드 — gold와 현재 인벤토리 개수(장착 포함 count_inv). */
export interface BuyerState {
  readonly gold: number
  readonly invCount: number
}

/**
 * 상점 거래 거부 사유 — buy(G3)는 gold 부족·개수 상한을 낸다. 후속 G4/G5/G6가 사유를 추가한다
 * (mob-count-limit·low-value·low-quality·bound-item·non-empty-container·unsellable-type ...).
 */
export type ShopRejectReason =
  | 'insufficient-gold'
  | 'count-limit'
  | 'low-value'
  | 'low-quality'
  | 'bound-item'
  | 'non-empty-container'
  | 'unsellable-type'
  | 'invalid-input'

/** 상점 거래가 규칙 게이트에 걸려 거부될 때 던진다. reason으로 사유를 구분한다. */
export class ShopRejectError extends Error {
  constructor(
    readonly reason: ShopRejectReason,
    message: string,
  ) {
    super(message)
    this.name = 'ShopRejectError'
  }
}

/**
 * 값이 음의 정수가 아닌지(즉 0 이상 정수) 검증한다. object.value·gold·shotscur 등 경제 입력이
 * 음수·소수·NaN이면 가격/잔액 산술이 gold 생성·손실 벡터가 되므로 진입점에서 거부한다
 * (moneyService.assertPositiveIntAmount와 동형의 self-defense).
 */
function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ShopRejectError('invalid-input', `${label}는 0 이상의 정수여야 합니다: ${value}`)
  }
}

/**
 * count_inv(장착 포함) 상한 — A8 §8/§13. 오라클(command7.c buy)은 구매 *전* 개수(cnt)를
 * strict `>`로 검사한다 — 정확히 200 보유자는 구매에 성공하고 201에서 종료한다. plan G7
 * canCarry의 `buy > 200` 기준과 동일 경계다.
 */
const BUY_COUNT_LIMIT = 200

/**
 * get/give/purchase 개수 상한 — A8 §8/§13. 몹 상점 취득(purchase)은 buy(200)와 다른 150 상한을
 * 쓴다. buy와 동일하게 취득 *전* invCount를 strict `>`로 검사한다 — 정확히 150 보유자는 취득에
 * 성공하고 151에서 종료한다. plan G7 canCarry의 `get/give/purchase > 150` 기준과 동일 경계다.
 */
const PURCHASE_COUNT_LIMIT = 150

/**
 * ShopItem 클론 — 좁은 필드를 명시적으로 선택해 새 객체를 만든다(spread 아님). 호출자가 넓은
 * 인스턴스를 넘겨도 _id·owner 같은 여분 필드가 새 나가지 않고 항상 소유자 없는 디스크립터가
 * 보장된다. buy·purchase가 공유한다(복제·무소진 규칙의 단일 구현).
 */
function cloneShopItem(item: ShopItem): ShopItem {
  return {
    objnum: item.objnum,
    type: item.type,
    value: item.value,
    shotscur: item.shotscur,
  }
}

/**
 * 상점 아이템을 구매한다(buy, A8 §8 RSHOPP). 상점은 복제·무소진이므로 재고 원본을 변이하지 않고
 * 소유자 없는 클론 디스크립터를 반환한다(_id·owner 배선은 #106의 몫). 오라클이 클론 직후 수행하는
 * 영구 플래그 해제(OPERM2/OPERMT/OTEMPP)는 ShopItem이 플래그를 담지 않으므로 완전 인스턴스
 * 배선 시점에 호출자(#106)가 수행한다.
 *
 * 게이트: gold < buyPrice(value)면 insufficient-gold로 거부. 개수는 구매 *전* invCount가 200을
 * 넘으면(invCount > 200) count-limit으로 거부한다 — 오라클 pre-purchase strict `>` 경계이며,
 * 정확히 200 보유자는 성공한다(부분 결과 없음). 성공 시 goldAfter = gold − value(오라클: gold -= value).
 *
 * 클론은 좁은 필드를 명시적으로 선택해 구성한다(spread 아님) — 호출자가 넓은 인스턴스를 넘겨도
 * _id·owner 같은 여분 필드가 새 나가지 않고 항상 소유자 없는 디스크립터가 보장된다.
 */
export function buy(
  char: BuyerState,
  shopItem: ShopItem,
): { goldAfter: number; item: ShopItem } {
  assertNonNegativeInt(char.gold, 'gold')
  assertNonNegativeInt(char.invCount, 'invCount')
  assertNonNegativeInt(shopItem.value, 'value')
  const price = buyPrice(shopItem.value)
  if (char.gold < price) {
    throw new ShopRejectError(
      'insufficient-gold',
      `gold가 부족합니다: 필요 ${price}, 보유 ${char.gold}`,
    )
  }
  if (char.invCount > BUY_COUNT_LIMIT) {
    throw new ShopRejectError(
      'count-limit',
      `인벤토리 개수 상한(${BUY_COUNT_LIMIT})을 초과합니다: 현재 ${char.invCount}`,
    )
  }
  return { goldAfter: char.gold - price, item: cloneShopItem(shopItem) }
}

/**
 * 몹 상점에서 아이템을 취득한다(purchase, A8 §8 MPURIT). 몹은 템플릿을 무한 복제하므로 재고 원본을
 * 변이하지 않고 소유자 없는 클론 디스크립터를 반환한다(_id·owner 배선은 #106의 몫). 어느 템플릿을
 * 클론할지 — 몹의 carry[]에서 itemRef→템플릿 해석 — 는 호출자(#106)의 책임이다. purchase는 이미
 * 해석된 템플릿 아이템을 파라미터로 받는다(몹 AI·carry[] 인덱싱 없음).
 *
 * 게이트: gold < mobBuyPrice(value)(= max(10, value))면 insufficient-gold로 거부한다 — 저가
 * 아이템도 최소 10냥을 요구한다(A8 §8: MAX(10, value*1)). 개수는 취득 *전* invCount가 150을
 * 넘으면(invCount > 150) count-limit으로 거부한다 — buy와 동일한 pre-purchase strict `>` 경계이며,
 * 정확히 150 보유자는 성공한다(부분 결과 없음). 성공 시 goldAfter = gold − price.
 *
 * 클론은 buy와 동일하게 좁은 필드를 명시적으로 선택해 구성한다(spread 아님) — 넓은 인스턴스를 넘겨도
 * _id·owner 같은 여분 필드가 새 나가지 않고 항상 소유자 없는 디스크립터가 보장된다.
 */
export function purchase(
  char: BuyerState,
  item: ShopItem,
): { goldAfter: number; item: ShopItem } {
  assertNonNegativeInt(char.gold, 'gold')
  assertNonNegativeInt(char.invCount, 'invCount')
  assertNonNegativeInt(item.value, 'value')
  const price = mobBuyPrice(item.value)
  if (char.gold < price) {
    throw new ShopRejectError(
      'insufficient-gold',
      `gold가 부족합니다: 필요 ${price}, 보유 ${char.gold}`,
    )
  }
  if (char.invCount > PURCHASE_COUNT_LIMIT) {
    throw new ShopRejectError(
      'count-limit',
      `인벤토리 개수 상한(${PURCHASE_COUNT_LIMIT})을 초과합니다: 현재 ${char.invCount}`,
    )
  }
  return { goldAfter: char.gold - price, item: cloneShopItem(item) }
}

/**
 * object 타입 코드(A8 §1 taxonomy) — 판매 게이트가 판독하는 상수. 원본 mstruct.h의 오브젝트
 * 종류 열거. sell의 poorquality·unsellable 판정에만 필요한 항목을 명명 상수로 노출한다.
 */
const MISSILE = 4
const ARMOR = 5
const POTION = 6
const SCROLL = 7
const WAND = 8
const KEY = 11

/** 저품질 판정 하한 — 충전물(WAND/KEY)이 이 미만이면 방전으로 본다(shotscur < 1). */
const CHARGE_MIN = 1

/** 1/250 이중 지급 굴림의 당첨 값 — 오라클 `((time(0)+mrand(1,100))%250)==9`의 `==9` 상수. */
const LUCKY_ROLL = 9

/**
 * 전당포 판매 게이트가 판독하는 좁은 구조 입력 — 완전한 ObjectInstance가 아니다(D1: object.ts는
 * 동결이며 shotsmax·flags를 담지 않는다). 판매 규칙에 필요한 필드만 좁게 선언한다.
 */
export interface PawnItem {
  readonly value: number
  readonly type: number
  readonly shotscur: number
  readonly shotsmax: number
  /** ONEWEV 플래그 — 개인 귀속 아이템(판매 불가). */
  readonly onewev: boolean
  /** first_obj 존재 — 비빈 컨테이너면 true(내용물 있는 채로 판매 불가). */
  readonly hasContents: boolean
}

/**
 * 아이템을 전당포에 판매한다(sell, A8 §8, command7.c sell). 판매가는 shared의 sellPrice
 * (min(trunc(value/2), 100000))를 소비한다 — 공식을 재유도하지 않는다.
 *
 * 거부 매트릭스(오라클 cascade 순서 그대로):
 *   1. payout < 20                             → low-value
 *        (오라클 `gold < 20`과 동치다: gold=trunc(value/2)라 value<40이면 payout<20이고, 상한
 *         100000은 절대 20 미만이 아니므로 clamp가 이 경계를 바꾸지 않는다.)
 *   2. poorquality                             → low-quality
 *        (type <= MISSILE || type == ARMOR) && shotscur <= trunc(shotsmax/8)  // 마모 장비·투척
 *        (type == WAND || type == KEY) && shotscur < CHARGE_MIN               // 방전 충전물
 *   3. onewev(개인 귀속)                          → bound-item
 *   4. hasContents(비빈 컨테이너)                  → non-empty-container
 *   5. type == SCROLL || type == POTION         → unsellable-type
 *
 * 이중 지급: 다섯 게이트를 모두 통과한 뒤에만 `ctx.rng(1, 250)`를 1회 굴린다 — 거부 케이스는 rng를
 * 소비하지 않는다(오라클도 lucky를 cascade 최후에 판정). 굴림이 LUCKY_ROLL(9)이면 오라클 pay-twice
 * (`gold += sellPrice` 두 번)를 그대로 재현해 payout에 sellPrice를 한 번 더 더한다 → lucky payout은
 * 2*sellPrice다. A8 §10-e에 따라 오라클의 time(0) 벽시계 의존은 버리고 확률 1/250(콘텐츠)만 보존한다.
 *
 * 순수 함수: char·item을 변이하지 않고 새 결과 객체를 반환한다. 영속화·인벤토리 제거는 호출자(#106)의 몫.
 */
export function sell(
  char: { gold: number },
  item: PawnItem,
  ctx: { rng: CombatRng },
): { goldAfter: number; payout: number; lucky: boolean } {
  assertNonNegativeInt(char.gold, 'gold')
  assertNonNegativeInt(item.value, 'value')
  assertNonNegativeInt(item.shotscur, 'shotscur')
  assertNonNegativeInt(item.shotsmax, 'shotsmax')
  const payout = sellPrice(item.value)

  if (payout < 20) {
    throw new ShopRejectError('low-value', `판매가가 너무 낮습니다: ${payout} < 20`)
  }

  const worn =
    (item.type <= MISSILE || item.type === ARMOR) &&
    item.shotscur <= Math.trunc(item.shotsmax / 8)
  const discharged = (item.type === WAND || item.type === KEY) && item.shotscur < CHARGE_MIN
  if (worn || discharged) {
    throw new ShopRejectError('low-quality', '품질이 낮아 매입할 수 없습니다')
  }

  if (item.onewev) {
    throw new ShopRejectError('bound-item', '개인 귀속 아이템은 판매할 수 없습니다')
  }

  if (item.hasContents) {
    throw new ShopRejectError('non-empty-container', '내용물이 있는 컨테이너는 판매할 수 없습니다')
  }

  if (item.type === SCROLL || item.type === POTION) {
    throw new ShopRejectError('unsellable-type', '두루마리·물약은 매입 대상이 아닙니다')
  }

  const lucky = ctx.rng(1, 250) === LUCKY_ROLL
  let finalPayout = payout
  if (lucky) finalPayout += payout
  return { goldAfter: char.gold + finalPayout, payout: finalPayout, lucky }
}

/**
 * 아이템 수리 게이트가 판독하는 좁은 구조 입력 — 완전한 ObjectInstance가 아니다(D1: object.ts는
 * 동결). 수리 역학에 필요한 3필드만 좁게 선언한다. adjustment·armor·pdice 등 인챈트 필드는 담지 않는다.
 */
export interface RepairItem {
  readonly value: number
  readonly shotscur: number
  readonly shotsmax: number
}

/**
 * 아이템을 수리한다(repair, A8 §8 RREPAI, command8.c repair). 수리비를 선차감한 뒤 piety 보정
 * 실패 굴림을 던진다 — 실패하면 수리비를 환불(net 0)하고 아이템을 파괴하며, 성공하면 내구도를
 * 복원(shotsmax의 50~90%)한다.
 *
 * 역학(오라클 그대로):
 *   1. cost = repairCost(value)(= trunc(value/4)). char.gold < cost면 insufficient-gold로 거부.
 *   2. gold -= cost(선차감) 후 broke = rng(1,100) + bonusOf(piety).
 *   3. 실패 = (broke ≤ 15 && shotscur < 1) || (broke ≤ 5 && shotscur > 0)
 *        → gold += cost(환불, net 0) + 아이템 파괴(item=null). 성공보다 굴림을 1회만 소비한다.
 *   4. 성공 = shotscur' = trunc(shotsmax * rng(5,9) / 10). 곱 위에서 절삭한다(hpMax류 그룹핑 트랩:
 *        `shotsmax * trunc(rng/10)`이 아니다). goldAfter = gold − cost.
 *
 * RNG 순서: broke(1,100)를 먼저 굴리고, 성공일 때만 durability(5,9)를 굴린다 — 실패는 굴림 1회,
 * 성공은 2회다. 순수 함수: char·item을 변이하지 않고 새 결과 객체를 반환한다.
 *
 * 유예 범위(이 좁은 타입 밖 — 기록된 결정):
 *   - 자격 게이트(#106, caller-eligibility): ONOFIX(수리 불가 플래그), "무기·방어구만"
 *     (type > MISSILE && type != ARMOR), "아직 멀쩡"(shotscur > MAX(3, trunc(shotsmax/10)))은
 *     item flags/type을 요구하므로 RepairItem 밖이다. 호출자가 repair 호출 전 검사한다.
 *   - 인챈트 저하(#85/#86, 인챈트 토픽): OENCHA 아이템의 adjustment 강등(mrand(1,50) > piety면
 *     armor/shotsmax/pdice 감소)은 adjustment·armor·pdice 필드를 건드리므로 D1 좁은 타입 밖이다.
 *     RNG 위치 제약: 오라클에서 이 mrand(1,50) 굴림은 broke와 durability 굴림 *사이*에 놓인다
 *     (비인챈트 아이템은 short-circuit되어 현재 2-굴림 SUT가 byte-충실하다). 인챈트가 랜딩하면
 *     이 굴림을 반드시 broke와 durability 사이에 삽입해야 seqRng 굴림 순서 충실성이 유지된다.
 */
export function repair(
  char: { gold: number; piety: number },
  item: RepairItem,
  ctx: { rng: CombatRng },
): { goldAfter: number; broke: number; broken: boolean; item: RepairItem | null } {
  assertNonNegativeInt(char.gold, 'gold')
  assertNonNegativeInt(char.piety, 'piety')
  assertNonNegativeInt(item.value, 'value')
  assertNonNegativeInt(item.shotscur, 'shotscur')
  assertNonNegativeInt(item.shotsmax, 'shotsmax')
  const cost = repairCost(item.value)
  if (char.gold < cost) {
    throw new ShopRejectError(
      'insufficient-gold',
      `gold가 부족합니다: 필요 ${cost}, 보유 ${char.gold}`,
    )
  }

  const broke = ctx.rng(1, 100) + bonusOf(char.piety)
  const broken = (broke <= 15 && item.shotscur < 1) || (broke <= 5 && item.shotscur > 0)
  if (broken) {
    // 실패: 선차감한 cost를 환불(net 0)하고 아이템을 파괴한다. durability는 굴리지 않는다.
    return { goldAfter: char.gold, broke, broken: true, item: null }
  }

  // 성공: shotsmax * rng(5,9)를 먼저 곱한 뒤 10으로 나눠 절삭한다(곱 위에서 절삭).
  const durability = Math.trunc((item.shotsmax * ctx.rng(5, 9)) / 10)
  return {
    goldAfter: char.gold - cost,
    broke,
    broken: false,
    item: { value: item.value, shotscur: durability, shotsmax: item.shotsmax },
  }
}
