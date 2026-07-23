/**
 * 상점 서비스 순수 함수 — A8 §8(RSHOPP 상점)의 매매·수리를 gold-게이트 순수 변환으로 이식한다.
 * MongoDB·Character·ObjectInstance에 의존하지 않고 좁은 구조 입력만 다룬다. 영속화·인벤토리
 * 배선(_id·owner·slot·schemaVersion)·재고 소싱은 호출자(#106, 후속 토픽)의 책임이다.
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

import { buyPrice } from 'shared'

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
 * count_inv(장착 포함) 상한 — A8 §8/§13. 오라클(command7.c buy)은 구매 *전* 개수(cnt)를
 * strict `>`로 검사한다 — 정확히 200 보유자는 구매에 성공하고 201에서 종료한다. plan G7
 * canCarry의 `buy > 200` 기준과 동일 경계다.
 */
const BUY_COUNT_LIMIT = 200

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
  const item: ShopItem = {
    objnum: shopItem.objnum,
    type: shopItem.type,
    value: shopItem.value,
    shotscur: shopItem.shotscur,
  }
  return { goldAfter: char.gold - price, item }
}
