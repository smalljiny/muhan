import type { Character, RoomNode } from 'shared'
import type { LiveCharacter, LiveCharacterRegistry } from './liveCharacterRegistry.js'
import type { MoveActor } from './tryMove.js'

/**
 * 라이브 캐릭터 진입 코어 — hydrate(로드) / place(방 배치) / release(퇴장)를 소유한다.
 *
 * 책임 분리(D-G):
 *  - hydrate는 **부수효과 없는 비동기 로드**다(D-G 2). 레지스트리 등록·occupants 변경을 하지 않고
 *    `LiveCharacter`만 조립해 돌려준다. 등록·배치는 동기 caller(place)의 몫이다.
 *  - 재접속은 재로드하지 않는다(D-G 1). 이미 등록된 엔트리는 findById 없이 그대로 반환해,
 *    아직 영속되지 않은 currentRoom(라이브 in-place 갱신값)을 디스크 문서로 덮어쓰지 않는다.
 *  - place/release는 동기이며 occupants Set을 in-place 변경한다(worldGraph 승인 carve-out).
 *    release의 순서 계약은 tryMove.ts:195-199를 미러한다 — occupants.delete가 onRoomLeft보다
 *    반드시 선행한다(leave-hook은 빈 방을 전제로 비활성화한다).
 *
 * 모든 의존성은 파라미터로 주입한다(T3.5 — 전역 조회 없음).
 */

/**
 * 개발용 기본 시작 방. 캐릭터 생성 기본값(firebaseSessionAuthAdapter의 START_ROOM=1)을 미러한다.
 * 완전한 스폰 정책(레벨·종족·소속별 시작지)은 이 토픽 범위 밖이며, orphan currentRoom의
 * 안전 폴백 단일 홈으로만 쓴다.
 */
export const DEFAULT_START_ROOM = 1

/** 최소 logger seam — save/logger.ts·worldClock.ts 관례 미러(console 금지). */
export interface EntryLogger {
  warn(context: Record<string, unknown>, message: string): void
}

export interface LiveCharacterEntryDeps {
  readonly characterRepo: { findById(id: string): Promise<Character | null> }
  readonly liveRegistry: LiveCharacterRegistry
  readonly resolveRoom: (roomId: number) => RoomNode | undefined
  readonly onRoomEntered: (room: RoomNode, actor: MoveActor) => void
  readonly onRoomLeft: (room: RoomNode, actor: MoveActor) => void
  readonly logger: EntryLogger
}

export interface LiveCharacterEntry {
  hydrate(characterId: string): Promise<LiveCharacter>
  place(live: LiveCharacter): void
  release(characterId: string): void
}

/** live.character에서 이동/배치용 MoveActor를 파생한다. */
function toActor(character: Character): MoveActor {
  return { characterId: character._id, currentRoomId: character.currentRoom }
}

export function createLiveCharacterEntry(deps: LiveCharacterEntryDeps): LiveCharacterEntry {
  return {
    async hydrate(characterId) {
      // D-G 1: 재접속은 재로드하지 않는다. 등록된 엔트리를 그대로 반환한다.
      const existing = deps.liveRegistry.get(characterId)
      if (existing !== undefined) return existing

      const character = await deps.characterRepo.findById(characterId)
      if (character === null) {
        throw new Error(`hydrate: character not found: ${characterId}`)
      }

      // T3.2 orphan 폴백 — currentRoom이 미해소면 DEFAULT_START_ROOM으로 교정한다.
      // 라이브 엔트리의 단일 출처(currentRoom)가 처음부터 유효하도록 불변 교체한다.
      // 전제: DEFAULT_START_ROOM은 월드 그래프에 항상 해소된다(정본 시작 방). 이 전제가 place()의
      // "hydrate가 유효 방을 보장" 계약을 성립시킨다 — 전제가 깨지면 place가 room-not-resolved로 던진다.
      if (deps.resolveRoom(character.currentRoom) === undefined) {
        deps.logger.warn(
          { characterId, orphanRoom: character.currentRoom, fallback: DEFAULT_START_ROOM },
          'hydrate: currentRoom orphan — DEFAULT_START_ROOM으로 폴백',
        )
        return { character: { ...character, currentRoom: DEFAULT_START_ROOM } }
      }

      return { character }
    },

    place(live) {
      const characterId = live.character._id
      const room = deps.resolveRoom(live.character.currentRoom)
      if (room === undefined) {
        // TOCTOU 가드: hydrate(async)가 유효 방을 보장하지만 place(later-sync)까지 사이에 월드 그래프가
        // 바뀌어(방 제거) 미해소가 될 수 있다. 정상 경로에선 도달하지 않으나 죽은 코드가 아니다 — 계약
        // 위반을 조용히 삼키지 않고 크게 던진다(tryMove의 soft NO_EXIT과 달리 여긴 배치 계약 경계다).
        throw new Error(`place: room not resolved: ${live.character.currentRoom}`)
      }

      // 멱등(재접속): 이미 방 점유자면 중복 추가·중복 훅 호출을 하지 않는다.
      if (room.occupants.has(characterId)) return

      deps.liveRegistry.register(live)
      room.occupants.add(characterId)
      deps.onRoomEntered(room, toActor(live.character))
    },

    release(characterId) {
      const live = deps.liveRegistry.get(characterId)
      if (live === undefined) return // 미등록 characterId는 no-op

      const actor = toActor(live.character)
      const room = deps.resolveRoom(live.character.currentRoom)
      if (room !== undefined) {
        // 순서 계약(tryMove.ts:195-199 미러): delete가 onRoomLeft보다 선행한다.
        room.occupants.delete(characterId)
        deps.onRoomLeft(room, actor)
      }
      deps.liveRegistry.remove(characterId)
    },
  }
}
