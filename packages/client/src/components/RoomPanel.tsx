// 현재 방을 렌더하는 순수 컴포넌트 — 이름·설명·출구 버튼·사람·사물·몬스터. WsClient를 참조하지 않고
// prop 주입만으로 동작한다(CharacterList 관례).
//
// 표시 안전: 서버발 문자열(name·longDesc·occupants[].name·items[].name·creatures[].name)은 전부 React
// 텍스트 노드로만 렌더한다. occupants[].name은 플레이어가 캐릭터 생성 시 정한 사용자 입력이라 신뢰 경계
// 밖이고, 나머지도 1993년 월드 데이터에서 온 문자열이라 같은 규칙을 적용한다(스펙 §3.3).
//
// 본인 제외는 클라 책임이다 — 서버는 방 단위 fan-out 캐시를 유지하려고 수신자와 무관한 같은 페이로드를
// 보내며 occupants에 본인을 포함시킨다(스펙 §4).
import type { RoomState } from '../transport/wsClient'

/** 빈 방 이름·설명 대체 문구. 서버가 채우면 월드 데이터를 오염시키므로 표시 계층이 소유한다(OQ2·OQ2'). */
const UNNAMED_ROOM = '이름 없는 곳'
const NO_DESCRIPTION = '설명이 없다.'

/**
 * 가시 출구가 0개인 방의 정식 카피 — 데이터 결손 대체가 아니다(위 두 상수와 범주가 다르다).
 * 빈 `exits` 배열은 그 자체로 정확한 표현이라 서버가 채울 성질이 아니고, OQ2 결정 범위 밖이다.
 */
const NO_EXIT = '나갈 곳이 없다.'

export interface RoomPanelProps {
  room: RoomState
  /** 본인 캐릭터 id — 사람 목록에서 제외할 대상. 진입 전(null)이면 아무도 제외하지 않는다. */
  selfCharacterId: string | null
  /** 출구 이름을 가공 없이 그대로 받는다 — world:move.direction은 출구명과 정확히 일치하는 최종 문자열이다. */
  onMove: (direction: string) => void
}

export function RoomPanel({ room, selfCharacterId, onMove }: RoomPanelProps) {
  // 필터 결과의 길이로 분기한다 — 원본 occupants 길이로 판정하면 본인만 있던 방에서 빈 목록이 남는다.
  const others = room.occupants.filter((occupant) => occupant.characterId !== selfCharacterId)

  return (
    <section aria-label="방">
      <h2>{room.name === '' ? UNNAMED_ROOM : room.name}</h2>
      <p>{room.longDesc === '' ? NO_DESCRIPTION : room.longDesc}</p>

      {room.exits.length === 0 ? (
        <p>{NO_EXIT}</p>
      ) : (
        <ul aria-label="출구">
          {room.exits.map((exit) => (
            <li key={exit}>
              <button type="button" onClick={() => onMove(exit)}>
                {exit}
              </button>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <ul aria-label="사람">
          {others.map((occupant) => (
            <li key={occupant.characterId}>
              <span>{occupant.name}</span>
            </li>
          ))}
        </ul>
      )}

      {room.items.length > 0 && (
        <ul aria-label="사물">
          {room.items.map((item) => (
            <li key={item.instanceId}>
              <span>{item.name}</span>
            </li>
          ))}
        </ul>
      )}

      {room.creatures.length > 0 && (
        <ul aria-label="몬스터">
          {room.creatures.map((creature) => (
            <li key={creature.instanceId}>
              <span>{creature.name}</span> <span>Lv.{creature.level}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
