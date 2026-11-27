// 이벤트 로그 한 행의 표시 문자열을 만드는 순수 함수.
// world:room은 방 스냅샷 전체가 실려 직렬화 비용·가독성이 모두 나쁘므로 `<방 이름> (#<roomId>)` 한 줄로
// 요약하고(직렬화하지 않는다), 그 밖의 타입은 원시 JSON을 그대로 돌려준다.
import type { ServerEvent } from 'shared/protocol'

export function describeEvent(event: ServerEvent): string {
  if (event.type === 'world:room') {
    return `${event.name} (#${event.roomId})`
  }
  return JSON.stringify(event)
}
