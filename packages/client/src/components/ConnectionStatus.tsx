// 현재 연결 상태를 표시하고 수동 재연결 버튼을 제공하는 경량 뷰. 버튼 클릭 시 주입된 onReconnect
// 콜백을 호출한다. 타입 이름 ConnectionStatus는 컴포넌트 이름과 충돌하므로 별칭으로 임포트한다.
import type { ConnectionStatus as ConnectionStatusValue } from '../transport/wsClient'

export interface ConnectionStatusProps {
  status: ConnectionStatusValue
  onReconnect: () => void
}

export function ConnectionStatus({ status, onReconnect }: ConnectionStatusProps) {
  return (
    <div>
      <span aria-label="연결 상태">{status}</span>
      <button type="button" onClick={onReconnect}>
        재연결
      </button>
    </div>
  )
}
