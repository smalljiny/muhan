import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from 'shared'

import { makeRoom, roomEvent } from '../test/roomFixtures.testutil'
import { describeEvent } from './describeEvent'

describe('describeEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('summarizes world:room as "<room name> (#<roomId>)"', () => {
    expect(describeEvent(roomEvent(makeRoom()))).toBe('무한의 광장 (#1)')
  })

  it('keeps the roomId suffix when the room name is empty', () => {
    expect(describeEvent(roomEvent(makeRoom({ name: '', roomId: 5 })))).toBe(' (#5)')
  })

  it('renders other event types as their raw JSON', () => {
    const event: ServerEvent = { type: 'debug:echo:result', text: '퐁' }

    expect(describeEvent(event)).toBe(JSON.stringify(event))
  })

  it('does not serialize a world:room event', () => {
    const event = roomEvent(makeRoom())
    const other: ServerEvent = { type: 'debug:echo:result', text: '퐁' }
    const spy = vi.spyOn(JSON, 'stringify')

    describeEvent(event)
    describeEvent(other)

    expect(spy.mock.calls.filter(([arg]) => arg === event)).toHaveLength(0)
    // 양성 대조: spy가 실제로 호출을 잡고 있음을 같은 테스트에서 확인한다.
    expect(spy.mock.calls.filter(([arg]) => arg === other)).toHaveLength(1)
  })
})

describe('describeEvent combat:round', () => {
  type CombatRoundEvent = Extract<ServerEvent, { type: 'combat:round' }>

  // 기본값은 아무 세그먼트도 붙지 않는 라운드다 — 각 케이스가 검증할 필드만 덮어쓴다.
  function roundEvent(overrides: Partial<Omit<CombatRoundEvent, 'type'>> = {}): CombatRoundEvent {
    return {
      type: 'combat:round',
      creatureInstanceId: 'm1',
      creatureName: '고블린',
      received: null,
      counter: null,
      monsterDied: false,
      youDied: false,
      ...overrides,
    }
  }

  const MELEE = { kind: 'melee', hit: true, damage: 12, critical: false, fumble: false } as const
  const COUNTER = { hit: true, damage: 5, critical: false, fumble: false } as const

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the full example "[전투] 고블린 · 피격 12 · 반격 5 · 처치"', () => {
    const event = roundEvent({ received: MELEE, counter: COUNTER, monsterDied: true })

    expect(describeEvent(event)).toBe('[전투] 고블린 · 피격 12 · 반격 5 · 처치')
  })

  it('renders only the header when every segment is absent', () => {
    expect(describeEvent(roundEvent())).toBe('[전투] 고블린')
  })

  it.each([
    ['melee hit', MELEE, '[전투] 고블린 · 피격 12'],
    ['melee critical hit', { ...MELEE, critical: true }, '[전투] 고블린 · 피격 12 치명'],
    ['melee miss', { ...MELEE, hit: false, damage: 0 }, '[전투] 고블린 · 피격 빗나감'],
    ['cast', { kind: 'cast', damage: 7 } as const, '[전투] 고블린 · 주문 7'],
    ['cast without damage', { kind: 'cast', damage: 0 } as const, '[전투] 고블린 · 주문 0'],
  ] as const)('renders received %s', (_label, received, expected) => {
    expect(describeEvent(roundEvent({ received }))).toBe(expected)
  })

  it.each([
    ['hit', COUNTER, '[전투] 고블린 · 반격 5'],
    ['fumble', { ...COUNTER, hit: false, damage: 0, fumble: true }, '[전투] 고블린 · 반격 불발'],
    ['miss', { ...COUNTER, hit: false, damage: 0 }, '[전투] 고블린 · 반격 빗나감'],
  ] as const)('renders counter %s', (_label, counter, expected) => {
    expect(describeEvent(roundEvent({ counter }))).toBe(expected)
  })

  it('renders youDied as "사망"', () => {
    expect(describeEvent(roundEvent({ received: MELEE, youDied: true }))).toBe(
      '[전투] 고블린 · 피격 12 · 사망',
    )
  })

  it('renders both deaths in the order 처치 then 사망', () => {
    expect(describeEvent(roundEvent({ monsterDied: true, youDied: true }))).toBe(
      '[전투] 고블린 · 처치 · 사망',
    )
  })

  it('does not serialize a combat:round event', () => {
    const event = roundEvent({ received: MELEE, counter: COUNTER })
    const other: ServerEvent = { type: 'debug:echo:result', text: '퐁' }
    const spy = vi.spyOn(JSON, 'stringify')

    describeEvent(event)
    describeEvent(other)

    expect(spy.mock.calls.filter(([arg]) => arg === event)).toHaveLength(0)
    // 양성 대조: spy가 실제로 호출을 잡고 있음을 같은 테스트에서 확인한다.
    expect(spy.mock.calls.filter(([arg]) => arg === other)).toHaveLength(1)
  })
})
