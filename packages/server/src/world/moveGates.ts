import type { ExitEdge, RoomNode } from 'shared'
import { hasFlag, XLOCKD, XCLOSD } from './door.js'

/**
 * 이동 게이트 건틀릿 — A4 §1의 순차 거부 검사를 순수 predicate 배열로 이식한다.
 *
 * oracle `docs/notes/game-analysis-20260625/a4-movement-rooms.md` §1 + spec §3.3:
 *   원본 `move()`(command2.c:284)는 정규화된 출구명 이후 ~20단 게이트를 순서대로 평가하고,
 *   하나라도 걸리면 즉시 거부·이동 취소한다. 본 이식은 그 순서(콘텐츠)를 보존하되 각 게이트를
 *   부수효과 없는 순수 predicate로 만든다. 강제 게이트는 실 거부하고, 입력 에픽 대기 게이트는
 *   순서상 자리만 지키는 pass-through stub이다.
 *
 * 범위: gate 1(출구 존재)·XNOSEE 이름 탐색 제외는 이 모듈 밖(tryMove 소관, Story 7)이다.
 *   여기서는 gate 1b(dangling)부터 20까지를 다룬다. 통과 시 leave/join·점유자 재배치도 tryMove가 한다.
 *
 * 순수성: 모든 게이트는 입력을 읽기만 하고 변형하지 않는다(출구 flags·방 occupants·actor 불변).
 *   문 상태 변경은 door.ts 전이 함수의 carve-out이지 게이트의 책임이 아니다.
 */

// ── 신규 플래그 비트 상수 (mtype.h 오라클 검증 완료) ──────────────────────────
// XLOCKD·XCLOSD·hasFlag는 door.ts에서 재사용한다(중복 정의 금지). 아래는 이 모듈 신규 상수다.

/** 야간 전용 출구 — exit.flags 비트 16(32비트 배열). 낮에는 닫혀 있다. */
export const XNGHTO = 16
/** 주간 전용 출구 — exit.flags 비트 17(32비트 배열). 밤에는 닫혀 있다. */
export const XDAYON = 17

// 주의: 아래 방 플래그는 room.flags(8바이트=64비트) 배열을 읽는다. XNGHTO(16, 출구)와
// RTHREE(16, 방)는 비트 번호가 같지만 서로 다른 flags 배열이라 충돌하지 않는다.

/** 안전지대 — room.flags 비트 11(RNOKIL, mtype.h:312). PvP 무조건 금지(command5.c:177). */
export const RNOKIL = 11
/** 대련장(서바이벌 존) — room.flags 비트 36(RSUVIV, mtype.h:337). 선악 PvP 게이트 면제(command5.c:184). */
export const RSUVIV = 36
/** 1인 전용 방 — room.flags 비트 14. 점유자 1명 이상이면 만원. */
export const RONEPL = 14
/** 2인 전용 방 — room.flags 비트 15. 점유자 2명 이상이면 만원. */
export const RTWOPL = 15
/** 3인 전용 방 — room.flags 비트 16. 점유자 3명 이상이면 만원. */
export const RTHREE = 16

// ── 입력·결과 타입 ────────────────────────────────────────────────────────────

/**
 * 게이트가 참조하는 actor의 최소 shape. server `ActorContext`가 구조적으로 이 타입에
 * 할당 가능하므로(characterId 보유) world/ 를 ws/ 에 결합하지 않는다. 현 강제 게이트는
 * actor를 읽지 않지만, 진영·레벨 등 후속 강제 게이트(E5/E6)가 소비할 seam으로 계약에 둔다.
 */
export type MoveGateActor = {
  readonly characterId: string
}

/**
 * 게이트 건틀릿 입력. exit·targetRoom은 이미 해석된 상태로 주입된다(출구 선택·대상 해석은
 * tryMove의 mode 분기 소관). currentHour는 G2 gameTime.currentHour() 주입값(0~23)이다.
 * targetRoom이 undefined면 dangling(대상 방 부재)이다.
 */
export interface MoveGateInput {
  readonly exit: ExitEdge
  readonly targetRoom: RoomNode | undefined
  readonly actor: MoveGateActor
  readonly currentHour: number
}

/** 게이트 평가 결과. 통과면 ok:true, 거부면 ok:false + 거부 사유 메시지. */
export type MoveGateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** 통과 결과 상수 — 재사용해 stub·통과 경로가 동일 객체를 반환한다. */
const PASS: MoveGateResult = { ok: true }

// ── 강제 게이트 predicate ─────────────────────────────────────────────────────

/**
 * 1b dangling — 대상 방이 그래프에 없으면 거부한다.
 *
 * spec §3.3가 gate 1 직후·나머지 앞에 배치한 확정 순서다(원본 command2.c:510의 dangling
 * 검사가 게이트 중반에 있으나, 대상 방 부재는 다른 어떤 방 게이트보다 선행해야 논리적이라
 * 스펙이 의도적으로 재정렬했다 — 되돌리지 않는다).
 */
export function danglingGate(input: MoveGateInput): MoveGateResult {
  return input.targetRoom === undefined ? { ok: false, reason: '그쪽으로 지도가 없습니다' } : PASS
}

/** 4 잠김 — 출구에 XLOCKD가 세팅됐으면 거부한다(command2.c:387). */
export function lockedGate(input: MoveGateInput): MoveGateResult {
  return hasFlag(input.exit.flags, XLOCKD) ? { ok: false, reason: '문이 잠겨 있습니다' } : PASS
}

/** 5 닫힘 — 출구에 XCLOSD가 세팅됐으면 거부한다(command2.c:391). */
export function closedGate(input: MoveGateInput): MoveGateResult {
  return hasFlag(input.exit.flags, XCLOSD) ? { ok: false, reason: '문이 닫혀 있습니다' } : PASS
}

/**
 * 7·8 시간 — 야간/주간 전용 출구를 게임시각(Time%24)으로 게이트한다.
 *
 * XNGHTO(야간전용)는 낮(6<t<20, command2.c:401)에 거부, XDAYON(주간전용)은 밤
 * (t<6 || t>20, :406)에 거부한다. 경계는 strict 비교로 원본 정합: XNGHTO는 t=7..19에서만
 * 거부(t=6·20 통과), XDAYON은 t<=5 또는 t>=21에서만 거부(t=6·20 통과). §3.3가 두 검사를
 * 한 시간 게이트 행(7·8)으로 묶으므로 XNGHTO를 먼저(원본 순서) 평가한다.
 */
export function timeGate(input: MoveGateInput): MoveGateResult {
  const t = input.currentHour
  if (hasFlag(input.exit.flags, XNGHTO) && t > 6 && t < 20) {
    return { ok: false, reason: '그 출구는 밤에만 열려 있습니다' }
  }
  if (hasFlag(input.exit.flags, XDAYON) && (t < 6 || t > 20)) {
    return { ok: false, reason: '그 출구는 밤에는 닫혀 있습니다' }
  }
  return PASS
}

/**
 * 17 정원 — 방 정원 플래그와 점유자 수를 대조해 만원이면 거부한다(command2.c:530).
 *
 * known deviation: 원본은 **가시 플레이어 수**(PINVIS 투명 플레이어 제외)로 판정하나,
 * 가시성 필터는 PINVIS(E5) 입력이 없어 여기서는 **전 점유자 카운트**(occupants.size)로
 * 근사한다. 투명 플레이어가 방에 있으면 원본보다 빨리 만원 판정될 수 있다 — E5 가시성
 * 필터 도입 후 정정한다.
 *
 * targetRoom undefined는 dangling 게이트가 선행 거부하므로 건틀릿 경로에선 도달 불가다.
 * 직접 호출 시의 방어로 undefined면 통과한다(부재를 만원으로 오판하지 않는다).
 */
export function capacityGate(input: MoveGateInput): MoveGateResult {
  const room = input.targetRoom
  if (room === undefined) return PASS
  const n = room.occupants.size
  const over =
    (hasFlag(room.flags, RONEPL) && n > 0) ||
    (hasFlag(room.flags, RTWOPL) && n > 1) ||
    (hasFlag(room.flags, RTHREE) && n > 2)
  return over ? { ok: false, reason: '그 방에 있는 사용자가 너무 많습니다' } : PASS
}

// ── 순서-유지 stub ────────────────────────────────────────────────────────────

/**
 * pass-through stub — 항상 통과한다. §3.3 순서상 자리를 지키되 강제하지 않는 게이트에 쓴다.
 * 입력을 읽지 않으므로 파라미터를 두지 않는다(tsc noUnusedParameters 게이트 회피).
 */
const passStub = (): MoveGateResult => PASS

// ── 건틀릿 배열 (spec §3.3 순서) ──────────────────────────────────────────────

/** 이름 붙은 게이트. name은 §3.3 행 식별자로 순서 검증에 노출된다. */
interface MoveGate {
  readonly name: string
  readonly evaluate: (input: MoveGateInput) => MoveGateResult
}

/**
 * 게이트 건틀릿 — spec §3.3 표 순서(1b~20)를 배열 순서로 인코딩한다. 각 stub 항목의 주석은
 * 실 강제를 붙일 대기 에픽이다. 시간(7·8)·성별(10·11)·레벨(15·16)·패거리결혼(18·19·20)은
 * §3.3가 묶은 행 단위로 한 항목씩 배치한다.
 */
const MOVE_GATE_GAUNTLET: readonly MoveGate[] = [
  { name: 'dangling', evaluate: danglingGate }, // 1b 강제
  { name: '침묵', evaluate: passStub }, // 2 PSILNC — E5
  { name: '전투', evaluate: passStub }, // 3 ply_is_attacking — E6
  { name: 'XLOCKD', evaluate: lockedGate }, // 4 강제
  { name: 'XCLOSD', evaluate: closedGate }, // 5 강제
  { name: '비행', evaluate: passStub }, // 6 XFLYSP — E5/E6
  { name: '시간', evaluate: timeGate }, // 7·8 XNGHTO/XDAYON 강제(G2)
  { name: '경비', evaluate: passStub }, // 9 XPGUAR+MPGUAR — E4-2
  { name: '성별', evaluate: passStub }, // 10·11 XFEMAL/XMALES — E5
  { name: '무소지', evaluate: passStub }, // 12 XNAKED — E5/E6
  { name: '등반', evaluate: passStub }, // 13 XCLIMB/XREPEL — E5/E6
  { name: '은신', evaluate: passStub }, // 14 은신 유지 — E5/E6
  { name: '레벨', evaluate: passStub }, // 15·16 lolevel/hilevel — E5
  { name: '정원', evaluate: capacityGate }, // 17 강제(근사)
  { name: '패거리결혼', evaluate: passStub }, // 18·19·20 RFAMIL/RONFML/RONMAR — E5/E7
]

/** 건틀릿 게이트 이름을 §3.3 순서대로 나열한다 — 순서 검증 테스트에 노출한다. */
export const MOVE_GATE_ORDER: readonly string[] = MOVE_GATE_GAUNTLET.map((gate) => gate.name)

/**
 * 이동 게이트 건틀릿을 순차 평가한다. §3.3 순서대로 각 게이트를 호출하고, 첫 거부에서
 * 즉시 정지해 그 거부 결과를 반환한다. 모든 게이트를 통과하면 { ok: true }를 반환한다.
 * 순수 함수 — 입력을 변형하지 않는다.
 */
export function evaluateMoveGates(input: MoveGateInput): MoveGateResult {
  for (const gate of MOVE_GATE_GAUNTLET) {
    const result = gate.evaluate(input)
    if (!result.ok) return result
  }
  return PASS
}
