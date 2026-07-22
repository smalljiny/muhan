import { describe, it, expect } from 'vitest'
import type { Caster } from './caster.js'
import { evaluateGate, applyCastGate, type CastRequirement } from './gate.js'
import { MAGE, CLERIC, INVINCIBLE, CARETAKER } from '../combat/constants.js'

/**
 * 시전 게이트 테스트(magic8.c cast 게이트 · A6 §1-3).
 *
 * gated 플래그가 how==CAST 게이트를 단일화한다:
 *   - gated=false(아이템 경로) → 마나·클래스·knowledge 전부 우회, 마나 미소비.
 *   - gated=true(CAST) → 마나 → 클래스 → knowledge 순서 게이트, 통과 시에만 마나 소비.
 */

// 라이브 mpCurrent를 가진 가변 Caster 스텁 — 마나 소비 write-through를 관찰한다.
function makeCaster(overrides: Partial<Caster> & { mp?: number } = {}): Caster {
  let mp = overrides.mp ?? 30
  const knownSet = new Set<number>(overrides.knows ? [] : [7]) // 기본 주문 7 보유
  return {
    get mpCurrent() {
      return mp
    },
    set mpCurrent(v: number) {
      mp = v
    },
    level: overrides.level ?? 5,
    realm: overrides.realm ?? [0, 0, 0, 0],
    class: overrides.class ?? MAGE,
    intBonus: overrides.intBonus ?? 0,
    knows: overrides.knows ?? ((spellNo: number) => knownSet.has(spellNo)),
  }
}

// 표준 요구: manaCost 10, MAGE/CLERIC 전용, spellNo 7.
const REQ: CastRequirement = { manaCost: 10, requiredClasses: [MAGE, CLERIC], spellNo: 7 }

describe('evaluateGate — gated=false(아이템 경로, 전 게이트 우회)', () => {
  it('마나 부족·클래스 불일치·미보유여도 통과한다(A6 §1 콘텐츠 보존)', () => {
    const caster = makeCaster({ mp: 0, class: CARETAKER, knows: () => false })
    const result = evaluateGate(caster, REQ, false)
    expect(result.passed).toBe(true)
    expect(result.failure).toBeNull()
  })
})

describe('evaluateGate — gated=true(CAST, 순차 게이트)', () => {
  it('mpCurrent < manaCost면 mana 실패', () => {
    const caster = makeCaster({ mp: 9 })
    const result = evaluateGate(caster, REQ, true)
    expect(result.passed).toBe(false)
    expect(result.failure).toBe('mana')
  })

  it('mpCurrent == manaCost면 mana 게이트 통과(< 만 실패)', () => {
    const caster = makeCaster({ mp: 10 })
    // 클래스·knowledge는 만족(MAGE, spell 7 보유) → 최종 통과.
    expect(evaluateGate(caster, REQ, true).passed).toBe(true)
  })

  it('requiredClasses에 없고 class < INVINCIBLE이면 class 실패', () => {
    // BARBARIAN=2, requiredClasses[MAGE,CLERIC]에 없고 2 < INVINCIBLE(9) → class 실패.
    const barbarian = makeCaster({ mp: 30, class: 2 })
    const result = evaluateGate(barbarian, REQ, true)
    expect(result.passed).toBe(false)
    expect(result.failure).toBe('class')
  })

  it('class >= INVINCIBLE이면 requiredClasses에 없어도 클래스 게이트 우회(A6 §3)', () => {
    const caster = makeCaster({ mp: 30, class: INVINCIBLE, knows: () => true })
    const result = evaluateGate(caster, REQ, true)
    expect(result.passed).toBe(true)
    expect(result.failure).toBeNull()
  })

  it('requiredClasses 미지정이면 클래스 무제한(어느 클래스도 통과)', () => {
    const caster = makeCaster({ mp: 30, class: 2, knows: (s: number) => s === 7 })
    const req: CastRequirement = { manaCost: 10, spellNo: 7 }
    expect(evaluateGate(caster, req, true).passed).toBe(true)
  })

  it('주문 미보유면 knowledge 실패', () => {
    const caster = makeCaster({ mp: 30, class: MAGE, knows: () => false })
    const result = evaluateGate(caster, REQ, true)
    expect(result.passed).toBe(false)
    expect(result.failure).toBe('knowledge')
  })

  it('마나·클래스·knowledge 모두 만족하면 통과', () => {
    const caster = makeCaster({ mp: 30, class: MAGE, knows: (s: number) => s === 7 })
    const result = evaluateGate(caster, REQ, true)
    expect(result.passed).toBe(true)
    expect(result.failure).toBeNull()
  })

  it('게이트는 순서대로: mana가 class·knowledge보다 먼저 판정된다', () => {
    // 마나 부족 + 클래스 불일치 + 미보유 → mana가 먼저 걸린다.
    const caster = makeCaster({ mp: 0, class: 2, knows: () => false })
    expect(evaluateGate(caster, REQ, true).failure).toBe('mana')
  })

  it('게이트는 순서대로: class가 knowledge보다 먼저 판정된다', () => {
    // 마나 충분 + 클래스 불일치 + 미보유 → class가 knowledge보다 먼저.
    const caster = makeCaster({ mp: 30, class: 2, knows: () => false })
    expect(evaluateGate(caster, REQ, true).failure).toBe('class')
  })
})

describe('applyCastGate — 마나 소비(gated 통과 경로 한정, A6 §2)', () => {
  it('gated=true 통과 시 mpCurrent -= manaCost (write-through)', () => {
    const caster = makeCaster({ mp: 30, class: MAGE, knows: (s: number) => s === 7 })
    const result = applyCastGate(caster, REQ, true)
    expect(result.passed).toBe(true)
    expect(caster.mpCurrent).toBe(20) // 30 - 10
  })

  it('gated=true 게이트 실패 시 마나 미소비', () => {
    const caster = makeCaster({ mp: 9 }) // mana 실패
    const result = applyCastGate(caster, REQ, true)
    expect(result.passed).toBe(false)
    expect(caster.mpCurrent).toBe(9) // 불변
  })

  it('gated=false(아이템 경로) 통과여도 마나 미소비(A6 §2)', () => {
    const caster = makeCaster({ mp: 30 })
    const result = applyCastGate(caster, REQ, false)
    expect(result.passed).toBe(true)
    expect(caster.mpCurrent).toBe(30) // 불변 — 아이템은 마나 안 씀
  })

  it('gated=true 클래스 실패 시 마나 미소비', () => {
    const caster = makeCaster({ mp: 30, class: 2 }) // class 실패
    applyCastGate(caster, REQ, true)
    expect(caster.mpCurrent).toBe(30)
  })
})
