import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PROTOCOL_VERSION } from 'shared'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { App } from './App'
import { makeEmptyRoom, makeRoom, roomEvent } from './test/roomFixtures.testutil'
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

// 단일 ServerEvent를 소켓 onmessage로 발생시킨다. WsClient는 수신 프레임을 문자열로 기대한다.
function emit(socket: SocketLike, event: unknown): void {
  act(() =>
    socket.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    ),
  )
}

const CHARACTER = { characterId: 'c1', name: '용사', class: 1, race: 1, level: 5 }

// send.mock.calls에서 주어진 type의 프레임을 찾아 반환한다. 못 찾으면 즉시 실패시킨다.
function sentFrame(send: Mock<(data: string) => void>, type: string): string {
  const frame = send.mock.calls.map((call) => call[0]).find((f) => f.includes(`"type":"${type}"`))
  expect(frame).toBeDefined()
  return frame as string
}

// 소켓을 open→hello→characterList→prompt(selectCharacter)까지 몰아 phase='selecting'에 도달시킨다.
function driveToSelecting(socket: SocketLike): void {
  act(() => socket.onopen?.(new Event('open')))
  emit(socket, { type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
  emit(socket, { type: 'session:characterList', characters: [CHARACTER] })
  emit(socket, {
    type: 'session:prompt',
    promptId: 'session:select-character',
    kind: 'selectCharacter',
    options: [{ value: 'create', label: '새 캐릭터 생성' }],
  })
}

// selecting을 지나 session:entered까지 몰아 phase='entered'(기존 셸)에 도달시킨다.
function driveToEntered(socket: SocketLike): void {
  driveToSelecting(socket)
  emit(socket, { type: 'session:entered', characterId: 'c1' })
}

// open→hello→session:resumed까지 몰아 phase='entered'(재접속 경로)에 도달시킨다.
function driveToResumed(socket: SocketLike): void {
  act(() => socket.onopen?.(new Event('open')))
  emit(socket, { type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
  emit(socket, { type: 'session:resumed', characterId: 'c1' })
}

// open→hello→prompt(createField)까지 몰아 phase='creating'(텍스트 입력)에 도달시킨다.
function driveToCreating(socket: SocketLike): void {
  act(() => socket.onopen?.(new Event('open')))
  emit(socket, { type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
  emit(socket, {
    type: 'session:prompt',
    promptId: 'create:name',
    kind: 'createField',
  })
}

describe('App', () => {
  it('renders the placeholder heading', () => {
    render(<App socketFactory={() => makeFakeSocket()} />)
    expect(screen.getByRole('heading', { name: '무한' })).toBeInTheDocument()
  })

  it('renders the connecting placeholder before entering a session (phase=connecting)', () => {
    render(<App socketFactory={() => makeFakeSocket()} />)

    // 초기 phase='connecting'에서는 진입 대기 안내만 렌더되고 셸은 아직 없다.
    expect(screen.getByText('연결 중…')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '이벤트 로그' })).not.toBeInTheDocument()
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

  it('keeps the connection status and reconnect button across phase branches', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    // phase='connecting' 초기 화면에도 연결 상태·재연결이 상단에 있다.
    expect(screen.getByLabelText('연결 상태')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '재연결' })).toBeInTheDocument()

    // 진입 완료 후에도 phase 분기와 무관하게 상단에 유지된다.
    driveToEntered(socket)
    expect(screen.getByLabelText('연결 상태')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '재연결' })).toBeInTheDocument()
  })

  it('reflects the connection status on socket open', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    // 소켓 open → status 스냅샷 변경이 구독을 통해 재렌더로 흐른다(phase는 아직 connecting).
    act(() => socket.onopen?.(new Event('open')))
    expect(screen.getByLabelText('연결 상태')).toHaveTextContent('connected')
  })

  it('renders the entered shell (EventLog + CommandInput) after driving to entered', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)

    expect(screen.getByRole('list', { name: '이벤트 로그' })).toBeInTheDocument()
    expect(screen.getByLabelText('명령')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '보내기' })).toBeInTheDocument()
  })

  it('reflects received events in the EventLog once entered', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, { type: 'debug:echo:result', text: '퐁' })

    // 진입 시퀀스가 여러 이벤트를 쌓으므로 마지막 항목이 echo 결과인지 확인한다.
    const items = screen.getAllByRole('listitem')
    expect(items[items.length - 1]).toHaveTextContent('퐁')
  })

  it('sends a debug:echo frame when a command is submitted in the entered shell', async () => {
    const user = userEvent.setup()
    const send = vi.fn<(data: string) => void>()
    const socket: SocketLike = { ...makeFakeSocket(), send }
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)

    await user.type(screen.getByLabelText('명령'), '핑')
    await user.click(screen.getByRole('button', { name: '보내기' }))

    expect(sentFrame(send, 'debug:echo')).toContain('핑')
  })

  it('renders the resumed shell on session:resumed', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToResumed(socket)

    expect(screen.getByRole('list', { name: '이벤트 로그' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '보내기' })).toBeInTheDocument()
    expect(screen.getByText('재접속됨')).toBeInTheDocument()
  })

  it('renders CharacterList and select prompt during phase=selecting', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToSelecting(socket)

    expect(screen.getByLabelText('캐릭터 목록')).toBeInTheDocument()
    expect(screen.getByText('용사')).toBeInTheDocument()
    // select prompt의 option 라벨 버튼이 렌더된다.
    expect(screen.getByRole('button', { name: '새 캐릭터 생성' })).toBeInTheDocument()
    // 진입 전이라 셸(CommandInput)은 렌더되지 않는다.
    expect(screen.queryByRole('button', { name: '보내기' })).not.toBeInTheDocument()
  })

  it('sends a session:selectCharacter frame when a character card is selected', async () => {
    const user = userEvent.setup()
    const send = vi.fn<(data: string) => void>()
    const socket: SocketLike = { ...makeFakeSocket(), send }
    render(<App socketFactory={() => socket} />)

    driveToSelecting(socket)
    await user.click(screen.getByRole('button', { name: '선택' }))

    expect(sentFrame(send, 'session:selectCharacter')).toContain('"characterId":"c1"')
  })

  it('renders a text SessionPrompt during phase=creating', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToCreating(socket)

    expect(screen.getByRole('button', { name: '확인' })).toBeInTheDocument()
    // 선택 화면이 아니므로 CharacterList는 렌더되지 않는다.
    expect(screen.queryByLabelText('캐릭터 목록')).not.toBeInTheDocument()
  })

  it('sends a session:reply frame when the creating prompt is submitted', async () => {
    const user = userEvent.setup()
    const send = vi.fn<(data: string) => void>()
    const socket: SocketLike = { ...makeFakeSocket(), send }
    render(<App socketFactory={() => socket} />)

    driveToCreating(socket)

    await user.type(screen.getByRole('textbox'), '아무개')
    await user.click(screen.getByRole('button', { name: '확인' }))

    const frame = sentFrame(send, 'session:reply')
    expect(frame).toContain('"promptId":"create:name"')
    expect(frame).toContain('아무개')
  })

  it('renders the SessionErrorBanner when the session carries a lastError', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToSelecting(socket)
    emit(socket, {
      type: 'error',
      code: 'session_state',
      message: '잘못된 상태입니다',
    })

    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveTextContent('잘못된 상태입니다')
    // 배너가 분기 콘텐츠(캐릭터 목록)와 공존한다.
    expect(screen.getByLabelText('캐릭터 목록')).toBeInTheDocument()
  })

  // 배너 닫기 — 닫기 버튼이 App의 dismissError 연결을 거쳐 transient·sticky 오류를 모두 지운다.
  it('dismisses a transient error banner when the close button is clicked', async () => {
    const user = userEvent.setup()
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, { type: 'error', code: 'rule_rejected', message: '길이 막혔습니다' })
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '닫기' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dismisses a sticky unauthorized error banner when the close button is clicked', async () => {
    const user = userEvent.setup()
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToSelecting(socket)
    emit(socket, { type: 'error', code: 'unauthorized', message: '권한 없음' })
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '닫기' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a transient error banner when a world:room frame arrives', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, { type: 'error', code: 'rule_rejected', message: '길이 막혔습니다' })
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // 성공 이벤트에 의한 자동 해제가 스냅샷을 거쳐 화면까지 도달하는지 확인한다.
    emit(socket, roomEvent(makeRoom()))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // 방 패널 연결 — 소켓에서 온 world:room이 스냅샷을 거쳐 화면에 도달하는 전 구간을 통합으로 확인한다.
  // 방 내용 단정은 방 섹션 안으로 범위를 좁힌다(EventLog가 방 이름을 요약 줄로도 렌더한다).
  it('renders the room panel after a world:room frame arrives in the entered shell', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, roomEvent(makeRoom()))

    const panel = within(screen.getByLabelText('방'))
    expect(panel.getByRole('heading', { name: '무한의 광장' })).toBeInTheDocument()
    // 진입 시퀀스의 본인(c1)은 사람 목록에서 빠지고, 목록이 비므로 섹션 자체가 없다.
    // selfCharacterId 연결을 잡는 유일한 단정 — RoomPanel 자체 내용 검증은 RoomPanel.test.tsx가 담당한다.
    expect(panel.queryByLabelText('사람')).not.toBeInTheDocument()
  })

  it('summarizes a world:room frame as one line in the event log', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, roomEvent(makeRoom()))

    const log = within(screen.getByRole('list', { name: '이벤트 로그' }))
    expect(log.getByText('무한의 광장 (#1)')).toBeInTheDocument()
  })

  it('places the room panel above the event log', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, roomEvent(makeRoom()))

    // 방 패널이 먼저 와야 이동 후 새 방이 로그 위에서 바로 보인다(플랜 T4.4).
    // DOCUMENT_POSITION_FOLLOWING = 방 패널 기준으로 로그가 뒤에 있다.
    const position = screen
      .getByLabelText('방')
      .compareDocumentPosition(screen.getByRole('list', { name: '이벤트 로그' }))
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('sends a world:move frame with the exit name when an exit button is clicked', async () => {
    const user = userEvent.setup()
    const send = vi.fn<(data: string) => void>()
    const socket: SocketLike = { ...makeFakeSocket(), send }
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, roomEvent(makeRoom()))
    // 첫 출구('북')가 아니라 두 번째('동')를 눌러 exits[0] 하드코딩 연결을 배제한다.
    await user.click(screen.getByRole('button', { name: '동' }))

    expect(sentFrame(send, 'world:move')).toContain('"direction":"동"')
  })

  it('replaces the room panel content when a later world:room frame arrives', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToEntered(socket)
    emit(socket, roomEvent(makeRoom()))
    emit(socket, roomEvent(makeEmptyRoom()))

    const panel = within(screen.getByLabelText('방'))
    expect(panel.getByRole('heading', { name: '좁은 골목' })).toBeInTheDocument()
    expect(panel.queryByRole('heading', { name: '무한의 광장' })).not.toBeInTheDocument()
    // 갱신은 델타가 아니라 교체다 — 이전 방의 출구·사물이 남지 않는다.
    expect(panel.getByRole('button', { name: '남' })).toBeInTheDocument()
    expect(panel.queryByRole('button', { name: '북' })).not.toBeInTheDocument()
    expect(panel.queryByLabelText('사물')).not.toBeInTheDocument()
  })

  it('renders the room panel on the resumed path as well', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    driveToResumed(socket)
    emit(socket, roomEvent(makeRoom()))

    expect(screen.getByText('재접속됨')).toBeInTheDocument()
    const panel = within(screen.getByLabelText('방'))
    expect(panel.getByRole('heading', { name: '무한의 광장' })).toBeInTheDocument()
  })

  it('omits the room panel while no room has been received yet (room === null)', () => {
    const socket = makeFakeSocket()
    render(<App socketFactory={() => socket} />)

    // 서버는 해석되지 않은 방에서 world:room 발생을 생략한다(스펙 §3.4) — 그 구간에도 셸은 정상이어야 한다.
    driveToEntered(socket)

    expect(screen.queryByLabelText('방')).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: '이벤트 로그' })).toBeInTheDocument()
    expect(screen.getByLabelText('명령')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '보내기' })).toBeInTheDocument()
  })

  // 미연결 차단 — status !== 'ready'이면 출구·보내기가 비활성이고, ready 재도달 시 다시 열린다(스펙 §3.5).
  describe('controls disabled while status is not ready', () => {
    function expectControlsDisabled(disabled: boolean): void {
      const controls = [
        screen.getByRole('button', { name: '북' }),
        screen.getByRole('button', { name: '동' }),
        screen.getByRole('button', { name: '보내기' }),
      ]
      for (const control of controls) {
        if (disabled) expect(control).toBeDisabled()
        else expect(control).toBeEnabled()
      }
    }

    it('disables exits and the submit button when the socket closes in the entered shell', () => {
      const socket = makeFakeSocket()
      render(<App socketFactory={() => socket} />)

      driveToEntered(socket)
      emit(socket, roomEvent(makeRoom()))
      expectControlsDisabled(false)

      act(() => socket.onclose?.(new CloseEvent('close')))

      // phase는 entered 그대로라 셸·방 패널이 남는다. WsClient가 소켓 참조를 이미 비우므로
      // 이 구간의 송신 부재 단정은 UI 차단을 검증하지 못한다 — disabled만 단정한다.
      expect(screen.getByLabelText('방')).toBeInTheDocument()
      expectControlsDisabled(true)
    })

    it('blocks sends on a reconnected socket before hello and re-enables after resume', async () => {
      const user = userEvent.setup()
      const first = makeFakeSocket()
      const second = makeFakeSocket()
      const factory = vi
        .fn<() => SocketLike>()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second)
      render(<App socketFactory={factory} />)

      driveToEntered(first)
      emit(first, roomEvent(makeRoom()))
      expectControlsDisabled(false)

      await user.click(screen.getByRole('button', { name: '재연결' }))
      expect(factory).toHaveBeenCalledTimes(2)

      // (a) 새 소켓 open 직후·hello 전 — status는 connected, phase는 entered 그대로라 셸이 렌더된다.
      act(() => second.onopen?.(new Event('open')))
      expect(screen.getByLabelText('연결 상태')).toHaveTextContent('connected')
      expect(screen.getByLabelText('방')).toBeInTheDocument()
      expectControlsDisabled(true)

      // 열린 소켓이 있으므로 UI 차단만이 송신을 막는다.
      await user.click(screen.getByRole('button', { name: '북' }))
      const input = screen.getByLabelText('명령')
      await user.type(input, '봐')
      const form = input.closest('form')
      expect(form).not.toBeNull()
      fireEvent.submit(form as HTMLFormElement)

      const sentFrames = vi.mocked(second.send).mock.calls.map((call) => call[0])
      expect(sentFrames.some((f) => f.includes('"type":"world:move"'))).toBe(false)
      expect(sentFrames.some((f) => f.includes('"type":"debug:echo"'))).toBe(false)

      // (b) system:hello 수신 — phase가 negotiating으로 바뀌어 방 패널·명령 폼이 언마운트된다.
      emit(second, { type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
      expect(screen.queryByRole('button', { name: '북' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '동' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '보내기' })).not.toBeInTheDocument()

      // (c) session:resumed → world:room — ready 재도달로 출구·보내기가 다시 활성이다.
      emit(second, { type: 'session:resumed', characterId: 'c1' })
      emit(second, roomEvent(makeRoom()))
      expectControlsDisabled(false)

      // 재활성화된 출구가 새 소켓으로 world:move를 실제로 보낸다.
      await user.click(screen.getByRole('button', { name: '북' }))
      sentFrame(vi.mocked(second.send), 'world:move')
    })
  })
})
