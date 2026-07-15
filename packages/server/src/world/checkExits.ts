import type { RoomNode } from 'shared'
import { hasFlag, setFlag, XLOCKD, XCLOSD, XLOCKS, XCLOSS } from './door.js'
import type { WorldTickSlot } from './worldClock.js'

/**
 * check_exits 스윕 — 출구 타이머 자동 재잠금/재닫힘을 WorldClock 슬롯으로 이식한 순수 팩토리.
 *
 * oracle `docs/notes/game-analysis-20260625/a4-movement-rooms.md` §3(room.c:469) 이식:
 *   `check_exits()`는 `XLOCKS`/`XCLOSS`(능력) 출구가 `ltime + interval < now`이면 자동으로
 *   `XLOCKD`/`XCLOSD`(상태)를 재설정한다. 즉 열고 들어간 문은 interval초 후 다시 닫히고
 *   잠긴다 — 출구의 `ltime`이 이 타이밍을 인코딩한다(A1 lasttime 모델과 동형).
 *
 * 두 조건은 원본대로 `if / else if`로 배타 평가한다(room.c:469):
 *   - 만료된 `XLOCKS` → `XLOCKD` **와** `XCLOSD`를 **둘 다** 설정한다(잠긴 문은 닫힌 문이기도
 *     하다 — 잠금은 닫힘을 함의). XLOCKS 분기가 잡히면 XCLOSS는 별도로 평가하지 않는다.
 *   - 만료된 `XCLOSS`(단, XLOCKS 아님) → `XCLOSD`만 설정한다.
 *   원본은 XLOCKS-only 만료 시 XCLOSD도 세팅해 "잠겼지만 열린" 모순 상태를 만들지 않는다.
 *
 * Story 3 문 전이(lock/closeexit)와의 차이 — 타이머 강제 재설정:
 *   `lock`은 XLOCKS + XCLOSD(먼저 닫힘) + 열쇠 일치를 전제하고, `closeexit`은 XCLOSS를
 *   전제한다. 그러나 타이머 재설정은 그런 전제 없이 능력 비트 + 만료만으로 flags를 되돌린다
 *   (room.c:469 충실). 따라서 여기서 lock/closeexit 전이를 재사용하지 않고 setFlag를 직접 쓴다.
 *
 * 가변성(immutability) carve-out — 프로젝트 CRITICAL immutability 규칙의 의도된 예외:
 *   스윕은 라이브 문 상태(`exit.flags` 바이트)를 in-place로 변경한다. door.ts setFlag와 동일
 *   관례이며, worldGraph 타입 주석(ExitEdge.flags는 라이브 가변)과 정합한다. 그 외 어떤 입력도
 *   변형하지 않는다(ltime은 재설정하지 않는다 — 재설정은 open/unlock만 담당).
 *
 * 시간 기준 — WorldClock 단조 tick(초):
 *   `now`를 `run(tickSec)`의 tickSec에서 취한다. 시간 기반이 WorldClock의 단조 tick(초)이며,
 *   실 배선에서 door 전이(openexit/unlock)의 `now`도 같은 tick 기반이 된다. WS 명령 배선으로
 *   문 전이와 이 스윕을 하나의 tick 시계에 얹는 것은 E4-1b 범위 밖(후속 토픽)이다.
 */

/**
 * 그래프를 클로저로 캡처하는 checkExits 슬롯 팩토리(생성자 주입, 전역 금지).
 *
 * `intervalSec = 1`로 매 틱 평가한다. `run(tickSec)`은 `now = tickSec`으로 그래프 모든 방의
 * 모든 출구를 순회하며, 각 출구에 대해 XLOCKS·XCLOSS를 원본대로 `if / else if`로 배타 평가해
 * 만료면(`ltime + interval < now`, strict less-than) 해당 상태 비트를 재설정한다.
 */
export function createCheckExitsSlot(graph: Map<number, RoomNode>): WorldTickSlot {
  return {
    name: 'checkExits',
    intervalSec: 1,
    run(tickSec: number): void {
      const now = tickSec
      for (const room of graph.values()) {
        for (const exit of room.exits) {
          // 만료 판정 — strict less-than(room.c:469). now == ltime+interval이면 아직 만료 아님.
          const expired = exit.ltime + exit.interval < now
          if (expired && hasFlag(exit.flags, XLOCKS)) {
            // XLOCKS(잠글 수 있음) 만료 → XLOCKD·XCLOSD 둘 다 재설정(잠금은 닫힘을 함의).
            setFlag(exit.flags, XLOCKD)
            setFlag(exit.flags, XCLOSD)
          } else if (expired && hasFlag(exit.flags, XCLOSS)) {
            // XCLOSS(닫을 수 있음, XLOCKS 아님) 만료 → XCLOSD(닫힘)만 재설정.
            setFlag(exit.flags, XCLOSD)
          }
        }
      }
    },
  }
}
