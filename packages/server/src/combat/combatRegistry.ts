import type { PlayerCombatState } from './playerState.js'

/**
 * 라이브 플레이어 전투상태 레지스트리 — characterId-keyed 인메모리 저장소(플랜 D2/T4.3).
 *
 * 플레이어는 세션 액터이므로 방 부착이 아닌 characterId 키로 관리한다. 팩토리가 Map을 소유하며
 * 전역 싱글턴을 조회하지 않는다(기존 seam 선례 — 순수 인메모리, 주입 가능). get은 register된
 * 동일 참조를 반환해 전투 resolver가 그 참조로 hpCurrent를 in-place 차감할 수 있게 한다.
 *
 * 세션 lifecycle 콜사이트 배선(월드 입장 시 register / 퇴장 시 remove, occupants add/remove
 * 대칭)은 커넥션 계층 글루로 이번 범위 밖이다 — 여기서는 순수 저장소 API만 제공한다.
 */
export interface CombatRegistry {
  /** 전투상태를 characterId 키로 등록한다(참조 보유). */
  register(state: PlayerCombatState): void
  /** characterId로 등록된 전투상태 참조를 조회한다. 미등록이면 undefined. */
  get(characterId: string): PlayerCombatState | undefined
  /** characterId로 등록된 전투상태를 제거한다. */
  remove(characterId: string): void
  /** characterId 등록 여부. */
  has(characterId: string): boolean
}

/**
 * 새 전투상태 레지스트리를 만든다. 반환 객체가 Map을 클로저로 소유하므로 인스턴스 간 상태를
 * 공유하지 않는다(전역 싱글턴 미조회).
 */
export function createCombatRegistry(): CombatRegistry {
  const states = new Map<string, PlayerCombatState>()
  return {
    register(state) {
      states.set(state.characterId, state)
    },
    get(characterId) {
      return states.get(characterId)
    },
    remove(characterId) {
      states.delete(characterId)
    },
    has(characterId) {
      return states.has(characterId)
    },
  }
}
