import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CharacterSummary } from 'shared/protocol'

import { CharacterCard, CharacterList } from './CharacterList'

const alice: CharacterSummary = {
  characterId: 'c-1',
  name: '앨리스',
  class: 3,
  race: 7,
  level: 12,
}

const bob: CharacterSummary = {
  characterId: 'c-2',
  name: '밥',
  class: 1,
  race: 2,
  level: 5,
}

describe('CharacterCard', () => {
  it('renders name, level, class and race as raw integers', () => {
    render(<CharacterCard character={alice} onSelect={vi.fn()} />)

    expect(screen.getByText(/앨리스/)).toBeInTheDocument()
    expect(screen.getByText(/12/)).toBeInTheDocument()
    expect(screen.getByText(/3/)).toBeInTheDocument()
    expect(screen.getByText(/7/)).toBeInTheDocument()
  })

  it('calls onSelect with the characterId when the select button is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<CharacterCard character={alice} onSelect={onSelect} />)

    await user.click(screen.getByRole('button'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('c-1')
  })
})

describe('CharacterList', () => {
  it('renders a card for each character', () => {
    render(<CharacterList characters={[alice, bob]} onSelect={vi.fn()} />)

    expect(screen.getByText(/앨리스/)).toBeInTheDocument()
    expect(screen.getByText(/밥/)).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('forwards the selected characterId through onSelect', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<CharacterList characters={[alice, bob]} onSelect={onSelect} />)

    const buttons = screen.getAllByRole('button')
    await user.click(buttons[1]!)

    expect(onSelect).toHaveBeenCalledWith('c-2')
  })

  it('renders an empty state when there are no characters', () => {
    render(<CharacterList characters={[]} onSelect={vi.fn()} />)

    expect(screen.getByText('캐릭터가 없습니다')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
