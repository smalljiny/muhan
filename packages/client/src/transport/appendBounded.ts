// 최근 N건만 남기는 상한 배열 헬퍼 — 이벤트·오류 기록처럼 끝에 계속 쌓이는 목록이 무한히 자라지 않게 한다.
// 입력 배열은 바꾸지 않고 항상 새 배열을 돌려준다(상한 미만이어도 새 참조).

/** 끝에 item을 덧붙이고 최근 limit건만 남긴 새 배열을 돌려준다(입력 불변). limit은 1 이상 정수여야 한다. */
export function appendBounded<T>(list: readonly T[], item: T, limit: number): readonly T[] {
  // slice(-0)은 전체 배열을 돌려주므로 0·음수·비정수 상한은 상한 없는 목록이 되기 전에 막는다.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`appendBounded: limit은 1 이상 정수여야 한다 (받은 값: ${limit})`)
  }
  return [...list, item].slice(-limit)
}
