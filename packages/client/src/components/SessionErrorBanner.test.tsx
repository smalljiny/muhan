import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SessionErrorBanner } from './SessionErrorBanner'

describe('SessionErrorBanner', () => {
  it('renders nothing when error is null', () => {
    const { container } = render(<SessionErrorBanner error={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a re-authentication message for unauthorized', () => {
    render(<SessionErrorBanner error={{ code: 'unauthorized', message: 'no token' }} />)
    expect(screen.getByText(/재인증/)).toBeInTheDocument()
  })

  it('renders a permission message for forbidden', () => {
    render(<SessionErrorBanner error={{ code: 'forbidden', message: 'nope' }} />)
    expect(screen.getByText(/권한/)).toBeInTheDocument()
  })

  it('renders a retry message for session_state', () => {
    render(<SessionErrorBanner error={{ code: 'session_state', message: 'bad state' }} />)
    expect(screen.getByText(/다시/)).toBeInTheDocument()
  })

  it('renders a general message for other codes', () => {
    render(<SessionErrorBanner error={{ code: 'internal', message: 'boom' }} />)
    expect(screen.getByText(/오류/)).toBeInTheDocument()
  })

  it('also shows the server-provided message', () => {
    render(<SessionErrorBanner error={{ code: 'forbidden', message: '접근 거부됨' }} />)
    expect(screen.getByText(/접근 거부됨/)).toBeInTheDocument()
  })
})
