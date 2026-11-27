import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { ServerEvent } from 'shared'

import { makeRoom, roomEvent } from '../test/roomFixtures.testutil'
import { appendBounded } from '../transport/appendBounded'
import { EVENT_LOG_LIMIT } from '../transport/wsClient'
import type { LoggedEvent } from '../transport/wsClient'
import { EventLog } from './EventLog'

// 원본 이벤트 배열을 수신 순서대로 seq를 매긴 기록 형태로 감싼다.
function logged(events: readonly ServerEvent[]): LoggedEvent[] {
  return events.map((event, seq) => ({ seq, event }))
}

describe('EventLog', () => {
  it('renders received events in reception order', () => {
    const events: ServerEvent[] = [
      { type: 'system:hello', protocolVersion: 1 },
      { type: 'debug:echo:result', text: '퐁' },
      { type: 'session:entered', characterId: 'char-1' },
    ]

    render(<EventLog events={logged(events)} />)

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('system:hello')
    expect(items[1]).toHaveTextContent('debug:echo:result')
    expect(items[1]).toHaveTextContent('퐁')
    expect(items[2]).toHaveTextContent('session:entered')
  })

  it('shows the original type and payload content of each event', () => {
    const events: ServerEvent[] = [{ type: 'debug:echo:result', text: '메아리' }]

    render(<EventLog events={logged(events)} />)

    const item = screen.getByRole('listitem')
    expect(within(item).getByText('debug:echo:result')).toBeInTheDocument()
    expect(item).toHaveTextContent('메아리')
  })

  it('renders an empty list when there are no events', () => {
    render(<EventLog events={[]} />)

    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})

describe('EventLog memoized rows', () => {
  let spy: MockInstance<typeof JSON.stringify>

  // 대상 이벤트 객체와 참조가 같은 첫 인자로 호출된 횟수만 센다(다른 경로의 직렬화는 무시).
  function callsFor(event: ServerEvent): number {
    return spy.mock.calls.filter(([arg]) => arg === event).length
  }

  function echo(text: string): ServerEvent {
    return { type: 'debug:echo:result', text }
  }

  beforeEach(() => {
    spy = vi.spyOn(JSON, 'stringify')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serializes only the appended event when a new event is added', () => {
    const initial = [echo('하나'), echo('둘'), echo('셋')]
    const events = logged(initial)
    const { rerender } = render(<EventLog events={events} />)
    spy.mockClear()

    const added = echo('넷')
    rerender(<EventLog events={[...events, { seq: 3, event: added }]} />)

    expect(callsFor(added)).toBe(1)
    for (const event of initial) {
      expect(callsFor(event)).toBe(0)
    }
  })

  it('summarizes an appended world:room without serializing it', () => {
    const events = logged([echo('하나')])
    const { rerender } = render(<EventLog events={events} />)
    spy.mockClear()

    const room = roomEvent(makeRoom())
    const withRoom = [...events, { seq: 1, event: room }]
    rerender(<EventLog events={withRoom} />)

    expect(callsFor(room)).toBe(0)
    const last = screen.getAllByRole('listitem').at(-1)
    expect(last?.querySelector('span')).toHaveTextContent('world:room')
    expect(last?.querySelector('code')?.textContent).toBe('무한의 광장 (#1)')

    const unnamed = roomEvent(makeRoom({ name: '', roomId: 5 }))
    rerender(<EventLog events={[...withRoom, { seq: 2, event: unnamed }]} />)

    const lastRow = screen.getAllByRole('listitem').at(-1)
    expect(lastRow?.querySelector('code')?.textContent).toBe(' (#5)')
  })

  it('does not serialize anything when rerendered with the same array', () => {
    const initial = [echo('하나'), echo('둘'), echo('셋')]
    const events = logged(initial)
    const { rerender } = render(<EventLog events={events} />)
    spy.mockClear()

    rerender(<EventLog events={events} />)

    for (const event of initial) {
      expect(callsFor(event)).toBe(0)
    }
  })

  it('keeps remaining rows unserialized when the bound drops the oldest row', () => {
    const initial = Array.from({ length: EVENT_LOG_LIMIT }, (_, i) => echo(`항목 ${i}`))
    const events = logged(initial)
    const { rerender } = render(<EventLog events={events} />)
    spy.mockClear()

    const added = echo('새 항목')
    rerender(
      <EventLog
        events={appendBounded(events, { seq: EVENT_LOG_LIMIT, event: added }, EVENT_LOG_LIMIT)}
      />,
    )

    for (const event of initial.slice(1)) {
      expect(callsFor(event)).toBe(0)
    }
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(EVENT_LOG_LIMIT)
    expect(items[0]?.querySelector('code')?.textContent).toBe(JSON.stringify(initial[1]))
  })
})
