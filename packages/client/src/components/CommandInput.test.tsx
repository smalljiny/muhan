import { fireEvent, render, screen } from '@testing-library/react'
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

  describe('when disabled', () => {
    it('disables the submit button', () => {
      render(<CommandInput onSubmitEcho={vi.fn()} disabled />)

      expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled()
    })

    it('does not call onSubmitEcho when Enter is pressed', async () => {
      const user = userEvent.setup()
      const onSubmitEcho = vi.fn()
      render(<CommandInput onSubmitEcho={onSubmitEcho} disabled />)

      await user.type(screen.getByRole('textbox'), '봐{Enter}')

      expect(onSubmitEcho).not.toHaveBeenCalled()
    })

    it('does not call onSubmitEcho when the form submit event fires directly', async () => {
      // 비활성 버튼이 막는 암묵적 제출과 달리, 폼 submit 이벤트를 직접 발생시키면 handleSubmit의
      // disabled 가드만이 송신을 막는다.
      const user = userEvent.setup()
      const onSubmitEcho = vi.fn()
      render(<CommandInput onSubmitEcho={onSubmitEcho} disabled />)

      const input = screen.getByRole('textbox')
      await user.type(input, '봐')
      const form = input.closest('form')
      expect(form).not.toBeNull()
      fireEvent.submit(form as HTMLFormElement)

      expect(onSubmitEcho).not.toHaveBeenCalled()
    })
  })
})
