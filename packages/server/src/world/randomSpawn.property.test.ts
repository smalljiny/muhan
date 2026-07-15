import { describe, it } from 'vitest'
import fc from 'fast-check'
import { seedArb, intInRangeArb } from 'shared/property/arbitraries.testutil'
import { assertInRange } from 'shared'
import { seededSpawnRng } from './seededRngSeams.testutil.js'

/**
 * 스폰 seam property 테스트 — `seededSpawnRng`(SUT)의 세 굴림이 임의 seed·len·max
 * 조합 전체에서 범위 불변식을 지킴을 fast-check로 실증한다.
 *
 * 비-vacuity: 각 property는 실제 SUT를 구동하고, assertInRange가 위반 시 shrink된
 * 반례와 함께 throw한다(tautology 아님 — T5.5에서 상한을 뒤집어 실제 반례 리포트를 확인).
 *
 * import 규약(크로스패키지 재사용):
 *   - arbitraries: `shared/property/arbitraries.testutil`(소스 subpath, vitest alias 경유)
 *   - 순수 심볼(assertInRange): bare `shared`(dist) — 두 경로 공존.
 */
describe('seededSpawnRng — property 범위 불변식', () => {
  it('pickIndex(len) ∈ [0, len-1] (모든 seed·len)', () => {
    fc.assert(
      fc.property(seedArb, intInRangeArb(1, 20), (seed, len) => {
        const rng = seededSpawnRng(seed)
        assertInRange(rng.pickIndex(len), 0, len - 1, 'pickIndex')
      }),
    )
  })

  it('groupSize(max) ∈ [1, max] (스폰 그룹 크기 ∈ [1, numwander] 대응)', () => {
    fc.assert(
      fc.property(seedArb, intInRangeArb(1, 10), (seed, max) => {
        const rng = seededSpawnRng(seed)
        assertInRange(rng.groupSize(max), 1, max, 'groupSize')
      }),
    )
  })

  it('roll100() ∈ [1, 100] (traffic 게이트 굴림, 모든 seed)', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const rng = seededSpawnRng(seed)
        assertInRange(rng.roll100(), 1, 100, 'roll100')
      }),
    )
  })

  it('연속 혼합 호출 시퀀스에서도 세 굴림이 각 범위를 유지한다', () => {
    fc.assert(
      fc.property(seedArb, intInRangeArb(1, 20), intInRangeArb(1, 10), (seed, len, max) => {
        const rng = seededSpawnRng(seed)
        // 단일 rng 클로저가 상태를 전진시키므로 혼합 호출 순서에서도 범위가 깨지지 않아야 한다.
        for (let i = 0; i < 8; i += 1) {
          assertInRange(rng.roll100(), 1, 100, 'roll100')
          assertInRange(rng.pickIndex(len), 0, len - 1, 'pickIndex')
          assertInRange(rng.groupSize(max), 1, max, 'groupSize')
        }
      }),
    )
  })
})
