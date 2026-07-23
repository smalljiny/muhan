import { describe, it, expect } from 'vitest'
import { decideFlee, type FleePlayer } from './flee.js'
import { seqRng } from './dice.testutil.js'
import { F_SET, PWIMPY, PFEARS } from '../world/hexFlags.js'
import { PALADIN, FIGHTER } from './constants.js'

/**
 * flee — 플레이어 도주 결정(update.c:534~551)의 순수 함수 이식. boolean(도주 여부)만 반환하며 실 이동은
 * movement seam(#99) 유예다.
 *
 * PWIMPY: hpCurrent<=wimpyValue면 도주(굴림 없음). else-if PFEARS: ff 공식 굴림 후 ff<rng(1,100)면 도주.
 *
 * PFEARS 우선순위 버그 수정(loud divergence): 오라클 `ff = 40 + ... + (class==PALADIN) ? -10 : 0`은
 * C 연산자 우선순위상 `(40+...+(class==PALADIN)) ? -10 : 0`로 파싱돼 ff=-10 상시(항상 도주 버그).
 * 이식은 삼항을 괄호로 묶은 의도된 공식이라, con·paladin 항이 결과에 실제로 영향을 준다 — 아래 테스트가
 * 고정 rng에 대해 두 항이 flee/no-flee를 뒤집는지 검증한다(버그판이면 항 무관하게 항상 도주).
 */

const ZERO = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO)
}

function fleePlayer(overrides: Partial<FleePlayer> = {}): FleePlayer {
  return {
    flags: ZERO,
    hpCurrent: 100,
    hpMax: 100,
    constitution: 10, // bonusOf(10)=0 — 기본은 con 항 0.
    class: FIGHTER,
    wimpyValue: 0,
    ...overrides,
  }
}

describe('decideFlee — PWIMPY(굴림 없음)', () => {
  it('hpCurrent<=wimpyValue면 도주한다', () => {
    const p = fleePlayer({ flags: flagsWith(PWIMPY), hpCurrent: 10, wimpyValue: 10 })
    expect(decideFlee(p, seqRng([]))).toBe(true)
  })

  it('hpCurrent>wimpyValue면 도주하지 않는다', () => {
    const p = fleePlayer({ flags: flagsWith(PWIMPY), hpCurrent: 11, wimpyValue: 10 })
    expect(decideFlee(p, seqRng([]))).toBe(false)
  })

  it('PWIMPY가 세팅되면 PFEARS 분기를 건너뛴다(else-if 체인, PFEARS 굴림 미소비)', () => {
    // PWIMPY hpcur>wimpy → 도주 안 함. PFEARS도 세팅됐지만 굴림 시도하면 seqRng([]) throw.
    const p = fleePlayer({
      flags: flagsWith(PWIMPY, PFEARS),
      hpCurrent: 11,
      wimpyValue: 10,
    })
    expect(decideFlee(p, seqRng([]))).toBe(false)
  })
})

describe('decideFlee — PFEARS ff 공식(우선순위 수정판)', () => {
  // full hp(hpCurrent==hpMax): trunc(1)=1 → hp항 (1-1)*40=0.
  // ff = 40 + 0 + bonusOf(con)*3 + (class==PALADIN ? -10 : 0). 도주 조건: ff < rng.
  it('con=10·비팔라딘: ff=40, rng=41이면 도주(40<41)', () => {
    const p = fleePlayer({ flags: flagsWith(PFEARS), constitution: 10 })
    expect(decideFlee(p, seqRng([41]))).toBe(true)
  })

  it('con=10·비팔라딘: ff=40, rng=40이면 도주 안 함(40<40 거짓)', () => {
    const p = fleePlayer({ flags: flagsWith(PFEARS), constitution: 10 })
    expect(decideFlee(p, seqRng([40]))).toBe(false)
  })

  it('con 항이 결과를 뒤집는다: rng=45 고정, con=10(ff=40)→도주 vs con=20(ff=49)→도주 안 함', () => {
    const low = fleePlayer({ flags: flagsWith(PFEARS), constitution: 10 })
    const high = fleePlayer({ flags: flagsWith(PFEARS), constitution: 20 }) // bonusOf(20)=3 → +9.
    expect(decideFlee(low, seqRng([45]))).toBe(true) // 40<45.
    expect(decideFlee(high, seqRng([45]))).toBe(false) // 49<45 거짓.
  })

  it('PALADIN 항(-10)이 결과를 뒤집는다: rng=45 고정, con=20 팔라딘(ff=39)→도주 vs 비팔라딘(ff=49)→도주 안 함', () => {
    const paladin = fleePlayer({
      flags: flagsWith(PFEARS),
      constitution: 20,
      class: PALADIN,
    })
    const fighter = fleePlayer({ flags: flagsWith(PFEARS), constitution: 20, class: FIGHTER })
    expect(decideFlee(paladin, seqRng([45]))).toBe(true) // 40+9-10=39 < 45.
    expect(decideFlee(fighter, seqRng([45]))).toBe(false) // 40+9=49, 49<45 거짓.
  })

  it('버그판 방어: con·paladin이 무관하지 않다(ff=-10 상시 도주가 아님)', () => {
    // 버그판(ff=-10)이면 어떤 rng에도 -10<rng라 항상 도주. rng=1(최소)에 대해 도주 안 함을 확인.
    // ff=40, 40<1 거짓 → 도주 안 함. 버그판이면 -10<1 참 → 도주. 이 케이스가 두 이식을 가른다.
    const p = fleePlayer({ flags: flagsWith(PFEARS), constitution: 10 })
    expect(decideFlee(p, seqRng([1]))).toBe(false)
  })
})

describe('decideFlee — PFEARS hp항(정수 나눗셈)', () => {
  it('hpCurrent<hpMax면 trunc(hp/hpMax)=0 → hp항 40 (ff=80)', () => {
    // hp=50/100 → trunc(0.5)=0 → (1-0)*40=40. ff=40+40+0=80. rng=81 → 80<81 도주.
    const p = fleePlayer({ flags: flagsWith(PFEARS), hpCurrent: 50, hpMax: 100, constitution: 10 })
    expect(decideFlee(p, seqRng([81]))).toBe(true)
    expect(decideFlee(p, seqRng([80]))).toBe(false)
  })

  it('경계: hpCurrent=99/hpMax=100 → trunc=0 (hp항 40, float화 금지)', () => {
    const p = fleePlayer({ flags: flagsWith(PFEARS), hpCurrent: 99, hpMax: 100, constitution: 10 })
    // float라면 (1-0.99)*40=0.4로 ff≈40.4가 되겠지만, 정수 나눗셈이라 ff=80.
    expect(decideFlee(p, seqRng([80]))).toBe(false) // 80<80 거짓.
    expect(decideFlee(p, seqRng([81]))).toBe(true) // 80<81.
  })

  it('경계: hpCurrent=100/hpMax=100 → trunc=1 (hp항 0, ff=40)', () => {
    const p = fleePlayer({ flags: flagsWith(PFEARS), hpCurrent: 100, hpMax: 100, constitution: 10 })
    expect(decideFlee(p, seqRng([41]))).toBe(true) // 40<41.
  })
})

describe('decideFlee — 플래그 없음·불변', () => {
  it('PWIMPY/PFEARS 없으면 굴림 없이 false', () => {
    expect(decideFlee(fleePlayer(), seqRng([]))).toBe(false)
  })

  it('입력 player를 변형하지 않는다', () => {
    const p = fleePlayer({ flags: flagsWith(PFEARS), constitution: 20, class: PALADIN })
    const snapshot = structuredClone(p)
    decideFlee(p, seqRng([50]))
    expect(p).toEqual(snapshot)
  })
})
