import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PromptOption } from 'shared/protocol'

import { SessionPrompt } from './SessionPrompt'

const selectOptions: readonly PromptOption[] = [
  { value: 'c-1', label: '앨리스 (Lv.12)' },
  { value: 'create', label: '새 캐릭터 만들기' },
]

describe('SessionPrompt with options', () => {
  it('renders a button per option label', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'select', kind: 'selectCharacter', options: selectOptions }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '앨리스 (Lv.12)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '새 캐릭터 만들기' })).toBeInTheDocument()
  })

  it('calls onSelectOption with the raw option.value when a label button is clicked', async () => {
    const user = userEvent.setup()
    const onSelectOption = vi.fn()
    render(
      <SessionPrompt
        prompt={{ promptId: 'select', kind: 'selectCharacter', options: selectOptions }}
        onSelectOption={onSelectOption}
        onSubmitText={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '새 캐릭터 만들기' }))

    expect(onSelectOption).toHaveBeenCalledTimes(1)
    expect(onSelectOption).toHaveBeenCalledWith('create')
  })
})

describe('SessionPrompt without options (text entry)', () => {
  it('renders a text input and submits typed text', async () => {
    const user = userEvent.setup()
    const onSubmitText = vi.fn()
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:name', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={onSubmitText}
      />,
    )

    await user.type(screen.getByRole('textbox'), '테스토스')
    await user.click(screen.getByRole('button'))

    expect(onSubmitText).toHaveBeenCalledTimes(1)
    expect(onSubmitText).toHaveBeenCalledWith('테스토스')
  })

  it('does not submit an empty value', async () => {
    const user = userEvent.setup()
    const onSubmitText = vi.fn()
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:name', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={onSubmitText}
      />,
    )

    await user.click(screen.getByRole('button'))

    expect(onSubmitText).not.toHaveBeenCalled()
  })
})

describe('SessionPrompt createField step guidance', () => {
  it('shows name guidance for create:name', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:name', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )
    expect(screen.getByText(/이름/)).toBeInTheDocument()
  })

  it('shows class guidance for create:class', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:class', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )
    expect(screen.getByText(/클래스/)).toBeInTheDocument()
  })

  it('shows race guidance for create:race', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:race', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )
    expect(screen.getByText(/종족/)).toBeInTheDocument()
  })

  it('shows confirm guidance including the required value yes for create:confirm', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:confirm', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )
    expect(screen.getByText(/yes/)).toBeInTheDocument()
  })

  it('falls back to a general guidance for an unknown promptId', () => {
    render(
      <SessionPrompt
        prompt={{ promptId: 'create:unknown', kind: 'createField' }}
        onSelectOption={vi.fn()}
        onSubmitText={vi.fn()}
      />,
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByText(/입력/)).toBeInTheDocument()
  })
})
