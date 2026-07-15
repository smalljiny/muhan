/**
 * property 테스트용 순수 seedable PRNG (mulberry32).
 *
 * 의존 0 — fast-check를 import하지 않는다. 단일 uint32 상태로 32비트 결정성을 갖는다.
 * 곱셈은 `Math.imul`로 32비트 정수 곱을 강제하고 최종 변환은 `>>> 0`로 부호 없는
 * 32비트로 맞춰, 플랫폼 무관 결정성을 보장한다(plain `*`는 저비트를 잃어 결정성이 깨진다).
 */

/**
 * 시드로 mulberry32 생성기를 만든다. 반환 함수는 호출마다 `0 <= x < 1`을 낸다.
 * 같은 시드는 항상 같은 시퀀스를 재현한다.
 */
export function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `rng()`(0~1) 한 번을 소비해 `[lo, hi]` 정수(양끝 포함)를 낸다.
 * `hi - lo + 1`의 `+1`이 상한 hi 도달을 보장한다. lo == hi면 항상 lo를 낸다.
 * precondition: `lo <= hi`. 역전 범위는 계약 밖 값을 조용히 내므로 조기에 throw한다.
 */
export function nextIntInRange(rng: () => number, lo: number, hi: number): number {
  if (hi < lo) throw new RangeError(`nextIntInRange: hi(${hi}) < lo(${lo})`)
  return lo + Math.floor(rng() * (hi - lo + 1))
}
