import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { App } from './App'
import type { SocketLike } from './transport/wsClient'

function makeFakeSocket(): SocketLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  }
}

describe('App', () => {
  it('renders the placeholder heading', () => {
    render(<App socketFactory={() => makeFakeSocket()} />)
    expect(screen.getByRole('heading', { name: '무한' })).toBeInTheDocument()
  })

  it('renders the transport UI panels', () => {
    render(<App socketFactory={() => makeFakeSocket()} />)

    expect(screen.getByLabelText('연결 상태')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '이벤트 로그' })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('connects the client on mount via the injected socket factory', () => {
    const factory = vi.fn(() => makeFakeSocket())
    render(<App socketFactory={factory} />)

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reconnects the client when the reconnect button is clicked', async () => {
    const user = userEvent.setup()
    const factory = vi.fn(() => makeFakeSocket())
    render(<App socketFactory={factory} />)

    await user.click(screen.getByRole('button', { name: '재연결' }))

    // reconnect() = disconnect() + connect() → factory invoked a second time
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('reflects client snapshot changes in the UI via useSyncExternalStore', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    // 소켓 open → status 스냅샷 변경이 구독을 통해 재렌더로 흐른다.
    act(() => socket.onopen?.(new Event('open')))
    expect(screen.getByLabelText('연결 상태')).toHaveTextContent('connected')

    // 수신 이벤트 → events 스냅샷 변경이 EventLog에 반영된다.
    act(() =>
      socket.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'debug:echo:result', text: '퐁' }),
        }),
      ),
    )
    expect(screen.getByRole('listitem')).toHaveTextContent('퐁')
  })

  it('sends a debug:echo frame when a command is submitted', async () => {
    const user = userEvent.setup()
    const send = vi.fn<(data: string) => void>()
    const socket: SocketLike = { ...makeFakeSocket(), send }
    render(<App socketFactory={() => socket} />)

    await user.type(screen.getByRole('textbox'), '핑')
    await user.click(screen.getByRole('button', { name: '보내기' }))

    expect(send).toHaveBeenCalledTimes(1)
    const frame = send.mock.calls[0]?.[0] ?? ''
    expect(frame).toContain('"type":"debug:echo"')
    expect(frame).toContain('핑')
  })
})
