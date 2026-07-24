import type { Character } from 'shared'

/**
 * 라이브 캐릭터 상태 레지스트리 — character._id 키의 인메모리 저장소.
 *
 * 이 레지스트리는 combatRegistry와 **분리한다**(결정 D-A). 이 토픽은 장비·유효 스탯을 다루지
 * 않으므로 `PlayerCombatState`(유효 스탯 컨텍스트·장비 해소를 요구)를 파생할 수 없고,
 * combatRegistry는 현재 런타임 caller가 0건(dormant)이라 지금 통합해도 이득이 없다. 후속 전투
 * 배선 토픽이 `LiveCharacter.character`에서 `PlayerCombatState`를 필요 시점에 파생해
 * combatRegistry에 등록하면 되므로, 지금의 분리가 후속 재설계를 강제하지 않는다. 이 모듈은
 * `combat/`에서 아무것도 import하지 않는다.
 */

/**
 * 라이브 캐릭터 엔트리 — 세션에 부착된 가변 Character 문서.
 *
 * 방 위치의 단일 출처는 `character.currentRoom`이며, LiveCharacter에 별도 방 필드를 두지
 * 않는다(D-A1). 같은 원칙을 소유 계정에도 적용한다 — 소유 계정은 `character.accountId`(필수 FK,
 * character.ts:64)로 역참조하고 별도 `accountId` 필드를 복제하지 않는다(같은 값의 출처가 둘이 되어
 * 분기하는 것을 구조적으로 막는다). `character`는 라이브 가변 문서로, 이 토픽은 `currentRoom`만
 * in-place 갱신하고 HP/MP/spells/realm 등 나머지 필드는 로드되나 dormant다.
 */
export interface LiveCharacter {
  readonly character: Character
}

/**
 * 라이브 캐릭터 레지스트리 API — character._id 키로 라이브 엔트리를 관리한다.
 */
export interface LiveCharacterRegistry {
  /** 라이브 엔트리를 character._id 키로 등록한다(참조 보유). */
  register(live: LiveCharacter): void
  /** characterId로 등록된 라이브 엔트리 참조를 조회한다. 미등록이면 undefined. */
  get(characterId: string): LiveCharacter | undefined
  /** characterId로 등록된 라이브 엔트리를 제거한다. */
  remove(characterId: string): void
  /** characterId 등록 여부. */
  has(characterId: string): boolean
  /** 등록된 모든 엔트리의 스냅샷 배열을 반환한다. */
  list(): LiveCharacter[]
}

/**
 * 새 라이브 캐릭터 레지스트리를 만든다. 반환 객체가 Map을 클로저로 소유하므로 인스턴스 간
 * 상태를 공유하지 않는다(전역 싱글턴 미조회).
 */
export function createLiveCharacterRegistry(): LiveCharacterRegistry {
  const entries = new Map<string, LiveCharacter>()
  return {
    register(live) {
      entries.set(live.character._id, live)
    },
    get(characterId) {
      return entries.get(characterId)
    },
    remove(characterId) {
      entries.delete(characterId)
    },
    has(characterId) {
      return entries.has(characterId)
    },
    list() {
      return [...entries.values()]
    },
  }
}
