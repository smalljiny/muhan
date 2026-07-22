/**
 * object 타입 taxonomy·착용 슬롯 매핑 — 오라클(mtype.h)의 byte-fidelity 값을 이름 있는 상수로 분리한다.
 * 아이템 타입 0~14, 착용 wearflag 1~20이 여기 정본으로 모여 후속 Story(착용·인벤토리·전투 무기 판정)가
 * 매직 넘버 없이 소비한다.
 */

// ── object 타입 상수(mtype.h, 0~14) ─────────────────────────────────────────
/** 베는 무기(sharp). */
export const SHARP = 0
/** 찌르는 무기(thrust). */
export const THRUST = 1
/** 둔기(blunt). */
export const BLUNT = 2
/** 장병기(pole). */
export const POLE = 3
/** 투척/원거리 무기(missile) — 무기 판정 상한. */
export const MISSILE = 4
/** 방어구(armor). */
export const ARMOR = 5
/** 물약(potion). */
export const POTION = 6
/** 두루마리(scroll). */
export const SCROLL = 7
/** 지팡이(wand). */
export const WAND = 8
/** 용기(container). */
export const CONTAINER = 9
/** 금전(money). */
export const MONEY = 10
/** 열쇠(key). */
export const KEY = 11
/** 광원(lightsource). */
export const LIGHTSOURCE = 12
/** 기타(misc). */
export const MISC = 13
/** 보조 용기(container2) — 상수만 정의, 실로직 없음. */
export const CONTAINER2 = 14

/**
 * 무기 판정 — 타입이 SHARP(0)~MISSILE(4) 범위면 무기다.
 * 오라클에서 무기 계열이 타입 0~4로 연속 배치돼 있어 범위 비교로 판정한다.
 */
export function isWeapon(type: number): boolean {
  return type >= SHARP && type <= MISSILE
}

// ── 착용 슬롯 상수(mtype.h wearflag, 1~20) ──────────────────────────────────
// object.slot = wearflag−1(0-based, 0~19). NECK/FINGER는 연속 슬롯 그룹의 첫 wearflag만
// 실아이템이 지니며, 그룹의 나머지 상수(NECK2·FINGER2..8)는 슬롯 이름표 역할이다.
/** 몸통(body). */
export const BODY = 1
/** 팔(arms). */
export const ARMS = 2
/** 다리(legs). */
export const LEGS = 3
/** 목걸이 1(neck1) — NECK 그룹의 첫 슬롯. */
export const NECK1 = 4
/** 목걸이 2(neck2) — NECK 그룹의 둘째 슬롯 이름표. */
export const NECK2 = 5
/** 손(hands). */
export const HANDS = 6
/** 머리(head). */
export const HEAD = 7
/** 발(feet). */
export const FEET = 8
/** 반지 1(finger1) — FINGER 그룹의 첫 슬롯. */
export const FINGER1 = 9
/** 반지 2(finger2). */
export const FINGER2 = 10
/** 반지 3(finger3). */
export const FINGER3 = 11
/** 반지 4(finger4). */
export const FINGER4 = 12
/** 반지 5(finger5). */
export const FINGER5 = 13
/** 반지 6(finger6). */
export const FINGER6 = 14
/** 반지 7(finger7). */
export const FINGER7 = 15
/** 반지 8(finger8) — FINGER 그룹의 마지막 슬롯 이름표. */
export const FINGER8 = 16
/** 든 물건(held). */
export const HELD = 17
/** 방패(shield). */
export const SHIELD = 18
/** 얼굴(face). */
export const FACE = 19
/** 장착 무기(wield). */
export const WIELD = 20
/** 착용 슬롯 최대치(wearflag 상한). */
export const MAXWEAR = 20

/** 착용 명령 라우팅 결과 — 게임 명령 어휘. */
export type WearCommand = 'ready' | 'hold' | 'wear'

/**
 * 착용 명령 라우팅 — wearflag에 따라 게임 명령을 결정한다.
 * WIELD(20)는 무기 장착('ready'), HELD(17)는 손에 듦('hold'), 그 외 방어구/장신구는 착용('wear').
 */
export function routeWearCommand(wearflag: number): WearCommand {
  if (wearflag === WIELD) return 'ready'
  if (wearflag === HELD) return 'hold'
  return 'wear'
}

/**
 * 다중슬롯 first-free 슬롯 해소 — wearflag가 가리키는 후보 슬롯(0-based) 중 비어 있는 첫 인덱스를 반환한다.
 * NECK1(4)은 슬롯 3·4, FINGER1(9)은 슬롯 8~15의 그룹을 훑고, 단일 부위는 슬롯 wearflag−1 하나만 본다.
 * 모든 후보가 점유(occupied)면 null.
 *
 * 오라클 command3.c:195-221 switch(wearflag) 구조를 그대로 옮긴다: NECK·FINGER 두 그룹만 다중슬롯이고
 * 나머지는 단일 슬롯이다. 그룹은 첫 wearflag~마지막 wearflag(포함) 범위를 순회하며 first-free를 찾는다.
 */
export function resolveSlot(wearflag: number, occupied: ReadonlySet<number>): number | null {
  const lastFlag = wearflag === NECK1 ? NECK2 : wearflag === FINGER1 ? FINGER8 : wearflag
  for (let flag = wearflag; flag <= lastFlag; flag += 1) {
    const slot = flag - 1
    if (!occupied.has(slot)) return slot
  }
  return null
}
