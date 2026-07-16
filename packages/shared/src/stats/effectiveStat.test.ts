import { describe, it, expect } from 'vitest'
import { effectiveStat } from './effectiveStat.js'
import type { StatModifier } from './effectiveStat.js'

// ---------------------------------------------------------------------------
// T2.2 — effectiveStat: base + Σ modifiers.delta 순수 가산 (무clamp)
// ---------------------------------------------------------------------------
describe('effectiveStat 순수 가산 합성', () => {
  it('base + 단일 modifier를 합산한다', () => {
    const mods: readonly StatModifier[] = [{ source: 'ring', stat: 'strength', delta: 2 }]
    expect(effectiveStat(10, mods)).toBe(12)
  })

  it('base + 다중 modifier를 합산한다', () => {
    const mods: readonly StatModifier[] = [
      { source: 'ring', stat: 'dexterity', delta: 2 },
      { source: 'potion', stat: 'dexterity', delta: 3 },
      { source: 'aura', stat: 'dexterity', delta: 1 },
    ]
    expect(effectiveStat(10, mods)).toBe(16)
  })

  it('빈 modifier 배열이면 base를 그대로 반환한다', () => {
    expect(effectiveStat(14, [])).toBe(14)
  })

  it('음수 delta는 감산한다', () => {
    const mods: readonly StatModifier[] = [
      { source: 'curse', stat: 'constitution', delta: -3 },
      { source: 'poison', stat: 'constitution', delta: -2 },
    ]
    expect(effectiveStat(15, mods)).toBe(10)
  })

  it('base=18 + 양수 delta는 18을 초과한다 (무clamp)', () => {
    const mods: readonly StatModifier[] = [{ source: 'buff', stat: 'strength', delta: 5 }]
    expect(effectiveStat(18, mods)).toBe(23)
  })

  it('stat이 서로 다른 modifier도 전체 delta를 합산한다 (stat-agnostic 계약)', () => {
    // effectiveStat은 modifier.stat을 읽지 않으므로 이종 stat이 섞여도 전부 합산된다.
    // 소비자가 stat별 선별을 마친 뒤 넘긴다는 계약을 테스트로 못박는다.
    const mods: readonly StatModifier[] = [
      { source: 'ring', stat: 'strength', delta: 2 },
      { source: 'aura', stat: 'dexterity', delta: 3 },
    ]
    expect(effectiveStat(10, mods)).toBe(15)
  })
})
