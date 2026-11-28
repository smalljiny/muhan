import { describe, it, expect, vi } from 'vitest'
import { createCombatTickBinding } from './combatTickBinding.js'
import { makeCreature, makeRoom } from './roomFixtures.testutil.js'

/**
 * combatTickBinding — `world/`가 `combat/`을 import하지 않고 나중에 조립된 전투 핸들러로
 * `onCombatTick`을 위임하게 하는 지연 바인딩 슬롯.
 *
 * 고정하는 계약: 바인딩 전 no-op, 바인딩 후 인자 그대로 위임, 2회 바인딩은 조립 오류로 throw,
 * `onCombatTick` 참조는 바인딩 전후 동일(먼저 받아 둔 참조로 불러도 바인딩이 반영된다 — creatureTick 실조립 경로는 조립 통합 테스트가 검증한다).
 */
describe('createCombatTickBinding', () => {
  const creature = makeCreature('c-1', '고블린')
  const room = makeRoom()

  it('바인딩 전 호출은 아무 것도 하지 않고 throw하지 않는다', () => {
    const binding = createCombatTickBinding()

    expect(binding.onCombatTick(creature, room)).toBeUndefined()
  })

  it('바인딩 후 호출은 (creature, room)을 그대로 핸들러에 위임한다', () => {
    const binding = createCombatTickBinding()
    const handler = vi.fn()

    binding.bind(handler)
    binding.onCombatTick(creature, room)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(creature, room)
    expect(handler.mock.calls[0]?.[0]).toBe(creature)
    expect(handler.mock.calls[0]?.[1]).toBe(room)
  })

  it('바인딩 전 호출은 나중에 바인딩된 핸들러로 소급 전달되지 않는다', () => {
    const binding = createCombatTickBinding()
    const handler = vi.fn()

    binding.onCombatTick(creature, room)
    binding.bind(handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it('bind를 두 번 부르면 조립 오류로 throw하고 첫 핸들러를 유지한다', () => {
    const binding = createCombatTickBinding()
    const first = vi.fn()
    const second = vi.fn()

    binding.bind(first)

    expect(() => binding.bind(second)).toThrow(/조립 오류/)

    binding.onCombatTick(creature, room)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('onCombatTick 참조는 바인딩 전후로 동일하다', () => {
    const binding = createCombatTickBinding()
    const before = binding.onCombatTick
    const handler = vi.fn()

    binding.bind(handler)

    expect(binding.onCombatTick).toBe(before)
    before(creature, room)
    expect(handler).toHaveBeenCalledWith(creature, room)
  })

  it('슬롯마다 독립적인 바인딩 상태를 가진다', () => {
    const a = createCombatTickBinding()
    const b = createCombatTickBinding()
    const handler = vi.fn()

    a.bind(handler)
    b.onCombatTick(creature, room)

    expect(handler).not.toHaveBeenCalled()
    expect(() => b.bind(vi.fn())).not.toThrow()
  })
})
