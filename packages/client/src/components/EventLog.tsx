// 수신 ServerEvent를 수신 순서대로 표시하는 경량 로그 뷰. 각 항목을 원본(type + 직렬화 payload)으로
// 렌더한다. props 주입 방식 — WsClient를 직접 참조하지 않아 순수 렌더 테스트가 가능하다.
import type { ServerEvent } from 'shared/protocol'

export interface EventLogProps {
  events: readonly ServerEvent[]
}

export function EventLog({ events }: EventLogProps) {
  return (
    <ul aria-label="이벤트 로그">
      {events.map((event, index) => (
        <li key={index}>
          <span>{event.type}</span> <code>{JSON.stringify(event)}</code>
        </li>
      ))}
    </ul>
  )
}
