// 전송 셸 최상위 — WsClient를 유일하게 인스턴스화하고, 스냅샷을 useSyncExternalStore로 구독해
// 경량 컴포넌트에 데이터/콜백을 주입한다. socketFactory는 테스트 주입용 seam(미주입 시 실제 WebSocket).
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import { CommandInput } from './components/CommandInput'
import { ConnectionStatus } from './components/ConnectionStatus'
import { EventLog } from './components/EventLog'
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

  return (
    <main>
      <h1>무한</h1>
      <ConnectionStatus status={snapshot.status} onReconnect={reconnect} />
      <EventLog events={snapshot.events} />
      <CommandInput onSubmitEcho={sendEcho} />
    </main>
  )
}
