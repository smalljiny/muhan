import type { ExitEdge, RoomNode } from 'shared'
import { hasFlag, XNOSEE } from './door.js'
import { evaluateMoveGates } from './moveGates.js'

/**
 * 통합 이동 경로 — 원본 A4 §8의 4중 복제 이동 코드를 단일 `tryMove`로 통합한다.
 *
 * oracle `docs/notes/game-analysis-20260625/a4-movement-rooms.md` §1(게이트)·§8(4중 복제) +
 * spec §3.3·§3.4 이식:
 *   원본은 방향 이동·명명 이동·flee·sneak가 각기 거의 동일한 게이트 건틀릿을 복제해 갖고 있었다.
 *   본 이식은 **출구 선택 방식만 mode로 분기**하고, 선택된 출구에 대한 게이트 건틀릿 본체
 *   (`evaluateMoveGates`, Story 6)와 통과 후 leave/join 방송·점유자 재배치를 전 mode가 공유한다.
 *
 * 게이트 순서(콘텐츠)는 `moveGates.ts`가 보존한다. 여기서는 그 앞단인
 *   - gate 1(출구 존재) + XNOSEE 이름/방향 탐색 제외(6번째 강제 게이트)
 *   - 통과 후 부수효과(방송·재배치)
 * 만 담당한다. dangling(대상 방 부재)은 건틀릿 내부(danglingGate)가 처리하므로 미해석 target을
 * 그대로 건틀릿에 넘긴다.
 *
 * 순수성/가변성 경계:
 *   출구 해석·게이트 평가는 부수효과가 없다. 통과 시에만 라이브 가변 carve-out으로
 *   `RoomNode.occupants` Set을 in-place 변경한다(worldGraph 타입 주석과 정합). 그 외 입력은 불변.
 *
 * 범위 밖(구현하지 않음): 추종자(first_fol)·몬스터 추격·트랩 발동(A4 §5), 그리고 A4 §8이 경고한
 *   `F_ISSET(ext, 52)` 경계 밖 접근(비트 52는 4바이트 exit flags 범위 밖 → ltime 침범). 어떤
 *   게이트·flee 로직도 flag 52를 읽지 않는다.
 */

// ── actor·mode·결과 타입 ──────────────────────────────────────────────────────

/**
 * 이동 actor의 최소 shape. 실 `ActorContext`를 import하지 않는다 — currentRoomId는 후속
 * 방 배치 에픽에서 얻으므로(지금은 seam) 로컬 최소 타입으로 둔다. ActorContext가 구조적으로
 * 이 타입에 할당 가능해지면(characterId+currentRoomId 보유) world/를 ws/에 결합하지 않고 붙는다.
 */
export type MoveActor = {
  readonly characterId: string
  readonly currentRoomId: number
}

/**
 * 이동 mode — 출구 **선택 방식**만 결정한다(게이트 건틀릿 본체는 공유). spec §3.4:
 *   - directional/named/sneak: 이름/방향 문자열(selector)로 출구를 선형 탐색.
 *   - flee: selector 무시, chooseFleeExit로 가시 출구를 선택.
 */
export type MoveMode = 'directional' | 'named' | 'flee' | 'sneak'

/**
 * flee 출구 선택자(rng) seam. 가시 출구 목록에서 하나를 고른다. E4-1b 기본은 결정적 stub
 * (`defaultFleeRng`, 첫 출구)이라 단위 테스트가 결정적으로 통과한다. 실 확률(65%+dex 굴림)·
 * 시드 규약은 E8-2 RNG 규약과 정합해 이 seam에 주입한다.
 */
export type FleeRng = (exits: readonly ExitEdge[]) => ExitEdge | undefined

/**
 * tryMove 의존성 주입 seam(전역 금지 — 인자 주입). 실 배선은 워드 그래프·G2 게임시각·Story 5
 * 채널 어댑터 경유이며, E4-1b는 fake 주입으로 검증한다.
 */
export interface TryMoveDeps {
  /** 방 그래프 조회 — roomId로 방 노드를 얻는다. 없으면 undefined. */
  readonly resolveRoom: (roomId: number) => RoomNode | undefined
  /** 현재 게임시각(0~23) — G2 gameTime.currentHour() 주입. 시간 게이트가 소비. */
  readonly currentHour: () => number
  /** 출발 방 leave 방송 seam — actor가 아직 출발 방 점유자일 때 호출된다. */
  readonly broadcastLeave: (room: RoomNode, actor: MoveActor) => void
  /** 도착 방 join 방송 seam — actor가 이미 도착 방 점유자가 된 뒤 호출된다. */
  readonly broadcastJoin: (room: RoomNode, actor: MoveActor) => void
  /**
   * 방 진입 entry-hook seam — actor가 도착 방 점유자가 된 뒤(join 방송 직후) 호출된다.
   * E4-2가 활성 집합 활성화 + perm 리스폰 검사(Story 4)를 이 훅에 건다. E4-1b/기본 주입은
   * no-op이라 이동 로직·기존 테스트가 불변이다.
   */
  readonly onRoomEntered: (room: RoomNode, actor: MoveActor) => void
  /**
   * 방 퇴장 leave-hook seam — actor가 출발 방 점유자에서 제거된 직후(점유자 delete 後) 호출된다.
   * `broadcastLeave`(delete 前 호출)와 대칭이나 시점이 다르다 — E4-2가 `activeSet.deactivate`를
   * 이 훅에 걸어 빈 방을 비활성화하며, deactivate는 빈 방(occupants 비어있음)을 요구하므로 반드시
   * delete 後에 호출돼야 한다. E4-1b/기본 주입은 no-op이라 이동 로직·기존 테스트가 불변이다.
   */
  readonly onRoomLeft: (room: RoomNode, actor: MoveActor) => void
  /** flee 출구 선택자 — chooseFleeExit에 위임된다. */
  readonly rng: FleeRng
}

/** 결정적 기본 entry-hook — no-op. E4-2가 활성화·perm 리스폰 결선으로 대체 주입한다. */
export const noopOnRoomEntered = (_room: RoomNode, _actor: MoveActor): void => {}

/** 결정적 기본 leave-hook — no-op. E4-2가 활성 집합 비활성화 결선으로 대체 주입한다. */
export const noopOnRoomLeft = (_room: RoomNode, _actor: MoveActor): void => {}

/** tryMove 결과. 통과면 arrivedRoom(도착 방), 거부면 reason(사유). MoveGateResult와 동형. */
export type TryMoveResult =
  | { readonly ok: true; readonly arrivedRoom: RoomNode }
  | { readonly ok: false; readonly reason: string }

// ── flee 출구 선택 (순수 함수) ────────────────────────────────────────────────

/**
 * 결정적 기본 rng — 첫 가시 출구를 선택한다. E4-1b 단위 테스트를 결정적으로 통과시키는 stub.
 * 실 확률·시드는 E8-2에서 이 자리에 다른 FleeRng를 주입해 대체한다.
 */
export const defaultFleeRng: FleeRng = (exits) => exits[0]

/**
 * flee 시 가시 출구 중 하나를 rng로 선택한다. 빈 목록이면 undefined(도망칠 출구 없음).
 * 확률 로직은 주입 rng seam에 위임해 이 함수는 순수·결정적으로 유지된다.
 */
export function chooseFleeExit(
  visibleExits: readonly ExitEdge[],
  rng: FleeRng,
): ExitEdge | undefined {
  if (visibleExits.length === 0) return undefined
  return rng(visibleExits)
}

// ── mode별 출구 해석 ──────────────────────────────────────────────────────────

/**
 * 이름/방향 탐색에서 XNOSEE 출구를 제외한다(6번째 강제 게이트 gate 1). XNOSEE 출구는
 * 이름·방향으로 도달 불가하며, flee의 가시 후보에서도 빠진다.
 */
function isVisible(exit: ExitEdge): boolean {
  return !hasFlag(exit.flags, XNOSEE)
}

/**
 * mode에 따라 source 방에서 사용할 출구를 해석한다. 못 찾으면 undefined.
 *   - directional/named/sneak: selector와 이름이 일치하고 XNOSEE 아닌 출구를 선형 탐색.
 *   - flee: 가시 출구(XNOSEE 제외) 중 rng로 선택.
 *
 * directional/named/sneak 3개 mode는 이 seam에서 **의도적으로 동일한** 이름 탐색이다 —
 * 원본은 방향어(2/ㄴ→남)를 이름으로 정규화(A3 §2)하고, sneak의 은신 유지 판정은 §3.3 게이트 14
 * (은신, E5/E6 대기) stub 소관이라 출구 선택 단계에서는 갈리지 않는다. flee만 확률 선택으로 분기.
 */
function resolveExit(
  sourceRoom: RoomNode,
  selector: string,
  mode: MoveMode,
  rng: FleeRng,
): ExitEdge | undefined {
  if (mode === 'flee') {
    const visibleExits = sourceRoom.exits.filter(isVisible)
    return chooseFleeExit(visibleExits, rng)
  }
  return sourceRoom.exits.find((exit) => isVisible(exit) && exit.name === selector)
}

// ── 통합 이동 경로 ────────────────────────────────────────────────────────────

/** 출구를 못 찾았을 때의 거부 사유(막힌 방향). */
const NO_EXIT: TryMoveResult = { ok: false, reason: '길이 막혀 있습니다' }

/**
 * 통합 이동. 4개 mode가 이 단일 경로를 공유하고 출구 선택 방식만 분기한다.
 *
 * 순서: (1) source 방 해석 → (2) mode별 출구 해석(gate 1 + XNOSEE 제외) → (3) target 해석 →
 * (4) 공유 게이트 건틀릿 실행 → 통과 시 (5a) leave 방송 (5b) 점유자 재배치 (5c) join 방송.
 * 어느 단계든 거부되면 이동을 취소하고(재배치·방송 없음) 거부 결과를 반환한다.
 */
export function tryMove(
  deps: TryMoveDeps,
  actor: MoveActor,
  selector: string,
  mode: MoveMode,
): TryMoveResult {
  // (1) 출발 방 = resolveRoom(actor.currentRoomId). 없으면 거부.
  const sourceRoom = deps.resolveRoom(actor.currentRoomId)
  if (sourceRoom === undefined) return NO_EXIT

  // (2) mode별 출구 해석 — gate 1(존재) + XNOSEE 탐색 제외. 못 찾으면 거부.
  const exit = resolveExit(sourceRoom, selector, mode, deps.rng)
  if (exit === undefined) return NO_EXIT

  // (3) 도착 방 = resolveRoom(exit.targetRoomId). 미해석(dangling)이면 건틀릿이 거부하므로
  //     undefined를 그대로 건틀릿에 넘긴다.
  const targetRoom = deps.resolveRoom(exit.targetRoomId)

  // (4) 공유 게이트 건틀릿(Story 6) — dangling·XLOCKD·XCLOSD·시간·정원 등 순서 보존.
  //     flee 도착 후 정원(17) 재검사도 이 1회 실행이 표현한다(별도 2차 실행 불필요).
  const gate = evaluateMoveGates({
    exit,
    targetRoom,
    actor: { characterId: actor.characterId },
    currentHour: deps.currentHour(),
  })
  if (!gate.ok) return { ok: false, reason: gate.reason }

  // 건틀릿 통과 시 targetRoom은 반드시 정의됨(dangling 게이트가 undefined를 선행 거부).
  // 타입 좁힘을 위한 방어 — 도달 불가 경로.
  if (targetRoom === undefined) return NO_EXIT

  // (5) 통과 — spec §3.3 순서. 라이브 가변 carve-out: occupants Set in-place 변경(worldGraph
  //     타입 주석과 정합, 프로젝트 immutability 규칙의 승인된 예외).
  deps.broadcastLeave(sourceRoom, actor) // (5a) actor는 아직 출발 방 점유자
  sourceRoom.occupants.delete(actor.characterId) // (5b) 재배치
  deps.onRoomLeft(sourceRoom, actor) // (5b') leave-hook — 빈 방 비활성화(E4-2). delete 後여야 deactivate 성립
  targetRoom.occupants.add(actor.characterId)
  deps.broadcastJoin(targetRoom, actor) // (5c) actor는 이미 도착 방 점유자
  deps.onRoomEntered(targetRoom, actor) // (5d) entry-hook — 활성화·perm 리스폰(E4-2 Story 4)

  return { ok: true, arrivedRoom: targetRoom }
}
