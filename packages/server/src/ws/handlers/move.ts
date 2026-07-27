import type { ClientCommand, ServerEvent } from 'shared'
import type { CommandHandler } from '../router.js'
import type { ActorContext } from '../actorContext.js'
import type { LiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import { tryMove, type MoveActor, type TryMoveDeps } from '../../world/tryMove.js'
import { makeErrorEvent } from '../serverEvent.js'

/**
 * move 핸들러 의존성 seam(전역 금지 — 인자 주입).
 *
 * `liveRegistry`는 방 위치 단일 출처(`character.currentRoom`, D-A1)를 조회할 라이브 레지스트리로,
 * 핸들러가 소비하는 유일한 메서드 `get`만 요구한다(최소 표면). `tryMoveDeps`는 통합 이동 경로가
 * 소비하는 방 그래프·게임시각·방송·훅·rng seam이다(tryMove가 소유·전달, 핸들러는 그대로 위임).
 * `markDirty`는 write-behind 영속화 seam으로 train/regen 선례와 동일 시그니처다.
 */
export interface MoveHandlerDeps {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get'>
  readonly tryMoveDeps: TryMoveDeps
  readonly markDirty: (collection: string, id: string, snapshot: unknown) => void
}

/** characters 컬렉션 이름 — markDirty 키 파생(train/regen과 정합). */
const CHARACTERS_COLLECTION = 'characters'

/**
 * `world:move{direction, id?}` 명령을 실 이동으로 배선하는 핸들러 팩토리.
 *
 * 방 위치 단일 출처는 `LiveCharacter.character.currentRoom`이다(D-A1) — 핸들러는 currentRoom을
 * 오직 registry 엔트리에서 읽고, actor(accountId/characterId만 보유, 방 필드 없음)에서 읽지 않는다(D2).
 * 방향 별칭·단축키 해소는 클라이언트 책임이라(D-B) 서버는 해소된 최종 `direction` 문자열만 받아
 * mode를 `directional`로 고정한다(flee/sneak/named를 노출하지 않는다).
 *
 * 점유자 재배치·leave/join 방송·leave/enter 훅은 `tryMove`가 소유한다(tryMove.ts:194-199) —
 * 핸들러는 occupants Set을 건드리지 않고, 성공 시 `live.character.currentRoom`만 in-place 갱신
 * (immutability 규칙의 승인된 라이브 carve-out)한 뒤 그 시점 값을 markDirty에 흘린다.
 * tryMove는 거부(gate.ok=false) 시 어떤 mutation·방송보다 먼저 bail하므로(tryMove.ts:186),
 * 거부 경로에서 핸들러는 live·markDirty를 건드리지 않는다.
 *
 * 반환:
 *   - 성공 → `world:room{roomId, exits}`(상태 이벤트, correlationId 없음 — D-C 최소 방 통지).
 *   - 거부 → `error{rule_rejected, message}`(게임 규칙 거부, id 있으면 correlationId 반향 — D-D).
 *   - 라이브 미등록 actor(registry에 엔트리 없음) → `error{internal}`(배선 격리). 방이 그래프에서
 *     미해소인 경우는 이 경로가 아니라 tryMove가 `NO_EXIT`→`rule_rejected`로 처리한다.
 */
export function createMoveHandler(deps: MoveHandlerDeps): CommandHandler {
  return (command: ClientCommand, actor: ActorContext): ServerEvent | undefined => {
    // (1) defensive narrow — router는 world:move type에만 이 핸들러를 배선하므로 false 갈래는
    //     구조적으로 도달 불가한 방어선이다.
    if (command.type !== 'world:move') return undefined

    // (2) 방 위치 단일 출처 조회. 라이브 미등록 actor는 이동 불가 — internal로 격리한다.
    const live = deps.liveRegistry.get(actor.characterId)
    if (live === undefined) {
      return makeErrorEvent('internal', '캐릭터 라이브 상태를 찾을 수 없습니다', command.id)
    }

    // (3) currentRoom은 오직 registry 엔트리에서 얻는다(D2 — actor에는 방 필드가 없다).
    const moveActor: MoveActor = {
      characterId: actor.characterId,
      currentRoomId: live.character.currentRoom,
    }

    // (4) 통합 이동 — mode는 directional 고정(D-B). tryMove가 점유자 재배치·방송·훅을 소유한다.
    const result = tryMove(deps.tryMoveDeps, moveActor, command.direction, 'directional')

    // (5) 거부 — 게임 규칙 거부(D-D). tryMove가 mutation 전 bail하므로 live·markDirty 불변.
    if (!result.ok) {
      return makeErrorEvent('rule_rejected', result.reason, command.id)
    }

    // (6) 성공 — live 방 위치를 도착 방으로 갱신(D-A1 라이브 carve-out) 후 그 시점 값을 write-behind.
    live.character.currentRoom = result.arrivedRoom.roomId
    deps.markDirty(CHARACTERS_COLLECTION, actor.characterId, {
      currentRoom: live.character.currentRoom,
    })
    return {
      type: 'world:room',
      roomId: result.arrivedRoom.roomId,
      exits: result.arrivedRoom.exits.map((e) => e.name),
    }
  }
}
