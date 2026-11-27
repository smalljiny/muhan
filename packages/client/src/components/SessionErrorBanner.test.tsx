import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SessionErrorBanner } from './SessionErrorBanner'

describe('SessionErrorBanner', () => {
  it('renders nothing when error is null', () => {
    const { container } = render(<SessionErrorBanner error={null} onDismiss={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: '닫기' })).not.toBeInTheDocument()
  })

  it('renders a character permission message for unauthorized', () => {
    render(
      <SessionErrorBanner
        error={{ code: 'unauthorized', message: 'no token' }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText('해당 캐릭터에 대한 권한이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByText(/재인증/)).not.toBeInTheDocument()
  })

  it('renders a permission message for forbidden', () => {
    render(
      <SessionErrorBanner error={{ code: 'forbidden', message: 'nope' }} onDismiss={vi.fn()} />,
    )
    expect(screen.getByText(/권한/)).toBeInTheDocument()
  })

  it('renders the exact forbidden message distinct from the unauthorized message', () => {
    render(
      <SessionErrorBanner error={{ code: 'forbidden', message: 'nope' }} onDismiss={vi.fn()} />,
    )
    expect(screen.getByText('권한이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByText('해당 캐릭터에 대한 권한이 없습니다.')).not.toBeInTheDocument()
  })

  it('renders a retry message for session_state', () => {
    render(
      <SessionErrorBanner
        error={{ code: 'session_state', message: 'bad state' }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/다시/)).toBeInTheDocument()
  })

  it('renders a general message for other codes', () => {
    render(<SessionErrorBanner error={{ code: 'internal', message: 'boom' }} onDismiss={vi.fn()} />)
    expect(screen.getByText(/오류/)).toBeInTheDocument()
  })

  it('also shows the server-provided message', () => {
    render(
      <SessionErrorBanner
        error={{ code: 'forbidden', message: '접근 거부됨' }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/접근 거부됨/)).toBeInTheDocument()
  })

  it('renders a close button of type="button" inside the alert', () => {
    render(
      <SessionErrorBanner error={{ code: 'forbidden', message: 'nope' }} onDismiss={vi.fn()} />,
    )
    const button = screen.getByRole('button', { name: '닫기' })
    expect(button).toHaveAttribute('type', 'button')
    expect(screen.getByRole('alert')).toContainElement(button)
  })

  it('calls onDismiss once when the close button is clicked', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <SessionErrorBanner
        error={{ code: 'rule_rejected', message: '규칙 위반' }}
        onDismiss={onDismiss}
      />,
    )
    await user.click(screen.getByRole('button', { name: '닫기' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
