import { describe, it, expect } from 'vitest'
import { createCreatureLedgers } from './creatureLedgers.js'
import { accumulateDamage } from './enmity.js'

/**
 * creatureLedgers 라우팅 계약 — 크리처(defender) instanceId별 데미지 원장 분리.
 *
 * `DamageLedger`는 `Map<attackerId, number>`라 defender를 키에 담지 않는다. 그래서 크리처마다
 * 별도 원장을 쥐어 주는 라우팅이 없으면 몬스터 B에 준 데미지가 몬스터 A 사망 보상에 섞인다.
 * 아래 테스트가 그 분리를 고정한다.
 */
describe('createCreatureLedgers', () => {
  it('instanceId가 다르면 서로 다른 원장 참조를 돌려준다', () => {
    const ledgers = createCreatureLedgers()
    expect(ledgers.for('a')).not.toBe(ledgers.for('b'))
  })

  it('같은 instanceId에는 항상 같은 참조를 돌려준다(누적 유지)', () => {
    const ledgers = createCreatureLedgers()
    const first = ledgers.for('a')
    accumulateDamage(first, 'player-1', 7)
    const second = ledgers.for('a')

    expect(second).toBe(first)
    expect(second.get('player-1')).toBe(7)
  })

  it('크리처 A에 누적한 데미지가 크리처 B 원장에 나타나지 않는다', () => {
    const ledgers = createCreatureLedgers()
    accumulateDamage(ledgers.for('a'), 'player-1', 10)
    accumulateDamage(ledgers.for('b'), 'player-1', 3)

    expect(ledgers.for('a').get('player-1')).toBe(10)
    expect(ledgers.for('b').get('player-1')).toBe(3)
  })

  it('처음 조회한 원장은 비어 있다', () => {
    const ledgers = createCreatureLedgers()
    expect(ledgers.for('a').size).toBe(0)
  })

  it('discard 후 같은 id로 조회하면 비어 있는 새 원장이다', () => {
    const ledgers = createCreatureLedgers()
    const before = ledgers.for('a')
    accumulateDamage(before, 'player-1', 10)

    ledgers.discard('a')
    const after = ledgers.for('a')

    expect(after).not.toBe(before)
    expect(after.size).toBe(0)
  })

  it('discard는 다른 크리처의 원장을 건드리지 않는다', () => {
    const ledgers = createCreatureLedgers()
    accumulateDamage(ledgers.for('a'), 'player-1', 10)
    accumulateDamage(ledgers.for('b'), 'player-1', 3)

    ledgers.discard('a')

    expect(ledgers.for('b').get('player-1')).toBe(3)
  })

  it('없는 id를 discard해도 오류가 없다', () => {
    const ledgers = createCreatureLedgers()
    expect(() => ledgers.discard('missing')).not.toThrow()
  })

  it('팩토리 인스턴스끼리 상태를 공유하지 않는다(전역 싱글턴 미조회)', () => {
    const first = createCreatureLedgers()
    const second = createCreatureLedgers()
    accumulateDamage(first.for('a'), 'player-1', 10)

    expect(second.for('a').size).toBe(0)
  })
})
