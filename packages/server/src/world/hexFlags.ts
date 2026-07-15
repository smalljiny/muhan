/**
 * hex string 비트 헬퍼 — 크리처/오브젝트 flags(8바이트 = 16자 hex string)의 비트 조회·세팅·클리어.
 *
 * 원본 `F_ISSET(p,f) = flags[f/8] & (1<<(f%8))`(mtype.h) 이식. door.ts `hasFlag`는 바이트당 한
 * 원소인 number[]용이라 여기 hex string 표현(creatures.json·objects.json·rooms.json의 flags 필드)에는
 * 부적합하다. 이 모듈은 hex string을 그대로 다뤄 별도 디코딩 없이 비트를 판정한다.
 *
 * F_SET/F_CLR은 in-place 변형 대신 새 문자열을 반환한다 — autonomic(순수 함수)이 새 크리처 상태를
 * 만들 때 flags를 교체하는 용도다(입력 flags 불변).
 */

// ── 크리처 M-flag 비트(mtype.h 검증) ─────────────────────────────────────────
/** 고정 몬스터(입장 리스폰 대상). */
export const MPERMT = 0
/** 무차별 공격형. */
export const MAGGRE = 6
/** scavenger(바닥 아이템 회수). */
export const MSCAVE = 11
/** 무언가 주움(scavenge 성공 표식 — wander-out 제외 조건). */
export const MHASSC = 18
/** 선한 유저 공격형(정렬 alg=-1). */
export const MGAGGR = 39
/** 악한 유저 공격형(정렬 alg=1). */
export const MEAGGR = 40
/** DM 추종 몬스터(wander-out 제외 조건). */
export const MDMFOL = 46
/** 매혹(charm) 상태. */
export const MCHARM = 50
/** 혼동(befuddle) 상태. */
export const MBEFUD = 51
/** 사망 시 부하 소환(Story 5 onDeathSummon). */
export const MSUMMO = 61

// ── object flag 비트(scavenge 제외 판정) ─────────────────────────────────────
/** 영구 아이템(회수 불가). */
export const OPERMT = 0
/** 숨겨진 아이템(회수 불가). */
export const OHIDDN = 1
/** 영구2(회수 불가). */
export const OPERM2 = 9
/** 집을 수 없음(회수 불가). */
export const ONOTAK = 17
/** 배경 소품(회수 불가). */
export const OSCENE = 18

/** hex string에서 지정 비트가 속한 바이트 값(0–255)을 읽는다. 범위 밖이면 0. */
function byteAt(hex: string, bit: number): number {
  const i = (bit >> 3) * 2
  const chunk = hex.substring(i, i + 2)
  if (chunk.length < 2) return 0
  const v = parseInt(chunk, 16)
  return Number.isNaN(v) ? 0 : v
}

/** 지정 바이트 인덱스를 새 값으로 교체한 hex string을 반환한다(불변). */
function withByte(hex: string, byteIdx: number, value: number): string {
  const i = byteIdx * 2
  const hexByte = (value & 0xff).toString(16).padStart(2, '0')
  return hex.substring(0, i) + hexByte + hex.substring(i + 2)
}

/** 원본 F_ISSET — 비트가 세팅됐는지. 짧은/빈 hex는 미세팅(false)으로 취급한다. */
export function F_ISSET(hex: string, bit: number): boolean {
  return ((byteAt(hex, bit) >> (bit & 7)) & 1) === 1
}

/** 원본 F_SET — 지정 비트를 세팅한 새 hex string을 반환한다(입력 불변). */
export function F_SET(hex: string, bit: number): string {
  const byte = byteAt(hex, bit) | (1 << (bit & 7))
  return withByte(hex, bit >> 3, byte)
}

/** 원본 F_CLR — 지정 비트를 클리어한 새 hex string을 반환한다(입력 불변). */
export function F_CLR(hex: string, bit: number): string {
  const byte = byteAt(hex, bit) & ~(1 << (bit & 7))
  return withByte(hex, bit >> 3, byte)
}
