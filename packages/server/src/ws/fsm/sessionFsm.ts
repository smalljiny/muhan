import { clientCommandSchema, type ServerEvent } from 'shared'
import type { AccountIdentity, SessionAuthPort } from '../../auth/sessionAuthPort.js'
import { OwnershipError } from '../../auth/sessionAuthPort.js'

/**
 * 세션 FSM — 원작 `io->fn` 함수 포인터 상태머신을 대체하는 연결 상태 머신.
 *
 * 3층 아키텍처로 functional-core/imperative-shell를 확장한다:
 *  1층 순수 decider(`decideCharacterSelectInput`): (상태 기준) 프레임→결정. 포트·emit·소켓 없음.
 *  2층 StateHandler(`stateHandlers`의 onEnter/handleInput): 포트를 호출하고 이벤트를 주입 `emit`으로만
 *      내보낸다(소켓 직접 접근 금지). 시드 어댑터 + 배열 수집 emit으로 소켓 없이 검증한다.
 *  3층 배선(`applyTransition`·`enterInitialState`·`handleSessionFrame`): ctx.state를 단일 지점에서
 *      변이하고 enter/exit 콜백을 구동한다. plugin의 message 핸들러(셸)가 emit=safeSend를 주입해 호출한다.
 */

/**
 * 연결 상태 — 원작 `io->fn`이 가리키던 상태별 처리기를 enum으로 대체한다.
 *
 * characterSelect: 핸드셰이크 완료 직후 진입점. 캐릭터 목록·선택 prompt를 제시하고 선택을 받는다.
 * create: 캐릭터 생성 다단 대화(Story 5에서 채운다). 현재는 스텁.
 * command: 월드 진입 후 명령 라우팅 상태. 이 상태의 프레임은 셸이 라우터(dispatch)로 위임한다.
 */
export enum ConnectionState {
  characterSelect = 'characterSelect',
  create = 'create',
  command = 'command',
}

/** characterSelect 단계의 결정적 promptId. Story 5의 create 다단은 counter 기반 규약으로 확장한다. */
export const SELECT_CHARACTER_PROMPT_ID = 'session:select-character'

/**
 * StateHandler가 포트 호출·이벤트 발화에 쓰는 세션 컨텍스트.
 *
 * `account`는 게이트가 확정한 계정 신원(핸들러 최상단에서 셸이 1회 narrow해 non-null 보장).
 * `sessionAuth`는 캐릭터 목록·소유권 포트. `emit`은 주입된 이벤트 수집 콜백 — 핸들러는 소켓을 직접
 * 만지지 않고 이 콜백으로만 이벤트를 내보낸다. 셸은 `emit = (e) => safeSend(socket, e)`로, 테스트는
 * 배열 push로 배선한다.
 */
export interface SessionContext {
  readonly account: AccountIdentity
  readonly sessionAuth: SessionAuthPort
  readonly emit: (event: ServerEvent) => void
}

/**
 * 상태별 처리기 — 전이 부수효과를 enter/exit 콜백에 담는다(디스패치 루프 인라인 금지).
 *
 * `onEnter`는 상태 진입 시(applyTransition·enterInitialState) 1회 구동돼 초기 이벤트를 발화한다.
 * `handleInput`은 그 상태에서 받은 프레임을 처리하고 다음 상태를 반환한다(같은 상태 반환=유지).
 * `onExit`은 상태 이탈 시 구동된다(현재 사용처 없음, Story 5·6 seam).
 */
export interface StateHandler {
  onEnter?(session: SessionContext): void
  handleInput(session: SessionContext, frame: unknown): ConnectionState
  onExit?(session: SessionContext): void
}

/** applyTransition·enterInitialState가 변이하는 최소 컨텍스트. ConnectionContext가 구조적으로 충족한다. */
export interface FsmContext {
  state: ConnectionState
}

/**
 * characterSelect 프레임 해석 결정 — 1층 순수 decider의 출력.
 *
 * `select.nextState`는 프레임이 *요청한* 전이 목적지(command)다. 실제 전이는 2층 handleInput이
 * `assertOwnership` 포트 게이트를 통과해야 확정되며, 소유 불일치면 command 대신 현 상태를 유지한다
 * (요청 전이 ≠ 확정 전이 — 포트 게이트 대상). decider 자체는 순수하다(포트·emit 없음).
 */
export type CharacterSelectDecision =
  | { readonly kind: 'select'; readonly characterId: string; readonly nextState: ConnectionState.command }
  | { readonly kind: 'reject'; readonly code: 'session_state' }

/**
 * 1층 순수 decider — characterSelect 상태에서 프레임을 해석한다(포트·emit·소켓 없음).
 *
 * router의 strict 파싱을 미러한다: `clientCommandSchema.safeParse` + 세션 variant narrow로만 판별하고
 * 필드를 hand-parse하지 않는다(우회 표면 재도입 금지). session:selectCharacter로 좁혀지면 select,
 * 그 외(미지 type·payload 위반·다른 상태의 명령·비객체)는 모두 session_state reject다.
 */
export function decideCharacterSelectInput(frame: unknown): CharacterSelectDecision {
  const parsed = clientCommandSchema.safeParse(frame)
  if (parsed.success && parsed.data.type === 'session:selectCharacter') {
    return { kind: 'select', characterId: parsed.data.characterId, nextState: ConnectionState.command }
  }
  return { kind: 'reject', code: 'session_state' }
}

/** session_state error 이벤트를 만든다(현재 상태에서 허용되지 않는 프레임). */
function sessionStateError(message: string): ServerEvent {
  return { type: 'error', code: 'session_state', message }
}

/**
 * 2층 characterSelect StateHandler.
 *
 * onEnter: 계정 캐릭터 목록을 조회해 characterList + 선택 prompt를 발화한다.
 * handleInput: decider로 프레임을 해석하고, select면 소유권을 포트로 검증해 통과 시 entered 발화 +
 * command 전이, OwnershipError면 unauthorized error + 상태 유지, reject면 session_state error + 유지.
 */
const characterSelectHandler: StateHandler = {
  onEnter(session) {
    const characters = session.sessionAuth.listCharacters(session.account.accountId)
    session.emit({ type: 'session:characterList', characters })
    session.emit({ type: 'session:prompt', promptId: SELECT_CHARACTER_PROMPT_ID, kind: 'selectCharacter' })
  },
  handleInput(session, frame) {
    const decision = decideCharacterSelectInput(frame)
    if (decision.kind === 'reject') {
      session.emit(sessionStateError('현재 세션 단계에서 허용되지 않는 명령이다'))
      return ConnectionState.characterSelect
    }

    try {
      session.sessionAuth.assertOwnership(session.account.accountId, decision.characterId)
    } catch (error) {
      if (error instanceof OwnershipError) {
        session.emit({ type: 'error', code: 'unauthorized', message: '해당 캐릭터에 대한 권한이 없다' })
        return ConnectionState.characterSelect
      }
      throw error
    }

    session.emit({ type: 'session:entered', characterId: decision.characterId })
    return decision.nextState
  },
}

/**
 * 스텁 StateHandler 팩토리 — 아직 처리기가 없는 상태(create·command)의 자리표.
 *
 * create는 Story 5의 생성 다단 대화가 교체한다. command는 셸이 프레임을 라우터(dispatch)로 위임하므로
 * FSM handleInput이 실제로 도달하지 않지만, `Record<ConnectionState, StateHandler>` 완전성을 위해 둔다.
 * 어느 경우든 도달하면 session_state error로 응답하고 상태를 유지한다(조용한 no-op 방지).
 */
function stubHandler(state: ConnectionState): StateHandler {
  return {
    handleInput(session) {
      session.emit(sessionStateError('현재 세션 단계에서 처리할 수 없는 명령이다'))
      return state
    },
  }
}

/** 상태 → 처리기 배선표. 전이 부수효과는 각 처리기의 enter/exit·handleInput에 담긴다. */
export const stateHandlers: Record<ConnectionState, StateHandler> = {
  [ConnectionState.characterSelect]: characterSelectHandler,
  [ConnectionState.create]: stubHandler(ConnectionState.create),
  [ConnectionState.command]: stubHandler(ConnectionState.command),
}

/**
 * ctx.state를 대입하고 목적 상태의 onEnter를 구동하는 단일 지점.
 *
 * ctx.state 대입은 이 함수에서만 일어난다(Lock D — Story 6 데드라인 reaper가 매 진입마다 여기 훅한다).
 * applyTransition·enterInitialState가 모두 이 함수를 거쳐 진입 부수효과를 일원화한다.
 */
function enterState(ctx: FsmContext, session: SessionContext, state: ConnectionState): void {
  ctx.state = state
  stateHandlers[state].onEnter?.(session)
}

/**
 * 3층 전이 적용 — handleInput이 반환한 다음 상태로 전이한다.
 *
 * 같은 상태면 no-op이라 onEnter를 재구동하지 않는다(reject·유지 시 초기 이벤트 재발화 방지).
 * 다르면 현 상태 onExit → enterState(대입 + 다음 onEnter) 순으로 구동한다.
 */
export function applyTransition(ctx: FsmContext, session: SessionContext, next: ConnectionState): void {
  if (next === ctx.state) return
  stateHandlers[ctx.state].onExit?.(session)
  enterState(ctx, session, next)
}

/**
 * accept(핸드셰이크 완료) 시 characterSelect로 진입시킨다.
 *
 * 셸이 같은 message-handler 턴에 동기 호출해 characterList + prompt를 즉시 발화하게 한다(setImmediate 금지).
 * ctx.state 초기값이 이미 characterSelect라도 enterState로 대입·onEnter를 명시 구동해 진입 부수효과를 낸다.
 */
export function enterInitialState(ctx: FsmContext, session: SessionContext): void {
  enterState(ctx, session, ConnectionState.characterSelect)
}

/**
 * 3층 결합 — 현재 상태 처리기로 프레임을 처리하고 그 결과 상태로 전이한다.
 *
 * 셸(plugin)이 command 이전 상태의 pass 프레임에 대해 호출한다. handleInput이 이벤트를 emit하고 다음
 * 상태를 반환하면 applyTransition이 전이를 확정한다.
 */
export function handleSessionFrame(ctx: FsmContext, session: SessionContext, frame: unknown): void {
  const next = stateHandlers[ctx.state].handleInput(session, frame)
  applyTransition(ctx, session, next)
}
