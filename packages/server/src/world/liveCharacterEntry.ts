import type { Character, ObjectInstance, RoomNode } from 'shared'
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
 *
 * ## 인벤토리 적재 — 세션 진입에서 1회
 * hydrate가 `characterRepo.hydrateInventory`를 함께 호출해 소유 오브젝트 인스턴스를 라이브 엔트리에
 * 싣는다. 진입에서 한 번 다 읽어 두는 이유는 **명령 핸들러의 동기 계약을 지키기 위해서**다
 * (`ws/router.ts`의 `CommandHandler`는 `ServerEvent | undefined`를 동기 반환한다). 핸들러가 인벤을
 * 그때그때 DB에서 읽으면 async가 되고, 상태 변형과 dirty 표시 사이에 정지점이 생겨 중간 상태가
 * 다른 명령에 노출된다.
 *
 * 조기 반환(이미 등록된 엔트리)은 인벤을 **재로드하지 않는다**(D-G 1의 확장). 재로드하면 아직
 * 영속되지 않은 라이브 변경(연마로 소모된 비법서 등)이 디스크 스냅샷으로 되살아나 아이템이 복제된다.
 *
 * ⚠ 이 재로드 금지는 **엔트리가 살아 있는 동안**만 유효하다. grace 만료로 엔트리가 완전히 release된
 * 뒤 재접속하면 인벤은 디스크 스냅샷으로 돌아간다 — 세션 종료 스냅샷(`liveSessionLifecycleAdapter`)이
 * `character`만 dirty로 표시하고 인벤은 표시하지 않기 때문이다(#124의 pending 스냅샷과 같은 부류).
 *
 * 이 공백은 **삭제에 한해서만** 닫힌다 — 후속 Story가 `objectDeletions` 삭제 어댑터를 추가하지만
 * objects의 update·insert 어댑터는 없다. 따라서 삭제 이외의 인벤 변경(equip 토글·`shotscur` 감소·
 * 줍기)은 영속 경로가 아예 없고, 캐릭터 필드와 달리 종료 스냅샷이라는 구제자도 없다.
 * 라이브 인벤을 메모리 권위로 쓰되 **영속화까지 닫힌 것으로 읽지 말 것.**
 *
 * ### 진입 비용 추적 임계(OQ3)
 * 지금은 측정하지 않는다 — `objects`에 캐릭터 소유 문서를 만드는 경로(줍기·시드)가 아직 없어 측정
 * 모집단이 0이고, 추가 비용은 `{owner.type, owner.id, _id}` 인덱스가 정렬까지 제공하는
 * **세션당 find 1회**다(진입 왕복 1→2 — 현재 `findById` 뒤에 순차 await이라 지연이 더해진다.
 * 임계 초과 시 첫 후보는 두 조회의 `Promise.all` 병렬화다).
 * 아래 둘 중 하나가 관측되면 측정 토픽을 연다:
 *  - 캐릭터당 소유 object 문서 수 p95 > **50건**
 *  - 세션 진입(hydrate) p95 > **200ms**
 *
 * ### ⚠ 알려진 divergence — 인벤 서수 기준 순서
 * 오라클 인벤 리스트(`first_obj`)는 도착 순서가 아니라 **이름 정렬 삽입 리스트**다
 * (`add_obj_crt`, `legacy/muhan/src/player.c:857-898`: `strcmp(name)` 오름차순 삽입, 동명일 때
 * `adjustment` 오름차순). 즉 오라클 서수는 이름 사전순이다.
 *
 * 이 포트는 `ObjectRepository.findByOwner`의 `_id` 오름차순을 그대로 쓴다. 정렬을 이식하지 않는
 * 이유는 방 서수 divergence(#137)와 같다 — `strcmp`는 EUC-KR 바이트 비교인데 KS X 1001 완성형
 * 배열과 Unicode Hangul Syllables 배열이 달라 JS 문자열 비교로 재현되지 않는다(collation 테이블
 * 없이는 이식 불가). 대신 **결정적 순서는 보장한다**: Mongo 자연 순서는 계약이 아니라 같은 인벤이
 * 조회마다 다른 서수를 낼 수 있고, 서수는 플레이어가 관측하는 동작이다.
 *
 * 영향 범위는 질의 접두가 같고 이름이 다른 소지품이 공존할 때의 서수뿐이다.
 * <!-- 추적 이슈: #142 (자매 이슈 #137 — 같은 원인·같은 collation 해법을 공유한다) -->
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
  /**
   * 캐릭터 문서·인벤토리 로더. 두 메서드만 요구한다(최소 표면) — `hydrateInventory`는
   * `object.owner` 역참조로 소유 인스턴스를 파생하는 조회 경로다(단일 소유권의 출처는 owner다).
   */
  readonly characterRepo: {
    findById(id: string): Promise<Character | null>
    hydrateInventory(id: string): Promise<ObjectInstance[]>
  }
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

      // 인벤 적재 — 진입당 정확히 1회(OQ3 상한). findById 뒤에 두어 미존재 캐릭터에는 조회하지
      // 않는다(순차 왕복 2회). 아래 두 반환 지점이 이 결과를 공유하므로 orphan 폴백도 인벤을 싣는다.
      const inventory = await deps.characterRepo.hydrateInventory(characterId)

      // T3.2 orphan 폴백 — currentRoom이 미해소면 DEFAULT_START_ROOM으로 교정한다.
      // 라이브 엔트리의 단일 출처(currentRoom)가 처음부터 유효하도록 불변 교체한다.
      // 전제: DEFAULT_START_ROOM은 월드 그래프에 항상 해소된다(정본 시작 방). 이 전제가 place()의
      // "hydrate가 유효 방을 보장" 계약을 성립시킨다 — 전제가 깨지면 place가 room-not-resolved로 던진다.
      if (deps.resolveRoom(character.currentRoom) === undefined) {
        deps.logger.warn(
          { characterId, orphanRoom: character.currentRoom, fallback: DEFAULT_START_ROOM },
          'hydrate: currentRoom orphan — DEFAULT_START_ROOM으로 폴백',
        )
        return { character: { ...character, currentRoom: DEFAULT_START_ROOM }, inventory }
      }

      return { character, inventory }
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
