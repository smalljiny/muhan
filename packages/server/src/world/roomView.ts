import type { RoomNode } from 'shared'
import { hasFlag, XSECRT, XINVIS, XNOSEE } from './door.js'
import { F_ISSET, OHIDDN, OSCENE, OINVIS, MHIDDN, MINVIS } from './hexFlags.js'

/**
 * 방 표시 투영 — `RoomNode`(라이브 그래프 노드)를 클라이언트 표시용 뷰로 거르는 순수 함수.
 *
 * oracle `legacy/muhan/src/room.c` 방 표시 루틴 + `object.c:174 list_obj` 이식: 방을 볼 때
 * 숨김 아이템(OHIDDN·OSCENE·OINVIS)·숨김 크리처(MHIDDN·MINVIS)·죽은 개체·비밀 출구
 * (XSECRT·XINVIS·XNOSEE)는 목록에 나오지 않는다.
 *
 * **표시 필터 ≠ 통행 게이트(의도된 비대칭)**: 여기서 제외한 XSECRT/XINVIS 출구도 `tryMove`의
 * 출구 해석(XNOSEE만 제외)은 계속 통행시킨다 — 비밀 출구는 목록에서 사라지되 방향을 직접
 * 입력하면 지나갈 수 있는 오라클 동작이다. 일관성 목적으로 `tryMove`를 고치지 않는다.
 *
 * **관찰자 비의존**: 투명체 감지(PDINVI) 보유자가 숨김 개체를 보는 오라클 예외는 관찰자 상태를
 * 요구하므로 이 함수의 범위 밖이다(후속 항목). 관찰자를 인자로 받지 않고 PDINVI 미보유 플레이어
 * 기준(오라클 기본 경로)으로 무조건 제외한다. 본인 제외도 하지 않는다 — 방 점유자 전원을 싣고
 * 본인 필터는 클라이언트가 수행한다(스펙 §4).
 *
 * 두 flags 표현이 섞인다: 출구는 바이트당 한 원소인 `number[]`라 `door.hasFlag`, 아이템·크리처는
 * 16자 hex string이라 `hexFlags.F_ISSET`을 쓴다.
 */

/**
 * 방 표시 뷰. Story 2에서 shared `world:room` 와이어 계약 파생 타입으로 교체되므로 필드 이름·
 * 순서를 그 계약과 정렬해 둔다. `shortDesc`는 싣지 않는다 — 2341방 중 2327방이 빈 문자열이라
 * 표시 가치가 없다(스펙 §3.1).
 */
export type RoomView = {
  roomId: number
  name: string
  longDesc: string
  exits: string[]
  occupants: { characterId: string; name: string }[]
  items: { instanceId: string; name: string }[]
  creatures: { instanceId: string; name: string; level: number }[]
}

/**
 * 방 노드를 표시용 뷰로 투영한다. 입력 `room`과 그 하위 배열·객체를 변형하지 않고 새 배열·새
 * 객체만 만든다(프로젝트 immutability 규칙).
 *
 * @param room 투영할 라이브 방 노드
 * @param resolveCharacterName characterId → 표시 이름 해소자. `undefined`(미접속·미해소)나 빈
 *   문자열을 돌려준 점유자는 목록에서 빠진다 — 와이어 계약이 `name`에 최소 1자를 요구한다.
 */
/** 방 표시에서 감추는 출구 비트(XSECRT 비밀·XINVIS 투명·XNOSEE 불가시)가 하나라도 있으면 true. */
function isExitHidden(flags: number[]): boolean {
  return hasFlag(flags, XSECRT) || hasFlag(flags, XINVIS) || hasFlag(flags, XNOSEE)
}

/** 방 바닥 목록에서 감추는 아이템 비트(OHIDDN·OSCENE·OINVIS — oracle object.c:174 list_obj). */
function isItemHidden(flags: string): boolean {
  return F_ISSET(flags, OHIDDN) || F_ISSET(flags, OSCENE) || F_ISSET(flags, OINVIS)
}

/** 방 표시에서 감추는 크리처 비트(MHIDDN·MINVIS). 생존 판정(hpcur)은 별개라 여기 넣지 않는다. */
function isCreatureHidden(flags: string): boolean {
  return F_ISSET(flags, MHIDDN) || F_ISSET(flags, MINVIS)
}

export function projectRoomView(
  room: RoomNode,
  resolveCharacterName: (characterId: string) => string | undefined,
): RoomView {
  const occupants: RoomView['occupants'] = []
  for (const characterId of room.occupants) {
    const name = resolveCharacterName(characterId)
    if (name) occupants.push({ characterId, name })
  }

  return {
    roomId: room.roomId,
    // 빈 문자열도 그대로 옮긴다 — 표시 fallback('이름 없는 곳'·'설명이 없다.')은 표시 계층 소유다.
    name: room.name,
    longDesc: room.longDesc,
    exits: room.exits.filter((exit) => !isExitHidden(exit.flags)).map((exit) => exit.name),
    occupants,
    // `contains`(컨테이너 중첩 아이템)로 재귀하지 않는다 — 오라클 방 표시는 바닥 오브젝트만 나열한다.
    items: room.items
      .filter((item) => !isItemHidden(item.flags))
      .map((item) => ({ instanceId: item.instanceId, name: item.name })),
    creatures: room.creatures
      .filter((creature) => !isCreatureHidden(creature.flags) && creature.hpcur > 0)
      .map((creature) => ({
        instanceId: creature.instanceId,
        name: creature.name,
        level: creature.level,
      })),
  }
}
