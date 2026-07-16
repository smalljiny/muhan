import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from 'shared'
import type { AccountIdentity } from '../auth/sessionAuthPort.js'
import { ConnectionState, type CreateProgress } from './fsm/sessionFsm.js'
import type { Deadline } from './deadline.js'
import type { ConnectionRateLimiter } from './messageRateLimiter.js'

/**
 * per-connection 컨텍스트 — 소켓 하나의 수명 동안 유지되는 transport 상태.
 *
 * `protocolVersion`은 핸드셰이크(Story 4)가 대조에 쓸 계약 세대(서버 권위, 불변). `ready`는 핸드셰이크
 * 완료 여부로, 첫 `system:ready`가 서버 버전과 일치하면 true로 전이한다(연결당 1회). `heartbeat`는
 * 하트비트 타이머 슬롯으로, Story 5-6이 여기에 ping 타이머 핸들을 대입한다(현재는 미채움, 초기값 null).
 * `account`는 preValidation 게이트가 확정한 계정 신원으로, upgrade 성공 시 소켓 핸들러가 `req.account`를
 * 여기 대입한다(초기값 null — 게이트 통과 전이거나 배선 오류 시 null). `state`는 세션 FSM의 현재 상태로,
 * 핸드셰이크 완료(accept) 전엔 FSM 미진입이라 초기값 characterSelect를 두되 onEnter는 accept 시 구동한다
 * (`ready` 플래그가 진입 전/후를 구분). `createProgress`는 create 다단 대화의 서브상태 슬롯으로, create
 * 상태 밖에선 null이다(create.onEnter가 초기화, onExit가 정리). SessionContext가 매 프레임 재조립되므로
 * 대화 상태는 소켓 수명 동안 유지되는 이 컨텍스트에 둔다. `boundCharacterId`는 이 연결이 세션 레지스트리에
 * 등록한 캐릭터 id(월드 입장 시 `register`/`rebind`가 대입, 그 전엔 null)로, close 핸들러가 이 값으로
 * 자신의 세션 바인딩을 역참조해 link-dead/종결 경로를 판정한다(레지스트리는 소켓이 아니라 이 컨텍스트를
 * 가리키므로 역방향 열쇠가 필요하다). `ready`·`heartbeat`·`account`·`state`·`createProgress`·
 * `boundCharacterId`는 소켓 수명 동안 갱신되는 mutable 슬롯이라 `readonly`를 두지 않는다.
 *
 * `deadline`은 하트비트(물리 생존)와 **별도** 진행 데드라인 슬롯(논리 진행, Story 6)이다. 셸이 연결 수락 시
 * createDeadline 핸들을 대입하고, FSM이 주입 콜백(rearm/clear)으로 조작한다. cleanup이 clear로 누수를 막는다.
 *
 * `idle`은 월드 입장 후 무입력(idle) 종료를 감시하는 슬롯(Story 6이 팩토리로 arm한다)이다. 여기서는 슬롯과
 * 최소 인터페이스만 정의하고 초기값 null로 둔다 — resolveDisconnect·cleanupConnection이 종결 시 `clear`로
 * 누수를 막는다(팩토리 arming 전까지 항상 null이라 clear는 no-op).
 *
 * `rateLimiter`는 인바운드 프레임 유량 제한 핸들 슬롯이다. 소켓 open 시 팩토리가 이 연결의 핸들을 대입하고
 * (deadline/idle과 달리 arm은 handshake가 아니라 open 시점이라 pre-handshake 창도 제한된다), message 핸들러가
 * 프레임마다 `check(now)`로 verdict를 받아 gate한다. cleanup은 이 슬롯을 null로 비운다 — heartbeat/deadline/idle과
 * 달리 clear할 타이머가 없고(순수 회계), 계정 버킷 반납은 별도 close 리스너가 소유하므로 여기서는 슬롯만 정리한다.
 */
export interface ConnectionContext {
  readonly protocolVersion: number
  ready: boolean
  heartbeat: NodeJS.Timeout | null
  deadline: Deadline | null
  idle: IdleTimer | null
  rateLimiter: ConnectionRateLimiter | null
  account: AccountIdentity | null
  state: ConnectionState
  createProgress: CreateProgress | null
  boundCharacterId: string | null
  // 소켓 close 발화 여부. 포트 호출이 async가 된 뒤(Story 4) FSM이 포트 await로 멈춘 사이 소켓이 닫히면
  // 'close' 핸들러(frameTail 큐와 별개 리스너)가 이 플래그를 세운다. await 재개 후 FSM은 이 플래그로 죽은 연결에
  // 대한 월드 등록(register)·command 상태 대입·데드라인 rearm 같은 부수효과를 건너뛴다(좀비 바인딩·형제 evict 방지).
  closed: boolean
  // per-connection 프레임 직렬화 큐의 tail promise. message 핸들러가 이제 async 경로(FSM·핸드셰이크 accept)를
  // 태울 수 있어, ws가 리스너를 await하지 않는 이상 프레임 2의 'message'가 프레임 1의 await 도중 시작돼 공유
  // 상태(state·createProgress·deadline)를 동시 변이할 수 있다. 각 프레임 처리를 이 tail에 .then으로 체이닝해
  // 프레임 N+1이 프레임 N 완결 뒤에만 시작하도록 강제한다. 소켓 수명 동안 유지돼야 하므로(리스너 로컬은 프레임
  // 간 소멸) 여기 둔다. 초기값은 즉시 resolve된 Promise다.
  frameTail: Promise<void>
}

/**
 * idle(무입력) 타이머 핸들의 최소 표면. `arm`은 타이머를 (재)설정하고, `clear`는 idempotent 해제다.
 * 팩토리 구현은 Story 6이 붙인다 — 여기서는 종결 경로(resolveDisconnect·cleanupConnection)가 slot을
 * clear할 수 있도록 타입만 먼저 고정한다(Deadline 인터페이스 관례 미러).
 */
export interface IdleTimer {
  arm(): void
  clear(): void
}

/**
 * 새 연결의 초기 컨텍스트를 만든다. 핸드셰이크·계정 대입 이전이므로 `ready`는 false·`account`는 null.
 * `state`는 characterSelect로 두되 FSM 진입(onEnter)은 accept 시점에 일어난다(ready 플래그로 구분).
 */
export function createConnectionContext(): ConnectionContext {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ready: false,
    heartbeat: null,
    deadline: null,
    idle: null,
    rateLimiter: null,
    account: null,
    state: ConnectionState.characterSelect,
    createProgress: null,
    boundCharacterId: null,
    closed: false,
    frameTail: Promise.resolve(),
  }
}

/**
 * 연결 종료 시 per-connection 리소스를 정리한다.
 *
 * `heartbeat` 슬롯에 남은 ping 타이머를 clear해 누수를 막고(방어선), 레지스트리에서 컨텍스트를 제거한다.
 * 하트비트 매니저의 `stop()`도 같은 타이머를 정리하지만, 어느 경로로 close되더라도 타이머가 살아남지
 * 않도록 여기서 한 번 더 clear한다(clearInterval은 idempotent). `deadline` 슬롯의 진행 데드라인 타이머도
 * 같은 방어선으로 clear한다(deadline.clear는 idempotent) — 하트비트와 나란히 정리해 누수를 막는다.
 * `idle` 슬롯의 무입력 타이머(Story 6)도 같은 방어선으로 clear한다.
 */
export function cleanupConnection(
  connections: Map<WebSocket, ConnectionContext>,
  socket: WebSocket,
): void {
  const ctx = connections.get(socket)
  if (ctx?.heartbeat != null) {
    clearInterval(ctx.heartbeat)
    ctx.heartbeat = null
  }
  if (ctx?.deadline != null) {
    ctx.deadline.clear()
    ctx.deadline = null
  }
  // idle 타이머 슬롯도 같은 방어선으로 clear한다(clear는 idempotent). 팩토리는 Story 6이라 현재는 항상 null.
  if (ctx?.idle != null) {
    ctx.idle.clear()
    ctx.idle = null
  }
  // rateLimiter 슬롯은 null로 비우기만 한다 — 순수 회계 핸들이라 clear할 타이머가 없어(heartbeat/deadline/idle과
  // 달리 null 전 부수효과가 없다) 무조건 대입으로 충분하다. 계정 버킷 반납은 별도 close 리스너(releaseAccount)가
  // 소유한다(여기서 반납하면 이중 감소로 형제 연결의 계정 엔트리를 지운다).
  if (ctx) ctx.rateLimiter = null
  connections.delete(socket)
}
