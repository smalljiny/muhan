import { describe, it, expect } from 'vitest'
import * as combat from './index.js'
import { maxRollRng } from './dice.testutil.js'

/**
 * combat 배럴 스모크 — 공개 표면(dice·mdice·튜닝 상수)이 배럴에서 재export되고, 결정적 stub은
 * 배럴에 노출되지 않음을 고정한다.
 */
describe('combat 배럴', () => {
  it('dice·mdice 함수를 재export한다', () => {
    expect(combat.dice(2, 6, 3, maxRollRng)).toBe(3 + 2 * 6)
    expect(combat.mdice({ ndice: 2, sdice: 6, pdice: 3 }, maxRollRng)).toBe(3 + 2 * 6)
  })

  it('튜닝 상수를 재export한다', () => {
    expect(combat.CRIT_MULTIPLIER_MIN).toBe(3)
    expect(combat.CRIT_MULTIPLIER_MAX).toBe(6)
    expect(combat.HIT_ROLL_MAX_PLAYER).toBe(30)
    expect(combat.HIT_ROLL_MAX_MONSTER).toBe(20)
    expect(combat.PVP_COOLDOWN_INCREMENT).toBe(3)
  })

  it('test-only stub은 배럴에 노출하지 않는다', () => {
    expect('maxRollRng' in combat).toBe(false)
    expect('minRollRng' in combat).toBe(false)
    expect('seqRng' in combat).toBe(false)
  })

  it('playerState·registry 표면을 재export한다', () => {
    expect(typeof combat.toPlayerCombatState).toBe('function')
    expect(typeof combat.createCombatRegistry).toBe('function')
  })

  it('combatant·attackStats 표면을 재export한다', () => {
    expect(typeof combat.toCombatant).toBe('function')
    expect(typeof combat.hitThreshold).toBe('function')
    expect(typeof combat.playerBaseDamage).toBe('function')
    expect(typeof combat.monsterDamage).toBe('function')
    expect(typeof combat.applyPaladinAlignment).toBe('function')
  })

  it('클래스 인덱스 상수를 재export한다', () => {
    expect(combat.BARBARIAN).toBe(2)
    expect(combat.CLERIC).toBe(3)
    expect(combat.MAGE).toBe(5)
    expect(combat.PALADIN).toBe(6)
    expect(combat.INVINCIBLE).toBe(9)
  })

  it('pvp 게이트 표면을 재export한다', () => {
    expect(typeof combat.checkTargetImmunity).toBe('function')
    expect(typeof combat.checkPvpGate).toBe('function')
  })
})
