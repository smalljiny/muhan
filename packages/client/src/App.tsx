// 전송 셸 최상위 — WsClient를 유일하게 인스턴스화하고, 스냅샷을 useSyncExternalStore로 구독해
// 경량 컴포넌트에 데이터/콜백을 주입한다. socketFactory는 테스트 주입용 seam(미주입 시 실제 WebSocket).
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import { CharacterList } from './components/CharacterList'
import { CommandInput } from './components/CommandInput'
import { ConnectionStatus } from './components/ConnectionStatus'
import { EventLog } from './components/EventLog'
import { RoomPanel } from './components/RoomPanel'
import { SessionErrorBanner } from './components/SessionErrorBanner'
import { SessionPrompt } from './components/SessionPrompt'
import { WsClient, type SocketFactory } from './transport/wsClient'

// 게임 소켓 URL을 현재 페이지 origin에서 파생한다(하드코딩 host 금지). same-origin이라야 dev 로그인이
// 심은 `__session` 쿠키가 upgrade에 첨부된다 — dev는 Vite(5173)가 `/game`을 API 서버로 프록시하고,
// prod는 서빙 호스트가 직접 처리한다. WS URL의 origin이 쿠키 첨부 기준이므로 별도 host를 두면 401난다.
function gameSocketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/game`
}

export interface AppProps {
  socketFactory?: SocketFactory
}

export function App({ socketFactory }: AppProps = {}) {
  // 단일 WsClient 인스턴스를 마운트 동안 유지한다(렌더마다 재생성 금지).
  const clientRef = useRef<WsClient | null>(null)
  if (clientRef.current === null) {
    clientRef.current = new WsClient({ url: gameSocketUrl(), socketFactory })
  }
  const client = clientRef.current

  const subscribe = useCallback(
    (listener: () => void) => client.subscribe(listener),
    [client],
  )
  const getSnapshot = useCallback(() => client.getSnapshot(), [client])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  // 마운트 시 1회 연결, 언마운트 시 정리. StrictMode 이중 마운트에도 idempotent하다.
  useEffect(() => {
    client.connect()
    return () => client.disconnect()
  }, [client])

  const sendEcho = useCallback((text: string) => client.sendEcho(text), [client])
  const reconnect = useCallback(() => client.reconnect(), [client])
  const selectCharacter = useCallback(
    (characterId: string) => client.selectCharacter(characterId),
    [client],
  )
  const move = useCallback((direction: string) => client.move(direction), [client])

  const { phase, characterList, activePrompt, lastError } = snapshot.session

  // activePrompt 존재 시에만 렌더되므로 promptId는 non-null이다. 클로저는 렌더 시점 스냅샷의
  // promptId를 캡처한다(값 가공 없이 그대로 전달 — sentinel·confirm 하드코딩 없음).
  function renderPrompt(prompt: NonNullable<typeof activePrompt>) {
    const reply = (value: string) => client.replyPrompt(prompt.promptId, value)
    return (
      <SessionPrompt prompt={prompt} onSelectOption={reply} onSubmitText={reply} />
    )
  }

  function renderPhase() {
    switch (phase) {
      case 'selecting':
        return (
          <>
            <CharacterList characters={characterList} onSelect={selectCharacter} />
            {activePrompt !== null && renderPrompt(activePrompt)}
          </>
        )
      case 'creating':
        return activePrompt !== null ? renderPrompt(activePrompt) : null
      case 'entered':
      case 'resumed':
        return (
          <>
            {phase === 'resumed' && <p>재접속됨</p>}
            {/* 서버가 미해소 방에서 발화를 생략하므로 room === null 구간이 존재한다(스펙 §3.4).
                여기가 스냅샷의 두 서브트리(최상위 room + session.characterId)를 조인하는 첫 지점이다.
                서버는 방 단위 fan-out 캐시를 유지하려고 수신자와 무관한 같은 페이로드를 보내며
                occupants에 **본인을 포함**한다 — 제외는 소비자 책임이다(스펙 §4). 방 점유자를 쓰는
                후속 소비자(#116 델타 통지·#62 소셜)도 같은 규약을 적용해야 한다.
                RoomPanel 위에 렌더한다 — 이동 후 새 방이 이벤트 로그 위에서 바로 보여야 한다. */}
            {snapshot.room !== null && (
              <RoomPanel
                room={snapshot.room}
                selfCharacterId={snapshot.session.characterId}
                onMove={move}
              />
            )}
            <EventLog events={snapshot.events} />
            <CommandInput onSubmitEcho={sendEcho} />
          </>
        )
      default:
        return <p>연결 중…</p>
    }
  }

  return (
    <main>
      <h1>무한</h1>
      <ConnectionStatus status={snapshot.status} onReconnect={reconnect} />
      <SessionErrorBanner error={lastError} />
      {renderPhase()}
    </main>
  )
}
