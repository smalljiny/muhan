import { describe, it, expect } from 'vitest'
import * as magic from './index.js'

/**
 * magic 배럴 스모크 — 공개 표면(toCaster·SpellDispatch)이 배럴에서 재export됨을 고정한다.
 * 카탈로그는 shared/magic 소유라 배럴에 노출하지 않는다.
 */
describe('magic 배럴', () => {
  it('toCaster·SpellDispatch를 재export한다', () => {
    expect(typeof magic.toCaster).toBe('function')
    expect(typeof magic.SpellDispatch).toBe('function')
  })

  it('시전 게이트·spell_fail 표면을 재export한다', () => {
    expect(typeof magic.evaluateGate).toBe('function')
    expect(typeof magic.applyCastGate).toBe('function')
    expect(typeof magic.spellFail).toBe('function')
    expect(typeof magic.spellFailChance).toBe('function')
    expect(typeof magic.rollsSpellFail).toBe('function')
  })

  it('crtSpell 시전 seam·순수 헬퍼를 재export한다', () => {
    expect(typeof magic.crtSpell).toBe('function')
    expect(typeof magic.selectSpell).toBe('function')
    expect(typeof magic.isSelfTargetSpell).toBe('function')
  })

  it('카탈로그 표면은 배럴에 노출하지 않는다(shared/magic 소유)', () => {
    expect('SPELL_CATALOG' in magic).toBe(false)
    expect('spellByNo' in magic).toBe(false)
  })
})
