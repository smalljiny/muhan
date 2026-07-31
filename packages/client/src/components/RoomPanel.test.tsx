import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeRoom } from '../test/roomFixtures.testutil'
import { RoomPanel } from './RoomPanel'

// 방 픽스처는 test/roomFixtures.testutil의 makeRoom을 그대로 쓴다 — 전송 계층 테스트와 같은
// 정의를 공유해야 계약이 갈라지지 않는다(리터럴 사본을 새로 만들지 않는다).

describe('RoomPanel', () => {
  it('renders the room name, description, exits, people, items and creatures', () => {
    render(<RoomPanel room={makeRoom()} selfCharacterId={null} onMove={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '무한의 광장' })).toBeInTheDocument()
    expect(screen.getByText('넓은 광장이 펼쳐져 있다.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '북' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '동' })).toBeInTheDocument()
    expect(within(screen.getByLabelText('사람')).getByText('타이')).toBeInTheDocument()
    expect(within(screen.getByLabelText('사물')).getByText('단검')).toBeInTheDocument()

    const creatures = within(screen.getByLabelText('몬스터'))
    expect(creatures.getByText('들쥐')).toBeInTheDocument()
    expect(creatures.getByText('Lv.2')).toBeInTheDocument()
  })

  it('falls back to 이름 없는 곳 when the room name is empty (OQ2)', () => {
    render(<RoomPanel room={makeRoom({ name: '' })} selfCharacterId={null} onMove={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '이름 없는 곳' })).toBeInTheDocument()
  })

  it('falls back to 설명이 없다. when the long description is empty (OQ2\')', () => {
    render(<RoomPanel room={makeRoom({ longDesc: '' })} selfCharacterId={null} onMove={vi.fn()} />)

    expect(screen.getByText('설명이 없다.')).toBeInTheDocument()
  })

  const TWO_OCCUPANTS = [
    { characterId: 'c1', name: '타이' },
    { characterId: 'c2', name: '테스토스' },
  ]

  it.each([
    { selfCharacterId: null, expected: ['타이', '테스토스'] },
    { selfCharacterId: 'c1', expected: ['테스토스'] },
  ])('lists occupants minus self (selfCharacterId=$selfCharacterId)', ({ selfCharacterId, expected }) => {
    render(
      <RoomPanel room={makeRoom({ occupants: TWO_OCCUPANTS })} selfCharacterId={selfCharacterId} onMove={vi.fn()} />,
    )
    const names = within(screen.getByLabelText('사람'))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(names).toEqual(expected)
  })

  it('omits the people section entirely when self-exclusion empties it', () => {
    // makeRoom()의 점유자는 c1 하나뿐이라 본인 제외 후 0명이 된다 — 빈 목록이 아니라 섹션 자체가 없어야 한다.
    render(<RoomPanel room={makeRoom()} selfCharacterId="c1" onMove={vi.fn()} />)

    expect(screen.queryByLabelText('사람')).not.toBeInTheDocument()
    expect(screen.queryByText('타이')).not.toBeInTheDocument()
  })

  it('omits the items and creatures sections when those lists are empty', () => {
    render(
      <RoomPanel
        room={makeRoom({ items: [], creatures: [] })}
        selfCharacterId={null}
        onMove={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('사물')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('몬스터')).not.toBeInTheDocument()
  })

  it('calls onMove with the exit name verbatim when an exit button is clicked', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    render(<RoomPanel room={makeRoom()} selfCharacterId={null} onMove={onMove} />)

    await user.click(screen.getByRole('button', { name: '동' }))

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith('동')
  })

  it('labels exit buttons with the exit name only — no lock or door state (OQ3)', () => {
    render(<RoomPanel room={makeRoom()} selfCharacterId={null} onMove={vi.fn()} />)

    const labels = within(screen.getByLabelText('출구'))
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['북', '동'])
  })

  it('renders a no-exit notice instead of the exit section when exits are empty', () => {
    render(<RoomPanel room={makeRoom({ exits: [] })} selfCharacterId={null} onMove={vi.fn()} />)

    expect(screen.getByText('나갈 곳이 없다.')).toBeInTheDocument()
    expect(screen.queryByLabelText('출구')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('renders a hostile occupant name as text without creating an element from it', () => {
    const payload = '<script>alert(1)</script>'
    const room = makeRoom({ occupants: [{ characterId: 'c2', name: payload }] })
    const { container } = render(
      <RoomPanel room={room} selfCharacterId="c1" onMove={vi.fn()} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText(payload)).toBeInTheDocument()
  })
})
