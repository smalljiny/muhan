// 수신 ServerEvent를 수신 순서대로 표시하는 경량 로그 뷰. props 주입 방식 — WsClient를 직접 참조하지 않아
// 순수 렌더 테스트가 가능하다.
// - 기록은 WsClient가 최근 EVENT_LOG_LIMIT건으로 상한을 둔 LoggedEvent 배열이다.
// - 행 키는 WsClient가 매긴 seq다 — 상한으로 앞 항목이 빠져도 남은 행의 키가 유지된다.
// - 각 행은 메모된 EventLogRow이고 표시 문자열은 useMemo로 계산한다. 같은 마운트에서 유지되는 행은 새
//   이벤트가 덧붙어도 다시 직렬화하지 않는다. App의 entered/resumed 분기를 벗어났다가 돌아와 다시
//   마운트되는 경우는 이 보장 밖이다(전 행을 한 번 다시 계산한다).
// - 표시 문자열 규칙(world:room 요약 등)은 describeEvent를 따른다.
import { memo, useMemo } from 'react'
import type { ServerEvent } from 'shared'

import type { LoggedEvent } from '../transport/wsClient'
import { describeEvent } from './describeEvent'

export interface EventLogProps {
  events: readonly LoggedEvent[]
}

const EventLogRow = memo(function EventLogRow({ event }: { event: ServerEvent }) {
  const text = useMemo(() => describeEvent(event), [event])
  return (
    <li>
      <span>{event.type}</span> <code>{text}</code>
    </li>
  )
})

export function EventLog({ events }: EventLogProps) {
  return (
    <ul aria-label="이벤트 로그">
      {events.map(({ seq, event }) => (
        <EventLogRow key={seq} event={event} />
      ))}
    </ul>
  )
}
