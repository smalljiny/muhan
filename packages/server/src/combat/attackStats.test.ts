import { describe, it, expect } from 'vitest'
import { bonusOf, class_stats, type CreatureInstance } from 'shared'
import { hitThreshold, playerBaseDamage, monsterDamage, applyPaladinAlignment } from './attackStats.js'
import { toCombatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'
import { seqRng } from './dice.testutil.js'
import { F_SET, PFEARS, PBLIND, MBEFUD } from '../world/hexFlags.js'

/**
 * 비트가 세팅된 well-formed flag hex를 만든다. F_SET은 짧은 문자열을 zero-pad하지 않으므로
 * 고바이트 비트(PFEARS=44·MBEFUD=51 등)를 올바른 바이트에 놓으려면 8바이트(16자) 0 기반에서 세팅한다.
 */
const ZERO_FLAGS = '0000000000000000'
function flagsWith(...bits: readonly number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), ZERO_FLAGS)
}

/**
 * attackStats — 명중 임계(hitThreshold)·피해 분기(playerBaseDamage/monsterDamage)·PALADIN 정렬
 * 보정(applyPaladinAlignment)의 오라클 충실 이식.
 *
 * byte-fidelity 함정: 모든 `/`는 C 정수 나눗셈(0 방향 절사) = Math.trunc(절대 Math.floor 아님).
 * 음수 피제수에서 갈리므로 음수 armor(armor/8)·armor>70((70−armor)/5) 케이스를 고정한다.
 */
function makePlayer(overrides: Partial<PlayerCombatState> = {}): PlayerCombatState {
  return {
    characterId: 'char-1',
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    class: 4,
    effectiveStrength: 16,
    armor: 8,
    thaco: 15,
    dexterity: 18,
    flags: '',
    alignment: 1,
    weapon: { ndice: 2, sdice: 6, pdice: 3, adjustment: 2, proficiency: 60 },
    nextAttackAt: 0,
    ...overrides,
  }
}

function makeCreature(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: 'crt-1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 30,
    hpcur: 24,
    mpmax: 0,
    mpcur: 0,
    dexterity: 12,
    gold: 5,
    special: 0,
    armor: 20,
    thaco: 18,
    ndice: 1,
    sdice: 6,
    pdice: 2,
    flags: '',
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

describe('hitThreshold', () => {
  it('플레이어 기본: thaco − trunc(armor/8)', () => {
    const attacker = toCombatant(makePlayer({ thaco: 15 }))
    const defender = toCombatant(makeCreature({ armor: 8 }))
    // 15 − trunc(8/8)=15−1=14
    expect(hitThreshold(attacker, defender)).toBe(14)
  })

  it('플레이어 PFEARS면 +2', () => {
    const attacker = toCombatant(makePlayer({ thaco: 15, flags: flagsWith(PFEARS) }))
    const defender = toCombatant(makeCreature({ armor: 8 }))
    expect(hitThreshold(attacker, defender)).toBe(16)
  })

  it('플레이어 PBLIND면 +5', () => {
    const attacker = toCombatant(makePlayer({ thaco: 15, flags: flagsWith(PBLIND) }))
    const defender = toCombatant(makeCreature({ armor: 8 }))
    expect(hitThreshold(attacker, defender)).toBe(19)
  })

  it('플레이어 PFEARS+PBLIND면 +7', () => {
    const attacker = toCombatant(makePlayer({ thaco: 15, flags: F_SET(flagsWith(PFEARS), PBLIND) }))
    const defender = toCombatant(makeCreature({ armor: 8 }))
    expect(hitThreshold(attacker, defender)).toBe(21)
  })

  it('몬스터는 max(1,·) 하한을 적용한다', () => {
    // thaco 2, defender armor 40 → 2 − trunc(40/8)=2−5=−3 → max(1,−3)=1
    const attacker = toCombatant(makeCreature({ thaco: 2 }))
    const defender = toCombatant(makePlayer({ armor: 40 }))
    expect(hitThreshold(attacker, defender)).toBe(1)
  })

  it('몬스터는 PFEARS/PBLIND 보정을 받지 않는다', () => {
    // 몬스터 attacker의 flags에 PFEARS가 있어도 무시(플레이어 전용 보정)
    const attacker = toCombatant(makeCreature({ thaco: 15, flags: flagsWith(PFEARS) }))
    const defender = toCombatant(makeCreature({ armor: 8 }))
    // 15 − 1 = 14 (보정 없음)
    expect(hitThreshold(attacker, defender)).toBe(14)
  })

  it('음수 armor에서 armor/8을 Math.trunc로 절사한다(floor 아님)', () => {
    // defender armor −9 → trunc(−9/8)=−1 → 15−(−1)=16 (floor면 15−(−2)=17)
    const attacker = toCombatant(makePlayer({ thaco: 15 }))
    const defender = toCombatant(makeCreature({ armor: -9 }))
    expect(hitThreshold(attacker, defender)).toBe(16)
  })
})

describe('playerBaseDamage', () => {
  const strBonus = bonusOf(16)

  it('무기 착용: mdice(무기) + bonus[str] + trunc(profic/10)', () => {
    // weapon {ndice:2,sdice:6,pdice:3} → mdice=3+r1+r2, profic 60 → trunc(60/10)=6
    const attacker = toCombatant(makePlayer({ class: 4 }))
    const n = playerBaseDamage(attacker, seqRng([2, 5]))
    expect(n).toBe(3 + 2 + 5 + strBonus + 6)
  })

  it('BARBARIAN 맨손: mdice(self) + bonus[str] + trunc((level+3)/4)', () => {
    // class_stats[2] {ndice:2,sdice:3,pdice:1}, level 7 → trunc(10/4)=2
    const self = class_stats[2]!
    const attacker = toCombatant(makePlayer({ class: 2, weapon: null, level: 7 }))
    const n = playerBaseDamage(attacker, seqRng([3, 1]))
    expect(n).toBe(self.pdice + 3 + 1 + strBonus + 2)
  })

  it('class > INVINCIBLE 맨손: 바바리안과 동일 성장 분기', () => {
    // class 10 (caretaker) > 9 → mdice(self)+bonus+trunc((level+3)/4)
    const self = class_stats[10]!
    const attacker = toCombatant(makePlayer({ class: 10, weapon: null, level: 5 }))
    // self {ndice:5,...} → 5 dice. level 5 → trunc(8/4)=2
    const rolls = [1, 1, 1, 1, 1]
    const n = playerBaseDamage(attacker, seqRng(rolls))
    expect(n).toBe(self.pdice + 5 + strBonus + 2)
  })

  it('일반 클래스 맨손: mdice(self) + bonus[str] (성장 항 없음)', () => {
    // class 4 fighter, class_stats[4] {ndice:1,sdice:5,pdice:0}
    const self = class_stats[4]!
    const attacker = toCombatant(makePlayer({ class: 4, weapon: null }))
    const n = playerBaseDamage(attacker, seqRng([4]))
    expect(n).toBe(self.pdice + 4 + strBonus)
  })

  it('MAGE override(무기 착용): profic 항을 벗기고 mdice(무기)+bonus로 교체(두 단계 double-roll)', () => {
    // 분기(무기): mdice(weapon) 2회 roll → 무시. override: mdice(weapon) 2회 roll 재실행.
    const attacker = toCombatant(makePlayer({ class: 5 }))
    const n = playerBaseDamage(attacker, seqRng([1, 1, 4, 6]))
    // override의 두 번째 굴림 [4,6]만 반영: weapon pdice 3 + 4 + 6 + bonus
    expect(n).toBe(3 + 4 + 6 + strBonus)
  })

  it('CLERIC override(맨손): mdice(self)+bonus로 교체(성장/profic 항 없음)', () => {
    // class 3 cleric, class_stats[3] {ndice:1,sdice:4,pdice:0}
    const self = class_stats[3]!
    const attacker = toCombatant(makePlayer({ class: 3, weapon: null }))
    // 분기(else, 맨손): mdice(self) 1회 → 무시. override(맨손): mdice(self) 1회 재실행.
    const n = playerBaseDamage(attacker, seqRng([2, 3]))
    expect(n).toBe(self.pdice + 3 + strBonus)
  })
})

describe('monsterDamage', () => {
  it('mdice(self) − trunc((70−armor)/5), clamp min 1', () => {
    // creature {ndice:1,sdice:6,pdice:2} → mdice=2+r. defender armor 20 → trunc(50/5)=10
    const attacker = toCombatant(makeCreature({ ndice: 1, sdice: 6, pdice: 2 }))
    const defender = toCombatant(makePlayer({ armor: 20 }))
    // 2 + 5 − 10 = −3 → clamp → 1
    expect(monsterDamage(attacker, defender, seqRng([5]))).toBe(1)
  })

  it('감산 후 양수면 그대로 반환', () => {
    // pdice 40 → mdice=40+r. armor 20 → −10. 40+5−10=35
    const attacker = toCombatant(makeCreature({ ndice: 1, sdice: 6, pdice: 40 }))
    const defender = toCombatant(makePlayer({ armor: 20 }))
    expect(monsterDamage(attacker, defender, seqRng([5]))).toBe(35)
  })

  it('MBEFUD면 clamp 이후 trunc(n/3)로 나눈다', () => {
    // pdice 40 → 40+5−10=35, MBEFUD → trunc(35/3)=11
    const attacker = toCombatant(makeCreature({ ndice: 1, sdice: 6, pdice: 40, flags: flagsWith(MBEFUD) }))
    const defender = toCombatant(makePlayer({ armor: 20 }))
    expect(monsterDamage(attacker, defender, seqRng([5]))).toBe(11)
  })

  it('약한 MBEFUD 몬스터는 clamp(1) 후 trunc(1/3)=0 피해다(오라클 순서: clamp→befuddle, 재clamp 없음)', () => {
    // 2+5−10=−3 → clamp 1 → MBEFUD trunc(1/3)=0. Story 8 파이프는 몬스터 피해가 0이 될 수 있음에 유의.
    const attacker = toCombatant(makeCreature({ ndice: 1, sdice: 6, pdice: 2, flags: flagsWith(MBEFUD) }))
    const defender = toCombatant(makePlayer({ armor: 20 }))
    expect(monsterDamage(attacker, defender, seqRng([5]))).toBe(0)
  })

  it('armor>70에서 (70−armor)/5를 Math.trunc로 절사한다(음수 몫, floor 아님)', () => {
    // defender armor 72 → (70−72)/5 = −2/5 → trunc=0 (floor면 −1). pdice 10 → 10+1−0=11
    const attacker = toCombatant(makeCreature({ ndice: 1, sdice: 6, pdice: 10 }))
    const defender = toCombatant(makePlayer({ armor: 72 }))
    // trunc: 10+1−0=11. floor면 10+1−(−1)=12
    expect(monsterDamage(attacker, defender, seqRng([1]))).toBe(11)
  })
})

describe('applyPaladinAlignment', () => {
  it('alignment<0이면 trunc(n/2) (악행 페널티)', () => {
    expect(applyPaladinAlignment(7, -5, seqRng([]))).toBe(3) // trunc(7/2)=3
  })

  it('alignment>250이면 n + mrand(1,3) (선행 보너스)', () => {
    expect(applyPaladinAlignment(10, 300, seqRng([2]))).toBe(12)
  })

  it('중립 정렬(0~250)이면 n 그대로', () => {
    expect(applyPaladinAlignment(10, 100, seqRng([]))).toBe(10)
  })

  it('경계값 alignment=250은 보너스 없음, 0은 페널티 없음', () => {
    expect(applyPaladinAlignment(10, 250, seqRng([]))).toBe(10)
    expect(applyPaladinAlignment(10, 0, seqRng([]))).toBe(10)
  })
})
