import { describe, it, expect } from 'vitest'
import { neededExp, expToLevel } from './expCurve.js'
import { needed_exp } from './tables.js'

// 전사 무결성 앵커 — 128칸 테이블의 트랜스포지션·누락을 독립 리터럴로 차단한다.
describe('needed_exp 테이블 무결성', () => {
  it('정확히 128칸이다', () => {
    expect(needed_exp).toHaveLength(128)
  })

  it('경계 인덱스가 oracle 정본과 일치한다 (0=128, 126=100000000, 127=190000000)', () => {
    expect(needed_exp[0]).toBe(128)
    expect(needed_exp[126]).toBe(100000000)
    expect(needed_exp[127]).toBe(190000000)
  })

  it('index 0..126이 단조 증가한다 (마지막 칸 127은 비단조 — 제외)', () => {
    for (let i = 1; i <= 126; i++) {
      expect(needed_exp[i]!).toBeGreaterThan(needed_exp[i - 1]!)
    }
  })
})

describe('neededExp — 배열 룩업 + L128 초과 선형 확장', () => {
  // 하드 리터럴 앵커 — SUT 구현과 독립적으로 확정 정본을 박아 tautology를 차단한다.
  it('L1 → 128 (needed_exp[0])', () => {
    expect(neededExp(1)).toBe(128)
  })

  it('L2 → 256 (needed_exp[1])', () => {
    expect(neededExp(2)).toBe(256)
  })

  it('L36 → 100000 (needed_exp[35])', () => {
    expect(neededExp(36)).toBe(100000)
  })

  it('L100 → 7984959 (needed_exp[99])', () => {
    expect(neededExp(100)).toBe(7984959)
  })

  it('L104 → 10000000 (needed_exp[103])', () => {
    expect(neededExp(104)).toBe(10000000)
  })

  it('L128 → 190000000 (needed_exp[127], 배열 상한)', () => {
    expect(neededExp(128)).toBe(190000000)
  })

  // 선형 확장 앵커 — needed_exp[126]=100000000 + (129-127)*5000000 = 110000000.
  // 확장은 index 127(190M)이 아니라 index 126(100M)을 피벗으로 쓴다.
  it('L129 → 110000000 (선형 확장, index 126 피벗)', () => {
    expect(neededExp(129)).toBe(110000000)
  })

  it('L130 → 115000000 (선형 스텝 5000000 검증)', () => {
    expect(neededExp(130)).toBe(115000000)
  })

  // 방어적 처리 — 소비자는 항상 level>=1이지만 level<1은 needed_exp[0]으로 방어한다.
  it('level<1은 방어적으로 needed_exp[0]=128을 반환한다', () => {
    expect(neededExp(0)).toBe(128)
    expect(neededExp(-5)).toBe(128)
  })
})

describe('expToLevel — 역함수 (임계 스캔 + 선형 역산)', () => {
  // 경계·자기일관 앵커 — expToLevel(255)는 128 임계를 넘어 2다(255→1이 아님).
  it('exp 0 → L1 (첫 임계 128 미만)', () => {
    expect(expToLevel(0)).toBe(1)
  })

  it('exp 127 → L1 (첫 임계 128 바로 아래)', () => {
    expect(expToLevel(127)).toBe(1)
  })

  it('exp 128 → L2 (첫 임계를 정확히 채움 → 다음 레벨)', () => {
    expect(expToLevel(128)).toBe(2)
  })

  it('exp 255 → L2 (256 미만이라 여전히 L2)', () => {
    expect(expToLevel(255)).toBe(2)
  })

  it('exp 256 → L3 (둘째 임계를 정확히 채움)', () => {
    expect(expToLevel(256)).toBe(3)
  })

  it('exp 100000000 → L128 (index 126 임계를 채워 배열 상한 도달)', () => {
    expect(expToLevel(100000000)).toBe(128)
  })

  it('exp 110000000 → L130 (선형 역산, trunc((110M-100M)/5M)+128)', () => {
    expect(expToLevel(110000000)).toBe(130)
  })

  it('음수 exp는 max(1, ...)로 L1 하한 방어', () => {
    expect(expToLevel(-1000)).toBe(1)
  })
})

// round-trip 불변식 — neededExp(L)은 L→L+1 승급 임계라 그 exp를 딱 채우면 L+1로 해석된다.
// L=128은 제외: neededExp(128)=index127(190M)이지만 expToLevel 선형 base는 index126(100M)이라
// expToLevel(190M)=146 ≠ 129 (테이블 비단조성 때문). L∈[1,127]∪[129,∞)에서만 성립.
describe('round-trip: expToLevel(neededExp(L)) === L+1 (L≠128)', () => {
  const safeLevels = [1, 2, 3, 36, 100, 127, 129, 130]
  it.each(safeLevels)('L=%i에서 성립한다', (level) => {
    expect(expToLevel(neededExp(level))).toBe(level + 1)
  })

  it('L=128은 비단조성으로 round-trip이 깨진다 (146 ≠ 129)', () => {
    expect(expToLevel(neededExp(128))).toBe(146)
    expect(expToLevel(neededExp(128))).not.toBe(129)
  })
})
