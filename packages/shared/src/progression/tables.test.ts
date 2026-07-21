import { describe, it, expect } from 'vitest'
import { level_cycle } from './tables.js'

/**
 * level_cycle(레벨업 능력치 성장 대상) 전사 무결성 테스트.
 *
 * 원본 `global.c:78`의 `short level_cycle[][10]` 13행×10칸을 하드 리터럴로 독립 나열해
 * 전사 오류(전사 typo)를 검출한다. up/downLevel의 성장 게이트는 newLevel%4==0에서만 발화하고
 * index=(newLevel-2)%10은 항상 짝수라, 홀수 칸(1,3,5,7,9)은 런타임에서 절대 판독되지 않는다
 * (behaviorally dead). 따라서 기능 경로로는 홀수 칸 typo를 못 잡으므로, 여기서 셀 단위
 * 하드 리터럴 대조로 전사 위생을 확정한다.
 *
 * enum 심볼→숫자: STR=1,DEX=2,CON=3,INT=4,PTY=5. 값 0은 성장 없음(row 0 placeholder).
 */

// 확정 정본 — global.c:78 level_cycle[13][10]을 심볼→숫자로 독립 전사한 하드 리터럴.
const EXPECTED_LEVEL_CYCLE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // row 0 (class 0 placeholder)
  [3, 5, 1, 4, 2, 4, 2, 5, 1, 2], // row 1
  [4, 2, 5, 3, 1, 3, 2, 1, 5, 1], // row 2
  [1, 2, 3, 5, 4, 5, 4, 2, 3, 4], // row 3
  [5, 4, 2, 3, 1, 3, 4, 1, 2, 1], // row 4 fighter
  [1, 2, 5, 3, 4, 3, 4, 2, 5, 4], // row 5 mage
  [2, 4, 3, 1, 5, 1, 4, 5, 3, 5], // row 6
  [5, 1, 4, 3, 2, 3, 2, 1, 4, 2], // row 7
  [4, 3, 5, 1, 2, 1, 3, 2, 5, 2], // row 8
  [1, 2, 4, 3, 5, 1, 2, 4, 3, 5], // row 9 invincible
  [1, 2, 4, 3, 5, 1, 2, 4, 3, 5], // row 10 (= row 9)
  [1, 2, 4, 3, 5, 1, 2, 4, 3, 5], // row 11 (= row 9)
  [1, 2, 4, 3, 5, 1, 2, 4, 3, 5], // row 12 (= row 9)
]

describe('level_cycle 테이블 전사 무결성', () => {
  it('13행이다', () => {
    expect(level_cycle).toHaveLength(13)
  })

  it('각 행이 정확히 10칸이다', () => {
    for (const row of level_cycle) {
      expect(row).toHaveLength(10)
    }
  })

  it('전 셀이 확정 정본 하드 리터럴과 정확히 일치한다', () => {
    expect(level_cycle).toEqual(EXPECTED_LEVEL_CYCLE)
  })

  it('row 10·11·12가 row 9와 동일하다(prestige 재레벨링 중복행)', () => {
    expect(level_cycle[10]).toEqual(level_cycle[9])
    expect(level_cycle[11]).toEqual(level_cycle[9])
    expect(level_cycle[12]).toEqual(level_cycle[9])
  })

  it('모든 값이 0..5 범위다(enum STR=1..PTY=5, 0=성장 없음)', () => {
    for (const row of level_cycle) {
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(5)
      }
    }
  })
})
