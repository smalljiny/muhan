import { describe, it, expect } from 'vitest'
import type { CreatureInstance } from 'shared'
import { registerEnemy, createDamageLedger, accumulateDamage } from './enmity.js'

/**
 * enmity 단위 테스트 — 오라클 creature.c add_enm_crt(:70, dedup) / add_enm_dmg(:213, per-attacker
 * 누적) 대응. registerEnemy는 creature.enemies(라이브 가변 string[])에 중복 없이 in-place push하고,
 * 데미지 원장(Map<attackerId, number>)은 attacker별로 누적만 한다(분배는 #83 non-goal).
 */
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
    realm: [0, 0, 0, 0],
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '',
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

describe('registerEnemy', () => {
  it('신규 attackerId를 enemies에 추가한다(add_enm_crt 신규 경로)', () => {
    const crt = makeCreature()
    registerEnemy(crt, 'char-A')
    expect(crt.enemies).toEqual(['char-A'])
  })

  it('이미 등록된 attackerId는 재등록하지 않는다(dedup — add_enm_crt find_enm_crt > -1 즉시 반환)', () => {
    const crt = makeCreature()
    registerEnemy(crt, 'char-A')
    registerEnemy(crt, 'char-A')
    expect(crt.enemies).toEqual(['char-A'])
    expect(crt.enemies.length).toBe(1)
  })

  it('서로 다른 attackerId는 순서대로 누적한다', () => {
    const crt = makeCreature()
    registerEnemy(crt, 'char-A')
    registerEnemy(crt, 'char-B')
    expect(crt.enemies).toEqual(['char-A', 'char-B'])
  })

  it('enemies 배열을 in-place 변경한다(라이브 가변 참조 보존)', () => {
    const crt = makeCreature()
    const ref = crt.enemies
    registerEnemy(crt, 'char-A')
    expect(crt.enemies).toBe(ref)
  })
})

describe('createDamageLedger', () => {
  it('빈 원장(Map)을 만든다', () => {
    const ledger = createDamageLedger()
    expect(ledger.size).toBe(0)
  })

  it('호출마다 독립 인스턴스를 반환한다(전역 싱글턴 미조회)', () => {
    const a = createDamageLedger()
    const b = createDamageLedger()
    accumulateDamage(a, 'char-A', 5)
    expect(b.size).toBe(0)
  })
})

describe('accumulateDamage', () => {
  it('신규 attacker의 데미지를 기록한다', () => {
    const ledger = createDamageLedger()
    accumulateDamage(ledger, 'char-A', 7)
    expect(ledger.get('char-A')).toBe(7)
  })

  it('같은 attacker의 데미지를 누적한다(add_enm_dmg ep->damage += dmg)', () => {
    const ledger = createDamageLedger()
    accumulateDamage(ledger, 'char-A', 7)
    accumulateDamage(ledger, 'char-A', 5)
    expect(ledger.get('char-A')).toBe(12)
  })

  it('attacker별로 원장을 분리 누적한다(per-attacker 표현 — #83 소비)', () => {
    const ledger = createDamageLedger()
    accumulateDamage(ledger, 'char-A', 7)
    accumulateDamage(ledger, 'char-B', 3)
    accumulateDamage(ledger, 'char-A', 1)
    expect(ledger.get('char-A')).toBe(8)
    expect(ledger.get('char-B')).toBe(3)
    expect(ledger.size).toBe(2)
  })
})
