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
