import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CommandInput } from './CommandInput'

describe('CommandInput', () => {
  it('calls onSubmitEcho with the typed text on submit', async () => {
    const user = userEvent.setup()
    const onSubmitEcho = vi.fn()
    render(<CommandInput onSubmitEcho={onSubmitEcho} />)

    await user.type(screen.getByRole('textbox'), '안녕')
    await user.click(screen.getByRole('button', { name: '보내기' }))

    expect(onSubmitEcho).toHaveBeenCalledTimes(1)
    expect(onSubmitEcho).toHaveBeenCalledWith('안녕')
  })

  it('clears the input after a successful submit', async () => {
    const user = userEvent.setup()
    render(<CommandInput onSubmitEcho={vi.fn()} />)

    const input = screen.getByRole('textbox')
    await user.type(input, '반향')
    await user.click(screen.getByRole('button', { name: '보내기' }))

    expect(input).toHaveValue('')
  })

  it('submits via Enter key inside the field', async () => {
    const user = userEvent.setup()
    const onSubmitEcho = vi.fn()
    render(<CommandInput onSubmitEcho={onSubmitEcho} />)

    await user.type(screen.getByRole('textbox'), '엔터{Enter}')

    expect(onSubmitEcho).toHaveBeenCalledWith('엔터')
  })

  it('does not call onSubmitEcho when the input is empty', async () => {
    const user = userEvent.setup()
    const onSubmitEcho = vi.fn()
    render(<CommandInput onSubmitEcho={onSubmitEcho} />)

    await user.click(screen.getByRole('button', { name: '보내기' }))

    expect(onSubmitEcho).not.toHaveBeenCalled()
  })
})
