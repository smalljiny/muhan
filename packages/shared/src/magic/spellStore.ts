/**
 * spell store 비트마스크 헬퍼 — 플레이어 주문 지식(uint8[16]=128비트)의 비트 read/write.
 *
 * 원본 매크로 정본(legacy `mtype.h:570-571`):
 *   #define S_ISSET(p,f) ((p)->spells[(f)/8] & 1<<((f)%8))
 *   #define S_SET(p,f)   ((p)->spells[(f)/8] |= 1<<((f)%8))
 * f는 0-based 주문번호(비트 인덱스)다. C 연산자 우선순위상 `& 1<<(f%8)`은 `& (1<<(f%8))`이며,
 * 바이트 오프셋 f/8은 정수 나눗셈(f>>3), 비트 위치 f%8은 f&7이다.
 *
 * 플레이어 spell store(characterSchema.spells)는 uint8[16] number 배열이다 — creature flags의
 * hex string 표현(world/hexFlags.F_ISSET)과 달리 여기 표현은 바이트당 한 원소인 number[]다.
 * read(isKnown)는 boolean, write(setKnown)는 입력을 변형하지 않고 새 store를 반환한다(불변).
 */

/** spell store 폭 — uint8[16]=128비트(A6 §8 spells[16]). */
export const SPELL_STORE_BYTES = 16

/** 빈 spell store를 만든다 — 16바이트 0(어느 주문도 미습득). 호출마다 새 배열. */
export function emptySpellStore(): number[] {
  return new Array<number>(SPELL_STORE_BYTES).fill(0)
}

/** S_ISSET — 주문번호 spellNo의 비트가 세팅됐는지. 범위 밖 바이트는 미세팅(false)으로 취급한다. */
export function isKnown(store: readonly number[], spellNo: number): boolean {
  const byte = store[spellNo >> 3] ?? 0
  return ((byte >> (spellNo & 7)) & 1) === 1
}

/** S_SET — 주문번호 spellNo의 비트를 세팅한 새 store를 반환한다(입력 불변). */
export function setKnown(store: readonly number[], spellNo: number): number[] {
  const next = store.slice()
  const idx = spellNo >> 3
  next[idx] = (next[idx] ?? 0) | (1 << (spellNo & 7))
  return next
}
