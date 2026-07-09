import { describe, it, expect, vi } from 'vitest'
import type { ServerEvent } from 'shared'
import {
  createSeededAuthAdapter,
  SEED_ACCOUNT_ID,
  SEED_CHARACTER_ID,
} from '../../auth/seedSessionAuth.testutil.js'
import {
  ConnectionState,
  SELECT_CHARACTER_PROMPT_ID,
  CREATE_SENTINEL,
  CREATE_CONFIRM_VALUE,
  CREATE_PROMPT_IDS,
  decideCharacterSelectInput,
  decideCreateInput,
  advanceCreate,
  stateHandlers,
  applyTransition,
  enterInitialState,
  handleSessionFrame,
  type FsmContext,
  type SessionContext,
  type CreateProgress,
} from './sessionFsm.js'

/**
 * 세션 FSM 단위 스펙 — 3층 아키텍처를 각 층 고유의 테스트 스타일로 검증한다.
 *
 * 1층(순수 decider): plain data 입력→결정 단언(포트·emit·소켓 없음).
 * 2층(StateHandler): 시드 인메모리 어댑터 + 배열 수집 emit으로 포트 호출·이벤트 발화를 소켓 없이 관찰.
 * 3층 배선(applyTransition·enterInitialState·handleSessionFrame): ctx.state 변이 단일화·enter/exit 콜백 구동.
 */

/**
 * 배열 수집 emit과 시드 어댑터를 배선한 세션 컨텍스트를 만든다(소켓 없이 2층 테스트).
 * rearmDeadline/clearDeadline은 vi.fn() 스파이로 배선해 데드라인 seam 호출을 관찰한다.
 */
function makeSession(): {
  session: SessionContext
  events: ServerEvent[]
  rearmDeadline: ReturnType<typeof vi.fn>
  clearDeadline: ReturnType<typeof vi.fn>
} {
  const events: ServerEvent[] = []
  const rearmDeadline = vi.fn()
  const clearDeadline = vi.fn()
  const session: SessionContext = {
    account: { accountId: SEED_ACCOUNT_ID },
    sessionAuth: createSeededAuthAdapter(),
    emit: (event) => {
      events.push(event)
    },
    rearmDeadline,
    clearDeadline,
  }
  return { session, events, rearmDeadline, clearDeadline }
}

/** create 대화 상태를 담는 FsmContext를 만든다. 무상태 핸들러 테스트도 이 ctx를 넘긴다(사용하지 않아도 무해). */
function makeCtx(state: ConnectionState = ConnectionState.characterSelect): FsmContext {
  return { state, createProgress: null }
}

describe('decideCharacterSelectInput (1층 순수 decider)', () => {
  it('유효 session:selectCharacter 프레임을 select 결정으로 해석한다 (요청 전이=command)', () => {
    const decision = decideCharacterSelectInput({
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(decision).toEqual({
      kind: 'select',
      characterId: SEED_CHARACTER_ID,
      nextState: ConnectionState.command,
    })
  })

  it('미지 type 프레임을 session_state reject로 해석한다', () => {
    const decision = decideCharacterSelectInput({ type: 'no:such:command' })
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('characterId 누락 session:selectCharacter를 reject한다 (strict 파싱)', () => {
    const decision = decideCharacterSelectInput({ type: 'session:selectCharacter' })
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('다른 상태의 유효 명령(debug:echo)도 characterSelect에선 reject한다', () => {
    const decision = decideCharacterSelectInput({ type: 'debug:echo', text: '핑' })
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('객체가 아닌 프레임을 reject한다', () => {
    expect(decideCharacterSelectInput(null)).toEqual({ kind: 'reject', code: 'session_state' })
    expect(decideCharacterSelectInput('문자열')).toEqual({ kind: 'reject', code: 'session_state' })
  })
})

describe('characterSelect StateHandler.onEnter (2층)', () => {
  it('계정 캐릭터 목록을 characterList로, 선택 prompt를 함께 발화한다', () => {
    const { session, events } = makeSession()

    stateHandlers[ConnectionState.characterSelect].onEnter?.(makeCtx(), session)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: 'session:characterList',
      characters: [{ characterId: SEED_CHARACTER_ID, name: '무한전사', class: 1, race: 1, level: 5 }],
    })
    expect(events[1]).toMatchObject({
      type: 'session:prompt',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      kind: 'selectCharacter',
    })
  })
})

describe('characterSelect StateHandler.handleInput (2층)', () => {
  it('소유 캐릭터 선택 시 session:entered 발화 후 command로 전이한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('select prompt에 CREATE_SENTINEL로 답하면 create로 전이한다 (이벤트 없이 전이만 요청)', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })

    expect(next).toBe(ConnectionState.create)
    // 전이 부수효과(createProgress 초기화·첫 prompt)는 create.onEnter가 낸다 — handleInput은 이벤트 없음.
    expect(events).toEqual([])
  })

  it('소유하지 않은 캐릭터 선택은 unauthorized error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: 'not-owned',
    })

    expect(next).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'unauthorized' }),
    ])
  })

  it('현재 상태에서 허용되지 않는 프레임은 session_state error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'debug:echo',
      text: '핑',
    })

    expect(next).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'session_state' }),
    ])
  })

  it('OwnershipError가 아닌 포트 예외는 삼키지 않고 그대로 전파한다 (셸 internal 격리에 위임)', () => {
    const boom = new Error('어댑터 내부 오류')
    const events: ServerEvent[] = []
    const faultySession: SessionContext = {
      account: { accountId: SEED_ACCOUNT_ID },
      sessionAuth: {
        validateSessionCookie: () => null,
        listCharacters: () => [],
        createCharacter: () => {
          throw boom
        },
        assertOwnership: () => {
          throw boom
        },
      },
      emit: (event) => {
        events.push(event)
      },
      rearmDeadline: vi.fn(),
      clearDeadline: vi.fn(),
    }

    expect(() =>
      stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), faultySession, {
        type: 'session:selectCharacter',
        characterId: SEED_CHARACTER_ID,
      }),
    ).toThrow(boom)
    // entered는 발화되지 않는다(전파로 중단).
    expect(events).toEqual([])
  })
})

describe('create StateHandler (2층 — 생성 다단 대화)', () => {
  it('onEnter는 createProgress를 name 단계로 초기화하고 create:name prompt를 발화한다', () => {
    const { session, events } = makeSession()
    const ctx = makeCtx(ConnectionState.create)

    stateHandlers[ConnectionState.create].onEnter?.(ctx, session)

    expect(ctx.createProgress).toEqual({ step: 'name', collected: {} })
    expect(events).toEqual([
      { type: 'session:prompt', promptId: CREATE_PROMPT_IDS.name, kind: 'createField' },
    ])
  })

  it('name 응답은 createProgress를 class 단계로 전진하고 create:class prompt를 발화한다 (create 유지)', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    const next = stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개' } })
    expect(events).toEqual([
      { type: 'session:prompt', promptId: CREATE_PROMPT_IDS.class, kind: 'createField' },
    ])
  })

  it('confirm 승인은 검증된 dto로 캐릭터를 생성하고 entered 발화 후 command로 전이한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'confirm', collected: { name: '아무개', class: 2, race: 3 } },
    }

    const next = stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.confirm,
      value: CREATE_CONFIRM_VALUE,
    })

    expect(next).toBe(ConnectionState.command)
    // 시드 어댑터(fresh)는 첫 생성 캐릭터에 char-1을 부여한다(nextCharacterSeq=1부터).
    expect(events).toEqual([{ type: 'session:entered', characterId: 'char-1' }])
  })

  it('현재 단계와 다른 promptId 응답(미해결)은 session_state error 발화 후 단계를 유지한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'class', collected: { name: '아무개' } },
    }

    const next = stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '2',
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개' } })
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('무효 값(비정수 class)은 session_state error 발화 후 현재 단계를 유지한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'class', collected: { name: '아무개' } },
    }

    const next = stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.class,
      value: '어림수',
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개' } })
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('createProgress가 null인데 프레임이 오면(불변식 위반) session_state error를 발화한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: null }

    const next = stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })

    expect(next).toBe(ConnectionState.create)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('onExit는 createProgress를 null로 정리한다 (create 밖에선 null 불변식)', () => {
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'name', collected: {} },
    }

    stateHandlers[ConnectionState.create].onExit?.(ctx, makeSession().session)

    expect(ctx.createProgress).toBeNull()
  })
})

describe('command 스텁 StateHandler (2층 — 라우터 위임 이전)', () => {
  it('command 상태 스텁 입력은 session_state error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.command].handleInput(
      makeCtx(ConnectionState.command),
      session,
      { type: 'anything' },
    )

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })
})

describe('advanceCreate (서브스텝 진행 단일 지점 — BLOCKER 1 / Story 6 seam)', () => {
  it('ctx.createProgress를 다음 단계·누적 필드로 교체한다', () => {
    const { session } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    advanceCreate(ctx, session, 'class', { name: '아무개' })

    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개' } })
  })

  it('progress 변이 후 rearmDeadline을 호출한다 (create 서브상태 전진 seam)', () => {
    const { session, rearmDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    advanceCreate(ctx, session, 'class', { name: '아무개' })

    expect(rearmDeadline).toHaveBeenCalledTimes(1)
  })
})

describe('데드라인 seam (Story 6 — 진행 시 rearm, command 도달 시 clear)', () => {
  it('characterSelect 진입 시 rearmDeadline을 호출한다 (미진행 연결 설정)', () => {
    const { session, rearmDeadline, clearDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    enterInitialState(ctx, session)

    expect(rearmDeadline).toHaveBeenCalled()
    expect(clearDeadline).not.toHaveBeenCalled()
  })

  it('create 서브상태를 매 단계 전진할 때마다 rearmDeadline을 호출한다', () => {
    const { session, rearmDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    // characterSelect 진입(rearm 1) → create 신호(create.onEnter의 advanceCreate rearm + enterState rearm).
    enterInitialState(ctx, session)
    const afterEnter = rearmDeadline.mock.calls.length

    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })
    // create 진입으로 rearm이 추가 발생한다(enterState + onEnter advanceCreate).
    expect(rearmDeadline.mock.calls.length).toBeGreaterThan(afterEnter)

    const beforeName = rearmDeadline.mock.calls.length
    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })
    // name→class 서브상태 전진(advanceCreate)마다 rearm이 늘어난다.
    expect(rearmDeadline.mock.calls.length).toBeGreaterThan(beforeName)
  })

  it('command 도달 시 clearDeadline을 호출한다 (in-world 도달점 — 진행 데드라인 해제)', () => {
    const { session, clearDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    expect(clearDeadline).toHaveBeenCalledTimes(1)
  })
})

describe('applyTransition (3층 — ctx.state 변이 단일화)', () => {
  it('상태가 바뀌면 목적 상태의 onEnter를 구동하고 ctx.state를 대입한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    applyTransition(ctx, session, ConnectionState.command)

    expect(ctx.state).toBe(ConnectionState.command)
    // command onEnter는 no-op이라 추가 이벤트가 없다.
    expect(events).toEqual([])
  })

  it('동일 상태로의 전이는 no-op이며 onEnter를 재구동하지 않는다 (재발화 없음)', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    applyTransition(ctx, session, ConnectionState.characterSelect)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([])
  })
})

describe('enterInitialState (3층 — accept 시 characterSelect 진입)', () => {
  it('characterSelect onEnter를 구동해 characterList+prompt를 동기 발화한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    enterInitialState(ctx, session)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events.map((e) => e.type)).toEqual(['session:characterList', 'session:prompt'])
  })
})

describe('handleSessionFrame (3층 — handleInput + applyTransition 결합)', () => {
  it('유효 선택 프레임으로 entered 발화 후 ctx.state를 command로 전이한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('거부 프레임은 error만 발화하고 상태를 유지한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    handleSessionFrame(ctx, session, { type: 'debug:echo', text: '핑' })

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('create 신호→이름→클래스→종족→확인 왕복으로 command에 도달하고 create.onExit가 progress를 정리한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    // characterSelect에서 create 신호 → create 진입(첫 prompt는 create.onEnter가 발화).
    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })
    expect(ctx.state).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'name', collected: {} })

    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })
    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.class,
      value: '2',
    })
    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.race,
      value: '3',
    })
    // 확인 전까지는 create 유지(서브스텝 전진은 no-op 전이).
    expect(ctx.state).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'confirm', collected: { name: '아무개', class: 2, race: 3 } })

    handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.confirm,
      value: CREATE_CONFIRM_VALUE,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    // create.onExit가 createProgress를 정리했다(create 밖에선 null).
    expect(ctx.createProgress).toBeNull()
    // 마지막 이벤트는 session:entered(시드 어댑터의 첫 생성 캐릭터 char-1).
    expect(events.at(-1)).toEqual({ type: 'session:entered', characterId: 'char-1' })
  })
})

/** promptId가 지목한 create 단계에 value로 답하는 session:reply 프레임을 만든다. */
function reply(promptId: string, value: string): unknown {
  return { type: 'session:reply', promptId, value }
}

describe('decideCreateInput (1층 순수 create reducer)', () => {
  it('name 단계 유효 이름을 class 단계로 advance한다 (collected에 name 누적)', () => {
    const progress: CreateProgress = { step: 'name', collected: {} }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '아무개'))

    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'class',
      collected: { name: '아무개' },
    })
  })

  it('class 단계 정수 문자열을 race 단계로 advance한다 (string→number 변환)', () => {
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개' } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.class, '2'))

    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'race',
      collected: { name: '아무개', class: 2 },
    })
  })

  it('race 단계 정수 문자열을 confirm 단계로 advance한다', () => {
    const progress: CreateProgress = { step: 'race', collected: { name: '아무개', class: 2 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.race, '3'))

    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'confirm',
      collected: { name: '아무개', class: 2, race: 3 },
    })
  })

  it('confirm 단계 승인 값에서 완성 dto로 complete한다', () => {
    const progress: CreateProgress = {
      step: 'confirm',
      collected: { name: '아무개', class: 2, race: 3 },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))

    expect(decision).toEqual({ kind: 'complete', dto: { name: '아무개', class: 2, race: 3 } })
  })

  it('세션 응답이 아닌 프레임(session:selectCharacter)은 session_state reject다', () => {
    const progress: CreateProgress = { step: 'name', collected: {} }
    const decision = decideCreateInput(progress, {
      type: 'session:selectCharacter',
      characterId: 'x',
    })
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('현재 단계와 다른 promptId(미일치)로 답하면 reject한다 (상관 강제)', () => {
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개' } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '2'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('공백만 있는 이름은 reject한다 (trim 후 빈 이름 검증)', () => {
    const progress: CreateProgress = { step: 'name', collected: {} }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '   '))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('비정수 class 값은 reject한다', () => {
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개' } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.class, '어림수'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('비정수 race 값은 reject한다', () => {
    const progress: CreateProgress = { step: 'race', collected: { name: '아무개', class: 2 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.race, '1.5'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('confirm 단계에서 승인 값이 아니면 reject한다 (현재 단계 유지)', () => {
    const progress: CreateProgress = {
      step: 'confirm',
      collected: { name: '아무개', class: 2, race: 3 },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, '아니오'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('confirm 단계에서 collected가 불완전하면(방어) reject한다', () => {
    const progress: CreateProgress = { step: 'confirm', collected: { name: '아무개', class: 2 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })
})
