import type { RoomNode } from 'shared'

/**
 * 활성 집합 — 플레이어가 점유한 방만 크리처 tick 대상으로 유지하는 증분 컬렉션(spec §3, 플랜 T2.4).
 *
 * "빈 방 = 시간 정지" 정합: 방이 비면 활성 집합에서 제거되고, 이후 tick이 그 방을 순회하지 않아
 * 크리처 상태(hpcur·타이머)가 동결된다. 방 재진입 시 `activatedAt`이 진입 시각으로 rebase되어
 * 비활성 구간이 소급되지 않는다(Story 3 재생이 이 시각을 소급 기준으로 사용).
 *
 * 전역 상태 없이 팩토리가 캡슐화된 인스턴스를 반환한다(주입 스타일). `activeSet`은 크리처 상태를
 * 읽기만 하고 변경하지 않는다 — 동결은 "순회 제외"로 달성되지 크리처 필드 조작이 아니다.
 */
export interface ActiveSet {
  /**
   * 방을 활성 등록한다. 점유자가 없으면(빈 방) no-op. 이미 활성이면 no-op(activatedAt 유지, rebase
   * 없음). 비활성→활성 전이 시에만 `activatedAt=now`를 세팅하고 true를 반환한다.
   */
  activate(room: RoomNode, now: number): boolean
  /**
   * 방을 비활성 제거한다. 아직 점유 중이면(occupants 비어있지 않음) no-op. 빈 방이고 활성일 때만
   * 제거하고 true를 반환한다.
   */
  deactivate(room: RoomNode): boolean
  /** 방이 현재 활성인지. */
  isActive(roomId: number): boolean
  /** 방의 활성화 시각(비활성→활성 전이 시각). 비활성이면 undefined. */
  activatedAt(roomId: number): number | undefined
  /** 현재 활성인 방 목록(tick 대상). */
  activeRooms(): RoomNode[]
}

export function createActiveSet(): ActiveSet {
  // roomId → { room, activatedAt }. 활성 방만 보유하며, 비활성화 시 엔트리를 삭제해 activatedAt이
  // 재진입 시각으로 자연히 rebase된다(별도 리셋 로직 불필요).
  const active = new Map<number, { room: RoomNode; activatedAt: number }>()

  return {
    activate(room, now) {
      if (room.occupants.size === 0) return false
      if (active.has(room.roomId)) return false
      active.set(room.roomId, { room, activatedAt: now })
      return true
    },
    deactivate(room) {
      if (room.occupants.size > 0) return false
      if (!active.has(room.roomId)) return false
      active.delete(room.roomId)
      return true
    },
    isActive(roomId) {
      return active.has(roomId)
    },
    activatedAt(roomId) {
      return active.get(roomId)?.activatedAt
    },
    activeRooms() {
      // 단일 패스 push — tick 대상 조회는 1Hz 핫패스라 스프레드+map 이중 할당을 피한다.
      const rooms: RoomNode[] = []
      for (const entry of active.values()) rooms.push(entry.room)
      return rooms
    },
  }
}
