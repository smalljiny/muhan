import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ConnectionStatus } from './ConnectionStatus'

describe('ConnectionStatus', () => {
  it('displays the current connection status', () => {
    render(<ConnectionStatus status="ready" onReconnect={vi.fn()} />)

    expect(screen.getByLabelText('연결 상태')).toHaveTextContent('ready')
  })

  it('renders a distinct status for each lifecycle value', () => {
    const { rerender } = render(
      <ConnectionStatus status="disconnected" onReconnect={vi.fn()} />,
    )
    expect(screen.getByLabelText('연결 상태')).toHaveTextContent('disconnected')

    rerender(<ConnectionStatus status="connecting" onReconnect={vi.fn()} />)
    expect(screen.getByLabelText('연결 상태')).toHaveTextContent('connecting')
  })

  it('calls onReconnect when the reconnect button is clicked', async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    render(<ConnectionStatus status="disconnected" onReconnect={onReconnect} />)

    await user.click(screen.getByRole('button', { name: '재연결' }))

    expect(onReconnect).toHaveBeenCalledTimes(1)
  })
})
