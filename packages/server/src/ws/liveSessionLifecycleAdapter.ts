import type { SessionLifecyclePort, SessionEndContext } from './sessionLifecyclePort.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'

/** characters 컬렉션 이름 — markDirty 키 파생(move·train·regen과 정합, 리터럴 분산 방지). */
const CHARACTERS_COLLECTION = 'characters'

/**
 * 라이브 세션 수명 어댑터 — 세션 종결 시 도메인 상태를 수렴시키는 `SessionLifecyclePort` 구현.
 *
 * 포트(`sessionLifecyclePort.ts`)·no-op 형제(`noopSessionLifecycleAdapter.ts`)와 같은 ws/ 레이어에
 * 둔다 — 이 어댑터는 세션 종결이라는 transport 수명 이벤트에 반응하는 ws 관심사이고, world/ 레지스트리·
 * 엔트리는 정상 방향(ws→world)으로 주입받는다. world/에 두면 도메인 레이어가 ws 포트를 역참조해
 * 레이어링이 뒤집힌다.
 *
 * 세션이 끝나면 두 단계를 순서대로 처리한다:
 *  1. 최종 방(currentRoom)을 dirty로 표시해 다음 저장 주기에 영속화되게 한다.
 *  2. Story 3의 release 코어로 방 점유(occupants)와 라이브 레지스트리 엔트리를 제거한다.
 *
 * no-op 어댑터(createNoopSessionLifecycleAdapter)와 달리 이 어댑터는 실제 도메인 상태를 변이한다.
 * 단, 실 DB write는 하지 않는다 — markDirty로 side registry에만 기록하고 실 flush는 저장 스케줄러/
 * 셧다운 수렴이 소유한다(§4 D5: markDirty만, saveNow 아님).
 *
 * ── 동기 시그니처 근거 ──────────────────────────────────────────────
 * onSessionEnd는 `SessionLifecyclePort`의 계약대로 동기다(sessionLifecyclePort.ts:31). 이 어댑터는
 * 인메모리 변이(occupants Set·레지스트리 Map)와 markDirty(동기 side registry 기록)만 하므로 async가
 * 필요 없다. 실 DB I/O는 포트 뒤가 아니라 저장 스케줄러의 비동기 flush에 있으므로 여기서 await하지 않는다.
 * 호출부(resolveDisconnect)가 try/catch로 감싸 어댑터가 던져도 transport teardown을 막지 않는다 —
 * 이 어댑터는 그 계약에 의존하지 않고 정상 경로에서 던지지 않는다.
 *
 * ── dirty-before-release 순서(D-A1 / T6.3) ─────────────────────────
 * markDirty를 release보다 **먼저** 호출한다. 방 위치의 단일 출처는 `live.character.currentRoom`이며
 * (D-A1), release가 레지스트리 엔트리를 제거하면 그 값을 더 이상 읽을 수 없다. 따라서 종료 시점의 방을
 * 먼저 스냅샷으로 뽑아 markDirty한 뒤 release로 정리해야, 마지막에 있던 방이 정확히 영속화된다.
 *
 * ── 이 markDirty가 언제 실제로 필요한가(중복 아님) ─────────────────────
 * 이동 핸들러(handlers/move.ts)가 이동 성공마다 currentRoom을 write-through로 markDirty하므로, 이동 뒤
 * 종료하는 경로에서는 이 어댑터의 markDirty가 그 값을 재-mark하는 것처럼 보인다. 그러나 이 markDirty는
 * **종료 경계의 단일 수렴 지점**이라 다음 경우에 유일한 영속 경로다: (a) 캐릭터가 로드 후 한 번도 이동하지
 * 않고 종료 — write-through가 없어 이 markDirty만이 위치를 저장한다. 특히 (b) hydrate가 orphan
 * currentRoom을 DEFAULT_START_ROOM으로 교정한 경우(D-H), 그 교정은 이동 없이는 이 종료 markDirty로만
 * 영속된다. 향후 비-이동 currentRoom 변이(recall·teleport·respawn)도 자기-markDirty를 빠뜨리면 여기서
 * 최종 값이 잡힌다. 따라서 삭제하면 안 되는 teardown 정합선이다.
 *
 * ── reason 미분기(T6.4) ────────────────────────────────────────────
 * `SessionEndContext.reason`(evictedByNewLogin·graceExpired·idleTimeout·shutdown)은 읽지 않는다.
 * 네 사유 모두 "세션이 끝났으니 위치를 저장하고 점유를 푼다"는 동일 후처리를 요구하므로 분기가 없다.
 * 미등록 characterId(get이 undefined)는 no-op으로 조용히 반환한다 — 이미 종결됐거나 배치되지 않은
 * 세션의 중복 종료 통지를 안전하게 흡수한다.
 *
 * ── Story 3 release 코어 재사용(T6.2) ──────────────────────────────
 * 점유 해제는 Story 3의 `createLiveCharacterEntry(...).release`를 그대로 주입받아 쓴다(중복 구현 금지).
 * release는 occupants.delete → onRoomLeft(delete-before-hook) → registry.remove 순서를 소유하며
 * 미등록 id에 no-op이다.
 *
 * ── 기본 배선은 그대로(T6.5) ────────────────────────────────────────
 * Story 6은 plugin.ts의 기본 lifecyclePort를 바꾸지 않는다 — 기본은 여전히 no-op 어댑터다. 이 라이브
 * 어댑터의 프로덕션 주입은 Story 7의 몫이다.
 *
 * ── deps 불변식 ────────────────────────────────────────────────────
 * `liveRegistry.get`과 `release`는 **같은 레지스트리 인스턴스**를 배후에 두어야 한다. get이 A 레지스트리를
 * 보고 release가 B 레지스트리를 정리하면 markDirty는 A의 값을 읽고 점유 해제는 B에서 일어나 상태가
 * 분기한다. Story 7 배선 시 두 참조를 반드시 동일 인스턴스에서 파생한다.
 */
export interface LiveSessionLifecycleAdapterDeps {
  /** 라이브 엔트리 조회(read-only). 종료 시점 currentRoom을 읽는 데만 쓴다. */
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get'>
  /** Story 3의 release 코어(occupants.delete → onRoomLeft → registry.remove). 미등록 id에 no-op. */
  readonly release: (characterId: string) => void
  /** 변경 엔티티 side registry 기록(collection·id·스냅샷). 실 flush는 저장 스케줄러가 소유. */
  readonly markDirty: (collection: string, id: string, snapshot: unknown) => void
}

/**
 * 라이브 세션 수명 어댑터를 만든다. onSessionEnd는 종료 시점의 방을 markDirty로 표시한 뒤 release로
 * 점유·엔트리를 정리한다. 미등록 characterId는 no-op이다.
 */
export function createLiveSessionLifecycleAdapter(
  deps: LiveSessionLifecycleAdapterDeps,
): SessionLifecyclePort {
  return {
    onSessionEnd(ctx: SessionEndContext) {
      const live = deps.liveRegistry.get(ctx.characterId)
      if (live === undefined) return // 미등록 id → no-op(T6.4)

      // dirty-before-release(D-A1/T6.3): release가 엔트리를 제거하기 전에 종료 시점 방을 스냅샷한다.
      deps.markDirty(CHARACTERS_COLLECTION, ctx.characterId, {
        currentRoom: live.character.currentRoom,
      })

      // Story 3 release 코어 재사용(T6.2): occupants.delete → onRoomLeft → registry.remove.
      deps.release(ctx.characterId)
    },
  }
}
