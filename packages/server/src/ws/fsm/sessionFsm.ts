import { z } from 'zod'
import { clientCommandSchema, type ServerEvent } from 'shared'
import type {
  AccountIdentity,
  CreateCharacterInput,
  SessionAuthPort,
} from '../../auth/sessionAuthPort.js'
import { OwnershipError } from '../../auth/sessionAuthPort.js'

/**
 * 세션 FSM — 원작 `io->fn` 함수 포인터 상태머신을 대체하는 연결 상태 머신.
 *
 * 3층 아키텍처로 functional-core/imperative-shell를 확장한다:
 *  1층 순수 decider(`decideCharacterSelectInput`·`decideCreateInput`): (상태 기준) 프레임→결정.
 *      포트·emit·소켓 없음. plain-data 입력→결정으로 단위 테스트한다.
 *  2층 StateHandler(`stateHandlers`의 onEnter/handleInput): 포트를 호출하고 이벤트를 주입 `emit`으로만
 *      내보낸다(소켓 직접 접근 금지). 시드 어댑터 + 배열 수집 emit으로 소켓 없이 검증한다. create 핸들러는
 *      대화 상태(`ctx.createProgress`)를 읽고 써야 하므로 `FsmContext`도 인자로 받는다.
 *  3층 배선(`applyTransition`·`enterInitialState`·`handleSessionFrame`): ctx.state를 단일 지점에서
 *      변이하고 enter/exit 콜백을 구동한다. plugin의 message 핸들러(셸)가 emit=safeSend를 주입해 호출한다.
 */

/**
 * 연결 상태 — 원작 `io->fn`이 가리키던 상태별 처리기를 enum으로 대체한다.
 *
 * characterSelect: 핸드셰이크 완료 직후 진입점. 캐릭터 목록·선택 prompt를 제시하고 선택을 받는다.
 * create: 캐릭터 생성 다단 대화(이름→클래스→종족→확인 서브상태). 서브상태는 `ctx.createProgress`에 산다.
 * command: 월드 진입 후 명령 라우팅 상태. 이 상태의 프레임은 셸이 라우터(dispatch)로 위임한다.
 */
export enum ConnectionState {
  characterSelect = 'characterSelect',
  create = 'create',
  command = 'command',
}

/** characterSelect 단계의 결정적 promptId. */
export const SELECT_CHARACTER_PROMPT_ID = 'session:select-character'

/**
 * characterSelect의 select prompt에 대한 "새 캐릭터 생성" 신호값. 클라가 select prompt에
 * `session:reply{promptId: SELECT_CHARACTER_PROMPT_ID, value: CREATE_SENTINEL}`로 답하면 create로 전이한다.
 */
export const CREATE_SENTINEL = 'create'

/** confirm 단계의 승인 값. 클라가 confirm prompt에 이 값으로 답해야 캐릭터 생성이 확정된다. */
export const CREATE_CONFIRM_VALUE = 'yes'

/**
 * create 서브상태별 고정 promptId 규약 — 선형 유한 흐름(이름→클래스→종족→확인)이라 counter 없이
 * step→promptId 고정 맵으로 충분하다. `ctx.createProgress.step`을 저장하고 여기서 기대 promptId를
 * 파생한다(step만 저장, promptId는 파생 — derivable-state 중복 저장 금지). reply.promptId가 현재 step의
 * promptId와 불일치하면(미일치·지나간 step의 stale reply) 거부한다.
 */
export const CREATE_PROMPT_IDS = {
  name: 'create:name',
  class: 'create:class',
  race: 'create:race',
  confirm: 'create:confirm',
} as const

/** create 대화의 서브상태 단계. CREATE_PROMPT_IDS 키와 1:1 대응한다. */
export type CreateStep = keyof typeof CREATE_PROMPT_IDS

/** create 진행 중 누적되는 필드(서버 권위 — 클라 reply로 왕복시키지 않는다). */
export interface CreateCollected {
  name?: string
  class?: number
  race?: number
}

/** create 서브상태 — 현재 단계와 지금까지 누적한 필드. `ctx.createProgress`에 산다(create 밖에선 null). */
export interface CreateProgress {
  step: CreateStep
  collected: CreateCollected
}

/**
 * StateHandler가 포트 호출·이벤트 발화에 쓰는 세션 컨텍스트.
 *
 * `account`는 게이트가 확정한 계정 신원(핸들러 최상단에서 셸이 1회 narrow해 non-null 보장).
 * `sessionAuth`는 캐릭터 목록·생성·소유권 포트. `emit`은 주입된 이벤트 수집 콜백 — 핸들러는 소켓을 직접
 * 만지지 않고 이 콜백으로만 이벤트를 내보낸다. 셸은 `emit = (e) => safeSend(socket, e)`로, 테스트는
 * 배열 push로 배선한다. 대화 상태(createProgress)는 여기 두지 않는다 — 셸이 매 프레임 재조립하므로
 * 소켓 수명 동안 유지되는 `FsmContext`에 둔다.
 */
export interface SessionContext {
  readonly account: AccountIdentity
  readonly sessionAuth: SessionAuthPort
  readonly emit: (event: ServerEvent) => void
  // 진행 데드라인 seam(Story 6) — emit을 미러한 주입 부수효과 콜백. required(optional 금지)라 주입 누락 시
  // 컴파일에서 걸린다(silent DoS 방지: 주입을 빠뜨리면 데드라인이 설정되지 않아 미진행 연결이 영구 잔존).
  // 셸은 createDeadline 핸들의 rearm/clear로, 테스트는 vi.fn() 스파이로 배선한다. 상태 전이·create 서브상태
  // 전진마다 rearmDeadline이, command(in-world) 도달 시 clearDeadline이 호출된다.
  readonly rearmDeadline: () => void
  readonly clearDeadline: () => void
  // 월드 진입 등록 seam(Story 5, emit·rearmDeadline 미러). enterCommand가 이 콜백으로 세션 레지스트리에
  // 등록/재연결하고 그 outcome으로 발화할 이벤트를 고른다. 셸은 createSessionLifecycle.enterWorld를 이 ctx에
  // 바인딩해 주입하고, 테스트는 vi.fn()으로 배선한다. required(optional 금지)라 주입 누락 시 컴파일에서 걸린다
  // (배선을 빠뜨리면 월드 진입이 레지스트리에 등록되지 않아 재연결·evict가 무력화된다).
  readonly enterWorld: (characterId: string) => 'entered' | 'resumed'
}

/**
 * applyTransition·enterInitialState·서브스텝 진행이 변이하는 최소 컨텍스트. ConnectionContext가 구조적으로
 * 충족한다. `state`는 FSM 현재 상태, `createProgress`는 create 대화 서브상태(create 밖에선 null)다.
 */
export interface FsmContext {
  state: ConnectionState
  createProgress: CreateProgress | null
}

/**
 * 상태별 처리기 — 전이 부수효과를 enter/exit 콜백에 담는다(디스패치 루프 인라인 금지).
 *
 * `onEnter`는 상태 진입 시(applyTransition·enterInitialState) 1회 구동돼 초기 이벤트를 발화한다.
 * `handleInput`은 그 상태에서 받은 프레임을 처리하고 다음 상태를 반환한다(같은 상태 반환=유지).
 * `onExit`은 상태 이탈 시 구동된다(create가 createProgress를 정리한다). 모든 콜백은 `FsmContext`를 받아
 * 대화 상태에 접근한다 — 무상태 핸들러(characterSelect·command)는 ctx를 읽지 않는다.
 */
export interface StateHandler {
  onEnter?(ctx: FsmContext, session: SessionContext): void
  handleInput(ctx: FsmContext, session: SessionContext, frame: unknown): ConnectionState
  onExit?(ctx: FsmContext, session: SessionContext): void
}

/**
 * characterSelect 프레임 해석 결정 — 1층 순수 decider의 출력.
 *
 * `select.nextState`는 프레임이 *요청한* 전이 목적지(command)다. 실제 전이는 2층 handleInput이
 * `assertOwnership` 포트 게이트를 통과해야 확정되며, 소유 불일치면 command 대신 현 상태를 유지한다
 * (요청 전이 ≠ 확정 전이 — 포트 게이트 대상). `create`는 select prompt에 CREATE_SENTINEL로 답한 신호로,
 * create 상태 진입을 요청한다. decider 자체는 순수하다(포트·emit 없음).
 */
export type CharacterSelectDecision =
  | { readonly kind: 'select'; readonly characterId: string; readonly nextState: ConnectionState.command }
  | { readonly kind: 'create'; readonly nextState: ConnectionState.create }
  | { readonly kind: 'reject'; readonly code: 'session_state' }

/**
 * 1층 순수 decider — characterSelect 상태에서 프레임을 해석한다(포트·emit·소켓 없음).
 *
 * router의 strict 파싱을 미러한다: `clientCommandSchema.safeParse` + 세션 variant narrow로만 판별하고
 * 필드를 hand-parse하지 않는다(우회 표면 재도입 금지). session:selectCharacter로 좁혀지면 select,
 * SELECT_CHARACTER_PROMPT_ID에 CREATE_SENTINEL로 답한 session:reply면 create, 그 외(미지 type·payload
 * 위반·다른 상태의 명령·비객체·다른 promptId·다른 value의 reply)는 모두 session_state reject다.
 */
export function decideCharacterSelectInput(frame: unknown): CharacterSelectDecision {
  const parsed = clientCommandSchema.safeParse(frame)
  if (parsed.success) {
    if (parsed.data.type === 'session:selectCharacter') {
      return { kind: 'select', characterId: parsed.data.characterId, nextState: ConnectionState.command }
    }
    if (
      parsed.data.type === 'session:reply' &&
      parsed.data.promptId === SELECT_CHARACTER_PROMPT_ID &&
      parsed.data.value === CREATE_SENTINEL
    ) {
      return { kind: 'create', nextState: ConnectionState.create }
    }
  }
  return { kind: 'reject', code: 'session_state' }
}

/**
 * create 프레임 해석 결정 — 1층 순수 create reducer의 출력.
 *
 * `advance`는 현재 단계 값을 검증·누적하고 `nextStep`으로 전진하라는 결정(다음 prompt는 핸들러가
 * `nextStep`에서 파생 발화 — promptId를 step에서 파생하는 규약과 동일, 결정에 중복 저장하지 않는다).
 * `complete`는 확인 통과 후 검증된 dto로 캐릭터를 생성하라는 결정. `reject`는 상관 실패(promptId 미일치·
 * 미해결)·값 검증 실패로, 핸들러가 현재 단계를 유지한 채 session_state error만 발화한다.
 */
export type CreateDecision =
  | { readonly kind: 'reject'; readonly code: 'session_state' }
  | {
      readonly kind: 'advance'
      readonly nextStep: CreateStep
      readonly collected: CreateCollected
    }
  | { readonly kind: 'complete'; readonly dto: CreateCharacterInput }

/**
 * 이름 검증 — 앞뒤 공백을 제거한 뒤 비어있지 않아야 하고(공백만 있는 이름 거부), 상한을 둔다.
 * 상한 40은 원작 creature name 필드(80바이트 EUC-KR, 한글 2바이트 ≈ 40자)를 기준으로 한 방어적
 * 캡이다 — 무한 길이 이름이 E5 영속 계층까지 미절단으로 도달하는 것을 막는다(프레임 64KB 캡의
 * 세분화). 확정 영속 스키마가 서면 그 값과 정합시킨다.
 */
const createNameSchema = z.string().trim().min(1).max(40)

/** class/race 검증·변환 — reply.value(string)를 정수로 강제 변환한다(비정수·비수치 거부). */
const createIntSchema = z.coerce.number().int()

/** 최종 dto 검증 — createCharacter 호출 전 누적 필드가 완성됐는지 확인한다(BLOCKER 2). */
const createDtoSchema = z.object({
  name: createNameSchema,
  class: z.int(),
  race: z.int(),
})

/** create 서브상태 prompt 이벤트를 만든다(step → 고정 promptId·createField kind). */
function createFieldPrompt(step: CreateStep): ServerEvent {
  return { type: 'session:prompt', promptId: CREATE_PROMPT_IDS[step], kind: 'createField' }
}

/**
 * 1층 순수 create reducer — 현재 progress를 기준으로 프레임을 해석한다(포트·emit·소켓 없음, ctx 미변이).
 *
 * Lock C: `clientCommandSchema.safeParse` + `session:reply` narrow로만 판별한다(hand-parse 금지).
 * Q3 상관: reply.promptId가 현재 step의 고정 promptId와 불일치하면 reject(미일치·stale reply 거부).
 * BLOCKER 2: 각 단계 값을 Zod로 검증·변환하고, confirm에서 누적 dto를 최종 검증한다. 무효 값은 reject로
 * 돌려 핸들러가 현재 단계를 유지하게 한다(클라가 같은 prompt에 재응답 가능).
 */
export function decideCreateInput(progress: CreateProgress, frame: unknown): CreateDecision {
  const parsed = clientCommandSchema.safeParse(frame)
  if (!parsed.success || parsed.data.type !== 'session:reply') {
    return { kind: 'reject', code: 'session_state' }
  }
  const replyFrame = parsed.data
  if (replyFrame.promptId !== CREATE_PROMPT_IDS[progress.step]) {
    return { kind: 'reject', code: 'session_state' }
  }

  switch (progress.step) {
    case 'name': {
      const result = createNameSchema.safeParse(replyFrame.value)
      if (!result.success) return { kind: 'reject', code: 'session_state' }
      return { kind: 'advance', nextStep: 'class', collected: { ...progress.collected, name: result.data } }
    }
    // class·race는 검증 규칙(정수 강제 변환)이 동일하다 — 누적 슬롯·다음 단계만 step에서 파생한다.
    // (name은 string 스키마, confirm은 종단이라 각각 별도 분기로 둔다.)
    case 'class':
    case 'race': {
      const result = createIntSchema.safeParse(replyFrame.value)
      if (!result.success) return { kind: 'reject', code: 'session_state' }
      const nextStep = progress.step === 'class' ? 'race' : 'confirm'
      return { kind: 'advance', nextStep, collected: { ...progress.collected, [progress.step]: result.data } }
    }
    case 'confirm': {
      if (replyFrame.value !== CREATE_CONFIRM_VALUE) return { kind: 'reject', code: 'session_state' }
      const dto = createDtoSchema.safeParse(progress.collected)
      if (!dto.success) return { kind: 'reject', code: 'session_state' }
      return { kind: 'complete', dto: dto.data }
    }
  }
}

/** session_state error 이벤트를 만든다(현재 상태에서 허용되지 않는 프레임). */
function sessionStateError(message: string): ServerEvent {
  return { type: 'error', code: 'session_state', message }
}

/**
 * 월드 진입 — session:entered를 발화하고 command 상태를 반환한다.
 *
 * characterSelect의 기존 캐릭터 선택과 create 완주가 공유하는 단일 진입 지점이다(진입 이벤트·목적
 * 상태의 단일 출처). 향후 command 진입 부수효과(존재 등록 등)가 늘면 여기 한 곳만 고친다. 단, 진행
 * 데드라인 clear는 상태 대입과 순서가 맞아야 하므로 여기가 아니라 enterState의 command 분기에 있다
 * (enterCommand는 상태 대입 전에 실행되고, clear는 대입 시점에 일어난다).
 *
 * `enterWorld`를 **emit보다 먼저** 호출해 세션 레지스트리 등록/재연결을 확정한 뒤 이벤트를 발화한다
 * (등록 상태 확정 후 이벤트). outcome이 'resumed'(link-dead 재연결 rebind)면 session:resumed를,
 * 'entered'(신규 등록)면 session:entered를 발화한다. create 완주 경로도 이 함수를 공유하며 신규
 * 캐릭터는 link-dead일 수 없어 항상 'entered'다.
 */
function enterCommand(session: SessionContext, characterId: string): ConnectionState {
  const outcome = session.enterWorld(characterId)
  session.emit(
    outcome === 'resumed'
      ? { type: 'session:resumed', characterId }
      : { type: 'session:entered', characterId },
  )
  return ConnectionState.command
}

/**
 * 서브스텝 진행 단일 지점 — create 대화의 전진을 여기로 집중한다(BLOCKER 1 / Story 6 seam).
 *
 * create의 이름→클래스→종족→확인 전진은 create 상태 *내부*에서 일어나 applyTransition(enterState)이 못
 * 본다(handleInput이 create를 반환해 no-op 전이). 그 서브스텝 전진을 이 단일 명명 지점으로 모아,
 * Story 6의 데드라인 reaper가 상태전이(enterState)뿐 아니라 대화 진행도 훅해 rearm할 수 있게 한다
 * (인라인 변이면 훅할 곳이 없어 이름 입력 중인 클라가 대화 도중 reap된다). progress를 변이한 뒤
 * session.rearmDeadline()으로 진행 데드라인을 재설정한다.
 */
export function advanceCreate(
  ctx: FsmContext,
  session: SessionContext,
  nextStep: CreateStep,
  collected: CreateCollected,
): void {
  ctx.createProgress = { step: nextStep, collected }
  session.rearmDeadline()
}

/**
 * 2층 characterSelect StateHandler.
 *
 * onEnter: 계정 캐릭터 목록을 조회해 characterList + 선택 prompt를 발화한다.
 * handleInput: decider로 프레임을 해석하고, select면 소유권을 포트로 검증해 통과 시 entered 발화 +
 * command 전이, create면 create로 전이(전이가 create.onEnter를 구동해 첫 prompt 발화), OwnershipError면
 * unauthorized error + 상태 유지, reject면 session_state error + 유지. 무상태 핸들러라 ctx를 읽지 않는다.
 */
const characterSelectHandler: StateHandler = {
  onEnter(_ctx, session) {
    const characters = session.sessionAuth.listCharacters(session.account.accountId)
    session.emit({ type: 'session:characterList', characters })
    session.emit({
      type: 'session:prompt',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      kind: 'selectCharacter',
      // create 진입 옵션을 실어 클라가 매직값 하드코딩 없이 option.value(=CREATE_SENTINEL)를 되돌려 생성에 진입한다.
      options: [{ value: CREATE_SENTINEL, label: '새 캐릭터 생성' }],
    })
  },
  handleInput(_ctx, session, frame) {
    const decision = decideCharacterSelectInput(frame)
    if (decision.kind === 'reject') {
      session.emit(sessionStateError('현재 세션 단계에서 허용되지 않는 명령이다'))
      return ConnectionState.characterSelect
    }
    if (decision.kind === 'create') {
      // 전이가 create.onEnter를 구동해 createProgress 초기화 + 첫 prompt를 발화한다(init·첫 prompt 미분리).
      return decision.nextState
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

    return enterCommand(session, decision.characterId)
  },
}

/**
 * 2층 create StateHandler — 캐릭터 생성 다단 대화.
 *
 * onEnter: createProgress를 name 단계로 초기화(advanceCreate 경유)하고 첫 prompt(create:name)를 발화한다.
 * handleInput: reducer로 프레임을 해석해 — advance면 advanceCreate로 서브스텝을 전진(BLOCKER 1)하고 다음
 * prompt를 발화한 뒤 create를 유지, complete면 검증된 dto로 캐릭터를 생성(BLOCKER 2)·entered 발화 후
 * command로 전이, reject면 session_state error를 발화하고 현재 단계를 유지한다.
 * onExit: create를 이탈할 때 createProgress를 정리한다(create 밖에선 null 불변식).
 */
const createHandler: StateHandler = {
  onEnter(ctx, session) {
    advanceCreate(ctx, session, 'name', {})
    session.emit(createFieldPrompt('name'))
  },
  handleInput(ctx, session, frame) {
    const progress = ctx.createProgress
    if (progress === null) {
      // create 상태인데 progress가 없으면 배선 불변식 위반. 조용한 no-op 대신 session_state로 응답한다.
      session.emit(sessionStateError('생성 대화 상태가 초기화되지 않았다'))
      return ConnectionState.create
    }

    const decision = decideCreateInput(progress, frame)
    if (decision.kind === 'reject') {
      session.emit(sessionStateError('현재 생성 단계에서 허용되지 않는 응답이다'))
      return ConnectionState.create
    }
    if (decision.kind === 'advance') {
      advanceCreate(ctx, session, decision.nextStep, decision.collected)
      session.emit(createFieldPrompt(decision.nextStep))
      return ConnectionState.create
    }

    const summary = session.sessionAuth.createCharacter(session.account.accountId, decision.dto)
    return enterCommand(session, summary.characterId)
  },
  onExit(ctx) {
    ctx.createProgress = null
  },
}

/**
 * 스텁 StateHandler 팩토리 — 셸이 라우터로 위임하는 command 상태의 자리표.
 *
 * command는 셸이 프레임을 라우터(dispatch)로 위임하므로 FSM handleInput이 실제로 도달하지 않지만,
 * `Record<ConnectionState, StateHandler>` 완전성을 위해 둔다. 도달하면 session_state error로 응답하고
 * 상태를 유지한다(조용한 no-op 방지).
 */
function stubHandler(state: ConnectionState): StateHandler {
  return {
    handleInput(_ctx, session) {
      session.emit(sessionStateError('현재 세션 단계에서 처리할 수 없는 명령이다'))
      return state
    },
  }
}

/** 상태 → 처리기 배선표. 전이 부수효과는 각 처리기의 enter/exit·handleInput에 담긴다. */
export const stateHandlers: Record<ConnectionState, StateHandler> = {
  [ConnectionState.characterSelect]: characterSelectHandler,
  [ConnectionState.create]: createHandler,
  [ConnectionState.command]: stubHandler(ConnectionState.command),
}

/**
 * ctx.state를 대입하고 목적 상태의 onEnter를 구동하는 단일 지점.
 *
 * ctx.state 대입은 이 함수에서만 일어난다(Lock D — Story 6 데드라인 reaper가 매 진입마다 여기 훅한다).
 * applyTransition·enterInitialState가 모두 이 함수를 거쳐 진입 부수효과를 일원화한다.
 *
 * 데드라인 seam: command(월드 진입, in-world 도달점)로 진입하면 진행 데드라인을 clear한다 — 이후 유휴는
 * 하트비트(물리 생존)가 관할하므로 논리 진행 데드라인은 불필요하다. 그 외 상태(characterSelect·create)로
 * 진입하면 rearm해 미진행 연결을 설정한다. create 진입 시 enterState rearm + onEnter의 advanceCreate rearm이
 * 이중 호출되나 무해하다(둘 다 같은 타이머를 새로 설정).
 */
function enterState(ctx: FsmContext, session: SessionContext, state: ConnectionState): void {
  ctx.state = state
  if (state === ConnectionState.command) {
    session.clearDeadline()
  } else {
    session.rearmDeadline()
  }
  stateHandlers[state].onEnter?.(ctx, session)
}

/**
 * 3층 전이 적용 — handleInput이 반환한 다음 상태로 전이한다.
 *
 * 같은 상태면 no-op이라 onEnter를 재구동하지 않는다(reject·유지·create 서브스텝 전진 시 초기 이벤트
 * 재발화 방지). 다르면 현 상태 onExit → enterState(대입 + 다음 onEnter) 순으로 구동한다.
 */
export function applyTransition(ctx: FsmContext, session: SessionContext, next: ConnectionState): void {
  if (next === ctx.state) return
  stateHandlers[ctx.state].onExit?.(ctx, session)
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
  const next = stateHandlers[ctx.state].handleInput(ctx, session, frame)
  applyTransition(ctx, session, next)
}
