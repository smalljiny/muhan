import { describe, it, expect, vi } from 'vitest'
import type { ServerEvent } from 'shared'
import { promptKindSchema } from 'shared'
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
 * 1층(순수 decider): plain data 입력→결정 단언(포트·emit·소켓 없음, 동기 유지).
 * 2층(StateHandler): 시드 인메모리 어댑터 + 배열 수집 emit으로 포트 호출·이벤트 발화를 소켓 없이 관찰.
 * 3층 배선(applyTransition·enterInitialState·handleSessionFrame): ctx.state 변이 단일화·enter/exit 콜백 구동.
 *
 * 포트가 async(Promise 반환)라 2·3층 배선 함수도 async다 — 각 테스트는 호출을 await한다. 1층 decider는
 * 포트를 부르지 않아 동기로 유지한다.
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
  enterWorld: ReturnType<typeof vi.fn>
  isClosed: ReturnType<typeof vi.fn>
} {
  const events: ServerEvent[] = []
  const rearmDeadline = vi.fn()
  const clearDeadline = vi.fn()
  // enterWorld는 기본으로 'entered'를 반환한다(테스트가 재연결 경로를 볼 땐 mockReturnValue로 덮는다).
  const enterWorld = vi.fn((): 'entered' | 'resumed' => 'entered')
  // isClosed는 기본으로 false(살아 있는 연결). close-race 테스트가 mockReturnValue(true)로 덮는다.
  const isClosed = vi.fn((): boolean => false)
  const session: SessionContext = {
    account: { accountId: SEED_ACCOUNT_ID },
    sessionAuth: createSeededAuthAdapter(),
    emit: (event) => {
      events.push(event)
    },
    rearmDeadline,
    clearDeadline,
    enterWorld,
    isClosed,
  }
  return { session, events, rearmDeadline, clearDeadline, enterWorld, isClosed }
}

/** create 대화 상태를 담는 FsmContext를 만든다. 무상태 핸들러 테스트도 이 ctx를 넘긴다(사용하지 않아도 무해). */
function makeCtx(state: ConnectionState = ConnectionState.characterSelect): FsmContext {
  return { state, createProgress: null }
}

/** 유효 포인트바이 입력 문자열(합 50 ≤ 54, 각 3~18) — [힘,민첩,맷집,지식,신앙심]. */
const VALID_POINT_BUY = '10 10 10 10 10'

/** confirm 단계에 도달한 완성 collected — 8단계 인터뷰가 전부 채운 상태(dto와 동형). */
const FULL_COLLECTED = {
  name: '아무개',
  gender: 1,
  class: 2,
  stats: [10, 10, 10, 10, 10] as [number, number, number, number, number],
  weapon: 2,
  alignment: 1,
  race: 3,
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
  it('계정 캐릭터 목록을 characterList로, 선택 prompt를 함께 발화한다', async () => {
    const { session, events } = makeSession()

    await stateHandlers[ConnectionState.characterSelect].onEnter?.(makeCtx(), session)

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
    // select prompt는 create 진입 옵션을 실어, 클라가 매직값 하드코딩 없이 option.value를 되돌려 생성에 진입한다.
    expect(events[1]).toMatchObject({
      options: [{ value: CREATE_SENTINEL, label: '새 캐릭터 생성' }],
    })
  })
})

describe('characterSelect StateHandler.handleInput (2층)', () => {
  it('소유 캐릭터 선택 시 enterWorld 등록 후 session:entered 발화 후 command로 전이한다', async () => {
    const { session, events, enterWorld } = makeSession()

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(next).toBe(ConnectionState.command)
    // enterWorld가 emit보다 먼저 characterId로 호출된다(등록 확정 후 이벤트 발화).
    expect(enterWorld).toHaveBeenCalledWith(SEED_CHARACTER_ID)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('enterWorld가 resumed를 반환하면 session:resumed를 발화한다 (재연결 경로)', async () => {
    const { session, events, enterWorld } = makeSession()
    enterWorld.mockReturnValue('resumed')

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:resumed', characterId: SEED_CHARACTER_ID }])
  })

  it('select prompt에 CREATE_SENTINEL로 답하면 create로 전이한다 (이벤트 없이 전이만 요청)', async () => {
    const { session, events } = makeSession()

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })

    expect(next).toBe(ConnectionState.create)
    // 전이 부수효과(createProgress 초기화·첫 prompt)는 create.onEnter가 낸다 — handleInput은 이벤트 없음.
    expect(events).toEqual([])
  })

  it('소유하지 않은 캐릭터 선택은 unauthorized error 발화 후 상태를 유지한다', async () => {
    const { session, events } = makeSession()

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: 'not-owned',
    })

    expect(next).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'unauthorized' }),
    ])
  })

  it('현재 상태에서 허용되지 않는 프레임은 session_state error 발화 후 상태를 유지한다', async () => {
    const { session, events } = makeSession()

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'debug:echo',
      text: '핑',
    })

    expect(next).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'session_state' }),
    ])
  })

  it('OwnershipError가 아닌 포트 예외는 삼키지 않고 그대로 전파한다 (셸 internal 격리에 위임)', async () => {
    const boom = new Error('어댑터 내부 오류')
    const events: ServerEvent[] = []
    // 포트가 async라 fake도 rejected Promise로 예외를 낸다. handleInput은 assertOwnership을 await하므로
    // OwnershipError가 아닌 reject는 그대로 이 handleInput의 Promise를 reject시킨다(삼키지 않음).
    const faultySession: SessionContext = {
      account: { accountId: SEED_ACCOUNT_ID },
      sessionAuth: {
        validateSessionCookie: () => Promise.resolve(null),
        listCharacters: () => Promise.resolve([]),
        createCharacter: () => Promise.reject(boom),
        assertOwnership: () => Promise.reject(boom),
      },
      emit: (event) => {
        events.push(event)
      },
      rearmDeadline: vi.fn(),
      clearDeadline: vi.fn(),
      enterWorld: vi.fn((): 'entered' | 'resumed' => 'entered'),
      isClosed: vi.fn((): boolean => false),
    }

    await expect(
      stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), faultySession, {
        type: 'session:selectCharacter',
        characterId: SEED_CHARACTER_ID,
      }),
    ).rejects.toThrow(boom)
    // entered는 발화되지 않는다(전파로 중단).
    expect(events).toEqual([])
  })
})

describe('create StateHandler (2층 — 생성 다단 대화)', () => {
  it('onEnter는 createProgress를 name 단계로 초기화하고 create:name prompt를 발화한다', async () => {
    const { session, events } = makeSession()
    const ctx = makeCtx(ConnectionState.create)

    await stateHandlers[ConnectionState.create].onEnter?.(ctx, session)

    expect(ctx.createProgress).toEqual({ step: 'name', collected: {} })
    expect(events).toEqual([
      { type: 'session:prompt', promptId: CREATE_PROMPT_IDS.name, kind: 'createField' },
    ])
  })

  it('name 응답은 createProgress를 gender 단계로 전진하고 create:gender prompt를 발화한다 (create 유지)', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'gender', collected: { name: '아무개' } })
    expect(events).toEqual([
      { type: 'session:prompt', promptId: CREATE_PROMPT_IDS.gender, kind: 'createField' },
    ])
  })

  it('confirm 승인은 검증된 dto로 캐릭터를 생성하고 entered 발화 후 command로 전이한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'confirm', collected: FULL_COLLECTED },
    }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.confirm,
      value: CREATE_CONFIRM_VALUE,
    })

    expect(next).toBe(ConnectionState.command)
    // 시드 어댑터(fresh)는 첫 생성 캐릭터에 char-1을 부여한다(nextCharacterSeq=1부터).
    expect(events).toEqual([{ type: 'session:entered', characterId: 'char-1' }])
  })

  it('현재 단계와 다른 promptId 응답(미해결)은 session_state error 발화 후 단계를 유지한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'class', collected: { name: '아무개', gender: 1 } },
    }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '2',
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개', gender: 1 } })
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('무효 값(포인트바이 합 초과)은 session_state error 발화 후 현재 단계를 유지한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'stats', collected: { name: '아무개', gender: 1, class: 2 } },
    }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.stats,
      value: '18 18 18 18 18', // 합 90 > 54
    })

    expect(next).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'stats', collected: { name: '아무개', gender: 1, class: 2 } })
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('createProgress가 null인데 프레임이 오면(불변식 위반) session_state error를 발화한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: null }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })

    expect(next).toBe(ConnectionState.create)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('onExit는 createProgress를 null로 정리한다 (create 밖에선 null 불변식)', async () => {
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'name', collected: {} },
    }

    await stateHandlers[ConnectionState.create].onExit?.(ctx, makeSession().session)

    expect(ctx.createProgress).toBeNull()
  })
})

describe('close-race 가드 (Story 4 — 포트 await 도중 소켓 close)', () => {
  it('characterSelect: assertOwnership await 도중 닫히면 enterWorld·entered 없이 현재 상태로 bail한다', async () => {
    const { session, events, enterWorld, isClosed } = makeSession()
    // 포트 await가 끝난 시점엔 연결이 닫혀 있다(await 도중 close를 시뮬레이션).
    isClosed.mockReturnValue(true)

    const next = await stateHandlers[ConnectionState.characterSelect].handleInput(makeCtx(), session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    // 현재 상태(characterSelect) 반환 → applyTransition no-op으로 command 상태 대입도 건너뛴다.
    expect(next).toBe(ConnectionState.characterSelect)
    // 죽은 연결을 registry에 등록하지 않는다(좀비 바인딩·형제 evict 방지).
    expect(enterWorld).not.toHaveBeenCalled()
    // entered/resumed emit도 없다.
    expect(events).toEqual([])
  })

  it('create: createCharacter await 도중 닫히면 enterWorld·entered 없이 create로 bail한다', async () => {
    const { session, events, enterWorld, isClosed } = makeSession()
    isClosed.mockReturnValue(true)
    const ctx: FsmContext = {
      state: ConnectionState.create,
      createProgress: { step: 'confirm', collected: FULL_COLLECTED },
    }

    const next = await stateHandlers[ConnectionState.create].handleInput(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.confirm,
      value: CREATE_CONFIRM_VALUE,
    })

    expect(next).toBe(ConnectionState.create)
    expect(enterWorld).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('handleSessionFrame: isClosed면 ctx.state가 command로 전이하지 않는다(상태 대입 스킵)', async () => {
    const { session, enterWorld, clearDeadline, isClosed } = makeSession()
    isClosed.mockReturnValue(true)
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    // 상태 대입이 일어나지 않아 characterSelect로 유지된다(no-op 전이). clearDeadline(command 진입 부수효과)도 없다.
    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(enterWorld).not.toHaveBeenCalled()
    expect(clearDeadline).not.toHaveBeenCalled()
  })
})

describe('command 스텁 StateHandler (2층 — 라우터 위임 이전)', () => {
  it('command 상태 스텁 입력은 session_state error 발화 후 상태를 유지한다', async () => {
    const { session, events } = makeSession()

    const next = await stateHandlers[ConnectionState.command].handleInput(
      makeCtx(ConnectionState.command),
      session,
      { type: 'anything' },
    )

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })
})

describe('advanceCreate (서브스텝 진행 단일 지점 — BLOCKER 1 / Story 6 seam)', () => {
  it('ctx.createProgress를 다음 단계·누적 필드로 교체한다', async () => {
    const { session } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    await advanceCreate(ctx, session, 'class', { name: '아무개' })

    expect(ctx.createProgress).toEqual({ step: 'class', collected: { name: '아무개' } })
  })

  it('progress 변이 후 rearmDeadline을 호출한다 (create 서브상태 전진 seam)', async () => {
    const { session, rearmDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.create, createProgress: { step: 'name', collected: {} } }

    await advanceCreate(ctx, session, 'class', { name: '아무개' })

    expect(rearmDeadline).toHaveBeenCalledTimes(1)
  })
})

describe('데드라인 seam (Story 6 — 진행 시 rearm, command 도달 시 clear)', () => {
  it('characterSelect 진입 시 rearmDeadline을 호출한다 (미진행 연결 설정)', async () => {
    const { session, rearmDeadline, clearDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)

    expect(rearmDeadline).toHaveBeenCalled()
    expect(clearDeadline).not.toHaveBeenCalled()
  })

  it('create 서브상태를 매 단계 전진할 때마다 rearmDeadline을 호출한다', async () => {
    const { session, rearmDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    // characterSelect 진입(rearm 1) → create 신호(create.onEnter의 advanceCreate rearm + enterState rearm).
    await enterInitialState(ctx, session)
    const afterEnter = rearmDeadline.mock.calls.length

    await handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })
    // create 진입으로 rearm이 추가 발생한다(enterState + onEnter advanceCreate).
    expect(rearmDeadline.mock.calls.length).toBeGreaterThan(afterEnter)

    const beforeName = rearmDeadline.mock.calls.length
    await handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: CREATE_PROMPT_IDS.name,
      value: '아무개',
    })
    // name→class 서브상태 전진(advanceCreate)마다 rearm이 늘어난다.
    expect(rearmDeadline.mock.calls.length).toBeGreaterThan(beforeName)
  })

  it('command 도달 시 clearDeadline을 호출한다 (in-world 도달점 — 진행 데드라인 해제)', async () => {
    const { session, clearDeadline } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    expect(clearDeadline).toHaveBeenCalledTimes(1)
  })
})

describe('applyTransition (3층 — ctx.state 변이 단일화)', () => {
  it('상태가 바뀌면 목적 상태의 onEnter를 구동하고 ctx.state를 대입한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await applyTransition(ctx, session, ConnectionState.command)

    expect(ctx.state).toBe(ConnectionState.command)
    // command onEnter는 no-op이라 추가 이벤트가 없다.
    expect(events).toEqual([])
  })

  it('동일 상태로의 전이는 no-op이며 onEnter를 재구동하지 않는다 (재발화 없음)', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await applyTransition(ctx, session, ConnectionState.characterSelect)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([])
  })
})

describe('enterInitialState (3층 — accept 시 characterSelect 진입)', () => {
  it('characterSelect onEnter를 구동해 characterList+prompt를 발화한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events.map((e) => e.type)).toEqual(['session:characterList', 'session:prompt'])
  })
})

describe('회귀: emit 순서 보존 (async 마이그레이션 불변식)', () => {
  // 이 블록은 async 마이그레이션(포트 Promise화 + await 삽입)이 관찰 가능한 emit 순서를 재정렬하거나
  // 프레임을 누락하지 않음을 고정한다. characterSelect 진입은 항상 characterList → select prompt 순서로
  // 정확히 2개를 발화해야 하고, create 왕복은 매 단계 prompt가 순서대로 나온 뒤 마지막에 entered가 와야 한다.
  it('characterSelect 진입은 characterList를 select prompt보다 먼저 정확히 2개 발화한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)

    expect(events.map((e) => e.type)).toEqual(['session:characterList', 'session:prompt'])
    const listIdx = events.findIndex((e) => e.type === 'session:characterList')
    const promptIdx = events.findIndex((e) => e.type === 'session:prompt')
    expect(listIdx).toBeLessThan(promptIdx)
  })

  it('create 왕복은 8단계 prompt 순서 뒤 마지막에 entered를 발화한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)
    await driveFullCreate(ctx, session)

    const promptIds = events
      .filter((e): e is Extract<ServerEvent, { type: 'session:prompt' }> => e.type === 'session:prompt')
      .map((e) => e.promptId)
    expect(promptIds).toEqual([
      SELECT_CHARACTER_PROMPT_ID,
      CREATE_PROMPT_IDS.name,
      CREATE_PROMPT_IDS.gender,
      CREATE_PROMPT_IDS.class,
      CREATE_PROMPT_IDS.stats,
      CREATE_PROMPT_IDS.weapon,
      CREATE_PROMPT_IDS.alignment,
      CREATE_PROMPT_IDS.race,
      CREATE_PROMPT_IDS.confirm,
    ])
    expect(events.at(-1)).toEqual({ type: 'session:entered', characterId: 'char-1' })
  })
})

/**
 * characterSelect에서 create 신호부터 confirm 승인까지 8단계 인터뷰 전체를 구동한다(happy path 헬퍼).
 * enterInitialState가 이미 호출된 ctx를 받는다. 각 단계 유효 값을 순서대로 답한다.
 */
async function driveFullCreate(ctx: FsmContext, session: SessionContext): Promise<void> {
  await handleSessionFrame(ctx, session, {
    type: 'session:reply',
    promptId: SELECT_CHARACTER_PROMPT_ID,
    value: CREATE_SENTINEL,
  })
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.name, '아무개'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.gender, '1'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.class, '2'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.stats, VALID_POINT_BUY))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.weapon, '2'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.alignment, '1'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.race, '3'))
  await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))
}

describe('handleSessionFrame (3층 — handleInput + applyTransition 결합)', () => {
  it('유효 선택 프레임으로 entered 발화 후 ctx.state를 command로 전이한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('거부 프레임은 error만 발화하고 상태를 유지한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await handleSessionFrame(ctx, session, { type: 'debug:echo', text: '핑' })

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('create 신호→8단계 왕복으로 command에 도달하고 create.onExit가 progress를 정리한다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    // characterSelect에서 create 신호 → create 진입(첫 prompt는 create.onEnter가 발화).
    await handleSessionFrame(ctx, session, {
      type: 'session:reply',
      promptId: SELECT_CHARACTER_PROMPT_ID,
      value: CREATE_SENTINEL,
    })
    expect(ctx.state).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'name', collected: {} })

    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.name, '아무개'))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.gender, '1'))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.class, '2'))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.stats, VALID_POINT_BUY))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.weapon, '2'))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.alignment, '1'))
    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.race, '3'))
    // 확인 전까지는 create 유지(서브스텝 전진은 no-op 전이).
    expect(ctx.state).toBe(ConnectionState.create)
    expect(ctx.createProgress).toEqual({ step: 'confirm', collected: FULL_COLLECTED })

    await handleSessionFrame(ctx, session, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))

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

describe('decideCreateInput (1층 순수 create reducer — 8단계 인터뷰)', () => {
  it('name 단계 유효 이름을 gender 단계로 advance한다', () => {
    const progress: CreateProgress = { step: 'name', collected: {} }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '아무개'))
    expect(decision).toEqual({ kind: 'advance', nextStep: 'gender', collected: { name: '아무개' } })
  })

  it('gender 단계 1(남)을 class 단계로 advance한다', () => {
    const progress: CreateProgress = { step: 'gender', collected: { name: '아무개' } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.gender, '1'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'class',
      collected: { name: '아무개', gender: 1 },
    })
  })

  it('class 단계 정수 문자열을 stats 단계로 advance한다 (임의 정수 허용 — 클래스 테이블 미확정)', () => {
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개', gender: 1 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.class, '2'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'stats',
      collected: { name: '아무개', gender: 1, class: 2 },
    })
  })

  it('stats 단계 유효 포인트바이를 weapon 단계로 advance한다 ([힘,민첩,맷집,지식,신앙심] 튜플 누적)', () => {
    const progress: CreateProgress = { step: 'stats', collected: { name: '아무개', gender: 1, class: 2 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.stats, '12 10 11 13 4'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'weapon',
      collected: { name: '아무개', gender: 1, class: 2, stats: [12, 10, 11, 13, 4] },
    })
  })

  it('weapon 단계 1~5를 alignment 단계로 advance한다', () => {
    const progress: CreateProgress = {
      step: 'weapon',
      collected: { name: '아무개', gender: 1, class: 2, stats: [10, 10, 10, 10, 10] },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.weapon, '3'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'alignment',
      collected: { name: '아무개', gender: 1, class: 2, stats: [10, 10, 10, 10, 10], weapon: 3 },
    })
  })

  it('alignment 단계 2(악)를 race 단계로 advance한다', () => {
    const progress: CreateProgress = {
      step: 'alignment',
      collected: { name: '아무개', gender: 1, class: 2, stats: [10, 10, 10, 10, 10], weapon: 3 },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.alignment, '2'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'race',
      collected: {
        name: '아무개',
        gender: 1,
        class: 2,
        stats: [10, 10, 10, 10, 10],
        weapon: 3,
        alignment: 2,
      },
    })
  })

  it('race 단계 1~8을 confirm 단계로 advance한다', () => {
    const progress: CreateProgress = {
      step: 'race',
      collected: {
        name: '아무개',
        gender: 1,
        class: 2,
        stats: [10, 10, 10, 10, 10],
        weapon: 3,
        alignment: 2,
      },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.race, '3'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'confirm',
      collected: {
        name: '아무개',
        gender: 1,
        class: 2,
        stats: [10, 10, 10, 10, 10],
        weapon: 3,
        alignment: 2,
        race: 3,
      },
    })
  })

  it('confirm 단계 승인 값에서 완성 dto로 complete한다', () => {
    const progress: CreateProgress = { step: 'confirm', collected: FULL_COLLECTED }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))
    expect(decision).toEqual({ kind: 'complete', dto: FULL_COLLECTED })
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
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개', gender: 1 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '2'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('공백만 있는 이름은 reject한다 (trim 후 빈 이름 검증)', () => {
    const progress: CreateProgress = { step: 'name', collected: {} }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.name, '   '))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('범위 밖 gender(3)는 reject한다 (1|2만 허용)', () => {
    const progress: CreateProgress = { step: 'gender', collected: { name: '아무개' } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.gender, '3'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('비정수 class 값은 reject한다', () => {
    const progress: CreateProgress = { step: 'class', collected: { name: '아무개', gender: 1 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.class, '어림수'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('범위 밖 weapon(6)은 reject한다 (1~5만 허용)', () => {
    const progress: CreateProgress = {
      step: 'weapon',
      collected: { name: '아무개', gender: 1, class: 2, stats: [10, 10, 10, 10, 10] },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.weapon, '6'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('범위 밖 alignment(0)는 reject한다 (1|2만 허용)', () => {
    const progress: CreateProgress = {
      step: 'alignment',
      collected: { name: '아무개', gender: 1, class: 2, stats: [10, 10, 10, 10, 10], weapon: 3 },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.alignment, '0'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('범위 밖 race(9)는 reject한다 (1~8만 허용)', () => {
    const progress: CreateProgress = {
      step: 'race',
      collected: {
        name: '아무개',
        gender: 1,
        class: 2,
        stats: [10, 10, 10, 10, 10],
        weapon: 3,
        alignment: 2,
      },
    }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.race, '9'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('confirm 단계에서 승인 값이 아니면 reject한다 (현재 단계 유지)', () => {
    const progress: CreateProgress = { step: 'confirm', collected: FULL_COLLECTED }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, '아니오'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('confirm 단계에서 collected가 불완전하면(방어) reject한다', () => {
    const progress: CreateProgress = { step: 'confirm', collected: { name: '아무개', gender: 1, class: 2 } }
    const decision = decideCreateInput(progress, reply(CREATE_PROMPT_IDS.confirm, CREATE_CONFIRM_VALUE))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })
})

describe('decideCreateInput 포인트바이 54점 검증 (stats 단계 — T6.3)', () => {
  const statsProgress: CreateProgress = {
    step: 'stats',
    collected: { name: '아무개', gender: 1, class: 2 },
  }

  it('5개 정수·각 3~18·합 ≤54를 만족하면 튜플로 accept한다', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '3 3 3 3 3'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'weapon',
      collected: { name: '아무개', gender: 1, class: 2, stats: [3, 3, 3, 3, 3] },
    })
  })

  it('정확히 합 54(경계)를 accept한다', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '18 18 6 6 6'))
    expect(decision).toEqual({
      kind: 'advance',
      nextStep: 'weapon',
      collected: { name: '아무개', gender: 1, class: 2, stats: [18, 18, 6, 6, 6] },
    })
  })

  it('정수가 4개면 reject한다 (정확히 5개 요구)', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '10 10 10 10'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('정수가 6개면 reject한다', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '10 10 10 10 10 10'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('비정수 원소가 있으면 reject한다', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '10 10 10 10 나쁨'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('소수 원소가 있으면 reject한다', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '10 10 10 10 1.5'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('원소가 3 미만이면 reject한다 (하한 경계 미달)', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '2 10 10 10 10'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('원소가 18 초과면 reject한다 (상한 경계 초과)', () => {
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '19 3 3 3 3'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })

  it('각 값 범위 안이면서 합만 54 초과면 reject한다 (합 경계 격리)', () => {
    // 12*5 = 60 > 54, 각 12는 3~18 범위 안 — 합 초과만 단독 검증.
    const decision = decideCreateInput(statsProgress, reply(CREATE_PROMPT_IDS.stats, '12 12 12 12 12'))
    expect(decision).toEqual({ kind: 'reject', code: 'session_state' })
  })
})

describe('와이어 계약 보존 (신규 메시지 타입·프로토콜 미변경 잠금 — T6.7)', () => {
  it('promptKindSchema는 정확히 [selectCharacter, createField] 두 종류만 갖는다 (신규 kind 없음)', () => {
    expect(promptKindSchema.options).toEqual(['selectCharacter', 'createField'])
  })

  it('8단계 인터뷰가 발화하는 create prompt는 모두 kind=createField다 (신규 wire 타입 미도입)', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)
    await driveFullCreate(ctx, session)

    const createPrompts = events.filter(
      (e): e is Extract<ServerEvent, { type: 'session:prompt' }> =>
        e.type === 'session:prompt' && e.promptId !== SELECT_CHARACTER_PROMPT_ID,
    )
    // name~confirm 8개 create prompt가 모두 createField kind로 나온다.
    expect(createPrompts).toHaveLength(8)
    for (const p of createPrompts) {
      expect(p.kind).toBe('createField')
    }
  })

  it('인터뷰는 session:prompt·session:reply·session:entered 밖의 신규 session:* 타입을 쓰지 않는다', async () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect, createProgress: null }

    await enterInitialState(ctx, session)
    await driveFullCreate(ctx, session)

    const allowed = new Set([
      'session:characterList',
      'session:prompt',
      'session:entered',
      'session:resumed',
    ])
    for (const e of events) {
      expect(allowed.has(e.type)).toBe(true)
    }
  })
})
