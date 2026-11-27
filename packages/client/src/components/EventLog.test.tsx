import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ServerEvent } from 'shared'

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
