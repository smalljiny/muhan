import { describe, it, expect } from 'vitest'
import type { ServerEvent } from 'shared'
import {
  createSeededAuthAdapter,
  SEED_ACCOUNT_ID,
  SEED_CHARACTER_ID,
} from '../../auth/inMemorySessionAuthAdapter.js'
import {
  ConnectionState,
  SELECT_CHARACTER_PROMPT_ID,
  decideCharacterSelectInput,
  stateHandlers,
  applyTransition,
  enterInitialState,
  handleSessionFrame,
  type FsmContext,
  type SessionContext,
} from './sessionFsm.js'

/**
 * 세션 FSM 단위 스펙 — 3층 아키텍처를 각 층 고유의 테스트 스타일로 검증한다.
 *
 * 1층(순수 decider): plain data 입력→결정 단언(포트·emit·소켓 없음).
 * 2층(StateHandler): 시드 인메모리 어댑터 + 배열 수집 emit으로 포트 호출·이벤트 발화를 소켓 없이 관찰.
 * 3층 배선(applyTransition·enterInitialState·handleSessionFrame): ctx.state 변이 단일화·enter/exit 콜백 구동.
 */

/** 배열 수집 emit과 시드 어댑터를 배선한 세션 컨텍스트를 만든다(소켓 없이 2층 테스트). */
function makeSession(): { session: SessionContext; events: ServerEvent[] } {
  const events: ServerEvent[] = []
  const session: SessionContext = {
    account: { accountId: SEED_ACCOUNT_ID },
    sessionAuth: createSeededAuthAdapter(),
    emit: (event) => {
      events.push(event)
    },
  }
  return { session, events }
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

    stateHandlers[ConnectionState.characterSelect].onEnter?.(session)

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

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('소유하지 않은 캐릭터 선택은 unauthorized error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(session, {
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

    const next = stateHandlers[ConnectionState.characterSelect].handleInput(session, {
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
    }

    expect(() =>
      stateHandlers[ConnectionState.characterSelect].handleInput(faultySession, {
        type: 'session:selectCharacter',
        characterId: SEED_CHARACTER_ID,
      }),
    ).toThrow(boom)
    // entered는 발화되지 않는다(전파로 중단).
    expect(events).toEqual([])
  })
})

describe('create/command 스텁 StateHandler (2층 — Story 5·라우터 위임 이전)', () => {
  it('create 상태 입력은 session_state error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.create].handleInput(session, { type: 'anything' })

    expect(next).toBe(ConnectionState.create)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })

  it('command 상태 스텁 입력은 session_state error 발화 후 상태를 유지한다', () => {
    const { session, events } = makeSession()

    const next = stateHandlers[ConnectionState.command].handleInput(session, { type: 'anything' })

    expect(next).toBe(ConnectionState.command)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })
})

describe('applyTransition (3층 — ctx.state 변이 단일화)', () => {
  it('상태가 바뀌면 목적 상태의 onEnter를 구동하고 ctx.state를 대입한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect }

    applyTransition(ctx, session, ConnectionState.command)

    expect(ctx.state).toBe(ConnectionState.command)
    // command onEnter는 no-op이라 추가 이벤트가 없다.
    expect(events).toEqual([])
  })

  it('동일 상태로의 전이는 no-op이며 onEnter를 재구동하지 않는다 (재발화 없음)', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect }

    applyTransition(ctx, session, ConnectionState.characterSelect)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([])
  })
})

describe('enterInitialState (3층 — accept 시 characterSelect 진입)', () => {
  it('characterSelect onEnter를 구동해 characterList+prompt를 동기 발화한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect }

    enterInitialState(ctx, session)

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events.map((e) => e.type)).toEqual(['session:characterList', 'session:prompt'])
  })
})

describe('handleSessionFrame (3층 — handleInput + applyTransition 결합)', () => {
  it('유효 선택 프레임으로 entered 발화 후 ctx.state를 command로 전이한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect }

    handleSessionFrame(ctx, session, {
      type: 'session:selectCharacter',
      characterId: SEED_CHARACTER_ID,
    })

    expect(ctx.state).toBe(ConnectionState.command)
    expect(events).toEqual([{ type: 'session:entered', characterId: SEED_CHARACTER_ID }])
  })

  it('거부 프레임은 error만 발화하고 상태를 유지한다', () => {
    const { session, events } = makeSession()
    const ctx: FsmContext = { state: ConnectionState.characterSelect }

    handleSessionFrame(ctx, session, { type: 'debug:echo', text: '핑' })

    expect(ctx.state).toBe(ConnectionState.characterSelect)
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'session_state' })])
  })
})
