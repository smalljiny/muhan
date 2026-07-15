/**
 * property 테스트 공통 불변식 assert — 순수 함수, fast-check 무의존.
 *
 * 각 assert는 위반 시 반례를 사람이 읽을 수 있게 담은 메시지로 throw한다. fast-check
 * property 콜백 안에서 호출되면 이 메시지가 shrink된 반례와 함께 리포트에 노출된다.
 */

/**
 * `x`가 닫힌 구간 `[lo, hi]` 안(양끝 포함)인지 검사한다. 벗어나면 반례 값·구간·label을
 * 담은 `RangeError`를 던진다. lo <= hi 전제는 호출자 책임이다.
 */
export function assertInRange(x: number, lo: number, hi: number, label: string): void {
  if (x < lo || x > hi) {
    throw new RangeError(`${label} 범위 위반: ${x} not in [${lo}, ${hi}]`)
  }
}

/**
 * `values`가 방향대로 단조인지 검사한다. `non-increasing`은 인접쌍이 항상 `prev >= curr`,
 * `non-decreasing`은 항상 `prev <= curr`여야 한다. 동값 연속(평탄)은 양쪽 모두 충족한다.
 * 빈 배열·단일 원소는 단조성이 자명하므로 무동작이다. 위반 시 위반 인덱스·인접쌍 값·label을
 * 담은 `Error`를 던진다.
 */
export function assertMonotonic(
  values: readonly number[],
  direction: 'non-increasing' | 'non-decreasing',
  label: string,
): void {
  // 빈 배열·단일 원소는 단조성이 자명하므로 무동작. reduce는 초기값 없이 빈 배열에 대해
  // throw하므로 이 가드로 먼저 걸러낸다(length 1은 콜백을 호출하지 않고 그 원소를 반환).
  if (values.length < 2) return

  // 초기값을 주지 않으면 reduce는 prev·curr를 모두 number로 좁혀 준다 —
  // noUncheckedIndexedAccess의 undefined 가드(도달 불가 dead branch)가 필요 없다.
  // 첫 콜백의 인덱스는 1이라 위반 인덱스와 정확히 일치한다.
  values.reduce((prev, curr, i) => {
    const violated = direction === 'non-increasing' ? curr > prev : curr < prev
    if (violated) {
      const relation = direction === 'non-increasing' ? '증가' : '감소'
      throw new Error(
        `${label} ${direction} 위반: 인덱스 ${i}에서 ${prev} → ${curr} (${relation})`,
      )
    }
    return curr
  })
}
