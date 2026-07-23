import { describe, it, expect } from 'vitest'
import { createCombatRegistry } from './combatRegistry.js'
import type { PlayerCombatState } from './playerState.js'

/**
 * combatRegistry 라이프사이클 — characterId-keyed 라이브 전투상태 레지스트리.
 *
 * 플레이어는 방-물질화 객체가 아닌 세션 액터이므로 방 부착이 아닌 characterId 키로 관리한다.
 * register 후 get은 동일 참조(reference)를 반환해야 한다 — Story 5가 이 참조로 hpCurrent를
 * in-place 차감하기 때문. 팩토리가 Map을 소유하며 전역 싱글턴을 조회하지 않는다.
 */
function makeState(characterId: string): PlayerCombatState {
  return {
    characterId,
    hpCurrent: 40,
    mpCurrent: 10,
    level: 5,
    class: 4,
    effectiveStrength: 16,
    effectiveIntelligence: 10,
    armor: 8,
    thaco: 15,
    dexterity: 16,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    flags: '',
    alignment: 0,
    weapon: { ndice: 1, sdice: 6, pdice: 0, adjustment: 0, proficiency: 0 },
    nextAttackAt: 0,
  }
}

describe('createCombatRegistry', () => {
  it('register 후 get이 동일 참조를 반환한다', () => {
    const registry = createCombatRegistry()
    const state = makeState('char-1')
    registry.register(state)
    expect(registry.get('char-1')).toBe(state)
  })

  it('등록된 참조를 in-place로 변형하면 get도 반영한다', () => {
    const registry = createCombatRegistry()
    const state = makeState('char-1')
    registry.register(state)
    const held = registry.get('char-1')
    held!.hpCurrent -= 10
    expect(state.hpCurrent).toBe(30)
  })

  it('미등록 characterId는 undefined를 반환한다', () => {
    const registry = createCombatRegistry()
    expect(registry.get('missing')).toBeUndefined()
  })

  it('has는 등록 여부를 반영한다', () => {
    const registry = createCombatRegistry()
    expect(registry.has('char-1')).toBe(false)
    registry.register(makeState('char-1'))
    expect(registry.has('char-1')).toBe(true)
  })

  it('remove 후 has=false, get=undefined', () => {
    const registry = createCombatRegistry()
    registry.register(makeState('char-1'))
    registry.remove('char-1')
    expect(registry.has('char-1')).toBe(false)
    expect(registry.get('char-1')).toBeUndefined()
  })

  it('두 레지스트리는 상태를 공유하지 않는다(전역 싱글턴 미조회)', () => {
    const a = createCombatRegistry()
    const b = createCombatRegistry()
    a.register(makeState('char-1'))
    expect(a.has('char-1')).toBe(true)
    expect(b.has('char-1')).toBe(false)
  })
})
