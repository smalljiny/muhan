// 이벤트 로그 한 행의 표시 문자열을 만드는 순수 함수.
// world:room은 방 스냅샷 전체가 실려 직렬화 비용·가독성이 모두 나쁘므로 `<방 이름> (#<roomId>)` 한 줄로
// 요약하고(직렬화하지 않는다), 그 밖의 타입은 원시 JSON을 그대로 돌려준다.
//
// combat:round도 직렬화하지 않고 `[전투] <몬스터 이름>` 뒤에 ` · `로 세그먼트를 이어 한 줄로 요약한다.
// 세그먼트 순서는 피격 → 반격 → 처치 → 사망이며, 해당 사항이 없는 세그먼트는 생략한다.
// - received: 근접 명중 `피격 <damage>`(치명타면 `피격 <damage> 치명`), 근접 빗맞음 `피격 빗나감`,
//   시전 `주문 <damage>`, null이면 생략. 몬스터의 근접 실수(fumble)는 빗맞음이므로 `피격 빗나감`으로 쓴다.
// - counter: 명중 `반격 <damage>`, 실수(fumble) `반격 불발`, 빗맞음 `반격 빗나감`, null이면 생략.
// - monsterDied면 `처치`, youDied면 `사망`.
// 방의 몬스터 목록은 이 이벤트로 고치지 않는다 — 방 상태의 출처는 world:room 스냅샷뿐이다(D12).
import type { ServerEvent } from 'shared/protocol'

type CombatRoundEvent = Extract<ServerEvent, { type: 'combat:round' }>

export function describeEvent(event: ServerEvent): string {
  if (event.type === 'world:room') {
    return `${event.name} (#${event.roomId})`
  }
  if (event.type === 'combat:round') {
    return describeCombatRound(event)
  }
  return JSON.stringify(event)
}

function describeCombatRound(event: CombatRoundEvent): string {
  const segments = [
    `[전투] ${event.creatureName}`,
    describeReceived(event.received),
    describeCounter(event.counter),
    event.monsterDied ? '처치' : null,
    event.youDied ? '사망' : null,
  ]
  return segments.filter((segment): segment is string => segment !== null).join(' · ')
}

function describeReceived(received: CombatRoundEvent['received']): string | null {
  if (received === null) return null
  if (received.kind === 'cast') return `주문 ${received.damage}`
  if (!received.hit) return '피격 빗나감'
  return received.critical ? `피격 ${received.damage} 치명` : `피격 ${received.damage}`
}

function describeCounter(counter: CombatRoundEvent['counter']): string | null {
  if (counter === null) return null
  if (counter.fumble) return '반격 불발'
  if (!counter.hit) return '반격 빗나감'
  return `반격 ${counter.damage}`
}
