import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Server as HttpsServer } from 'node:https'
import { PROTOCOL_VERSION } from 'shared'
import { buildApp } from '../app.js'
import { MAX_FRAME_BYTES } from './plugin.js'
import { resetConfigForTests } from '../config/env.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import {
  buildSeededApp,
  injectAuthedWS,
  waitForMessage,
  waitForClose,
  waitFor,
  createMessageReader,
  enterCommandState,
  enterCreateFlow,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'
import {
  ConnectionState,
  SELECT_CHARACTER_PROMPT_ID,
  CREATE_SENTINEL,
  CREATE_PROMPT_IDS,
} from './fsm/sessionFsm.js'
import { SEED_ACCOUNT_ID, SEED_CHARACTER_ID } from '../auth/seedSessionAuth.testutil.js'

// T3.6 — transport 배선 스펙. injectWS로 유효 쿠키+허용 Origin upgrade를 태워 라우트 마운트·프레임
// 하드닝·per-connection 정리·https pass-through를 관찰한다(E3-1 회귀 방어). 인증 게이트 자체 검증은
// auth.gate.test.ts가 소유한다 — 여기선 게이트를 통과한 뒤의 transport 동작만 본다.
describe('WS transport', () => {
  // 연결 핸들러가 getConfig()를 호출하고 preValidation 게이트가 WS_ALLOWED_ORIGINS를 소비하므로
  // 필수 env를 채워 fail-fast를 피한다. 앰비언트 env를 덮어쓰지 않도록 snapshot-restore로 복원한다.
  let savedEnv: NodeJS.ProcessEnv

  beforeAll(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
  })

  afterAll(() => {
    process.env = savedEnv
    resetConfigForTests()
  })

  it('게임 소켓 연결을 수락한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)

    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('MAX_FRAME_BYTES 초과 프레임을 거부하고 연결을 닫는다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)

    // 프로토콜 레이어(maxPayload)가 버퍼 완성 전에 거부해야 한다 — 서버가 1009로 소켓을 닫는다.
    const closed = waitForClose(ws)
    ws.send('x'.repeat(MAX_FRAME_BYTES + 1))
    const code = await closed

    expect(code).toBe(1009)

    await app.close()
  })

  it('파싱 불가 JSON은 error{code:bad_payload} 이벤트로 응답하고 소켓은 생존한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // 연결 직후 push되는 system:hello를 먼저 소비한다.

    // malformed JSON은 파싱이 핸드셰이크 게이트보다 먼저 실패하므로 pre-ready에서도 bad_payload다.
    const received = waitForMessage(ws)
    ws.send('{ this is not json')
    const event = await received

    expect(event).toMatchObject({ type: 'error', code: 'bad_payload' })
    expect(ws.readyState).toBe(ws.OPEN)
    expect(app.wsConnections.size).toBe(1)

    ws.terminate()
    await app.close()
  })

  it('연결 수락 시 하트비트 타이머를 시작해 ctx.heartbeat에 배선한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)

    // 하트비트 start()가 반환한 타이머 핸들이 ctx에 배선돼야 한다(cleanup·누수 방지 seam).
    const ctx = [...app.wsConnections.values()][0]
    expect(ctx?.heartbeat).not.toBeNull()

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    await app.close()
  })

  it('연결 종료 시 per-connection 컨텍스트를 정리한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    expect(app.wsConnections.size).toBe(1)

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    expect(app.wsConnections.size).toBe(0)

    await app.close()
  })

  it('연결 직후 system:hello{protocolVersion}를 push한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const hello = await waitForMessage(ws)

    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    ws.terminate()
    await app.close()
  })

  it('ready 이전 non-ready 명령을 handshake_required로 거부하고 소켓은 생존한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello 소비

    const rejected = waitForMessage(ws)
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑' }))
    const event = await rejected

    expect(event).toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('버전 일치 system:ready로 핸드셰이크를 완료한다 (ready=true)', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const hello = await waitForMessage(ws)
    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: 1 })

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await waitFor(() => [...app.wsConnections.values()][0]?.ready === true)

    expect([...app.wsConnections.values()][0]?.ready).toBe(true)
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('버전 불일치 system:ready는 system:reload push 후 소켓을 닫는다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello 소비

    // reload 프레임이 close 전에 확실히 플러시되도록 두 리스너를 send 전에 건다.
    const reloadReceived = waitForMessage(ws)
    const closed = waitForClose(ws)
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 999 }))

    const reload = await reloadReceived
    expect(reload).toMatchObject({ type: 'system:reload' })

    const code = await closed
    expect(typeof code).toBe('number')

    await app.close()
  })

  it('핸드셰이크 완료 후 중복 system:ready를 error로 거부한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    // accept가 characterList+prompt 2프레임을 동기 발화하므로 유실 없는 리더로 소비한다(Lock A/B).
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await reader.next() // session:characterList
    await reader.next() // session:prompt
    await waitFor(() => [...app.wsConnections.values()][0]?.ready === true)

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    const event = await reader.next()

    expect(event).toMatchObject({ type: 'error' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('핸드셰이크 완료 시 characterSelect로 진입해 characterList+prompt를 발화한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello

    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    const list = await reader.next()
    const prompt = await reader.next()

    expect(list).toMatchObject({
      type: 'session:characterList',
      characters: [{ characterId: SEED_CHARACTER_ID }],
    })
    expect(prompt).toMatchObject({ type: 'session:prompt', kind: 'selectCharacter' })
    expect([...app.wsConnections.values()][0]?.state).toBe(ConnectionState.characterSelect)

    ws.terminate()
    await app.close()
  })

  it('소유 캐릭터 선택 시 entered 발화 후 command로 전이하고 이후 debug:echo가 라우터에 도달한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    // hello→ready→characterList→prompt→selectCharacter→entered까지 왕복해 command 도달.
    const reader = await enterCommandState(ws)
    expect([...app.wsConnections.values()][0]?.state).toBe(ConnectionState.command)

    // command 상태이므로 debug:echo가 라우터 dispatch에 도달해야 한다.
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))
    const event = await reader.next()

    expect(event).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('소유하지 않은 캐릭터 선택은 unauthorized error로 거부하고 characterSelect에 머문다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await reader.next() // characterList
    await reader.next() // prompt

    ws.send(JSON.stringify({ type: 'session:selectCharacter', characterId: 'not-owned' }))
    const event = await reader.next()

    expect(event).toMatchObject({ type: 'error', code: 'unauthorized' })
    // command 미도달 — 여전히 characterSelect라 라우터로 넘어가지 않는다.
    expect([...app.wsConnections.values()][0]?.state).toBe(ConnectionState.characterSelect)
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('create 다단 대화를 완주하면 entered 후 command에 도달하고 이후 debug:echo가 라우터에 도달한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    // select prompt→create 신호→이름→클래스→종족→확인→entered까지 왕복해 command 도달.
    const reader = await enterCreateFlow(ws)
    expect([...app.wsConnections.values()][0]?.state).toBe(ConnectionState.command)
    // 대화 상태는 command 진입 시 정리됐다.
    expect([...app.wsConnections.values()][0]?.createProgress).toBeNull()

    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))
    const event = await reader.next()
    expect(event).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })

    ws.terminate()
    await app.close()
  })

  it('create 첫 단계에서 미일치 promptId 응답은 session_state error로 거부하고 create에 머문다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await reader.next() // characterList
    await reader.next() // prompt(selectCharacter)
    ws.send(JSON.stringify({ type: 'session:reply', promptId: SELECT_CHARACTER_PROMPT_ID, value: CREATE_SENTINEL }))
    await reader.next() // prompt(create:name)

    // 현재 단계는 name인데 confirm promptId로 답한다(미일치).
    ws.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.confirm, value: '아무개' }))
    const event = await reader.next()

    expect(event).toMatchObject({ type: 'error', code: 'session_state' })
    expect([...app.wsConnections.values()][0]?.state).toBe(ConnectionState.create)
    expect(ws.readyState).toBe(ws.OPEN)

    ws.terminate()
    await app.close()
  })

  it('한 단계 전진 후 지나간 단계 promptId로 답하는 미해결 응답을 session_state error로 거부한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: 1 }))
    await reader.next() // characterList
    await reader.next() // prompt(selectCharacter)
    ws.send(JSON.stringify({ type: 'session:reply', promptId: SELECT_CHARACTER_PROMPT_ID, value: CREATE_SENTINEL }))
    await reader.next() // prompt(create:name)

    // name에 정상 응답 → class 단계로 전진.
    ws.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.name, value: '아무개' }))
    await reader.next() // prompt(create:class)

    // 이제 단계는 class인데 지나간 name promptId로 다시 답한다(stale·미해결).
    ws.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.name, value: '재입력' }))
    const event = await reader.next()

    expect(event).toMatchObject({ type: 'error', code: 'session_state' })
    // 단계가 전진하지 않고 class에 머문다.
    expect([...app.wsConnections.values()][0]?.createProgress).toMatchObject({ step: 'class' })

    ws.terminate()
    await app.close()
  })

  it('lifecyclePort 미주입 시 no-op 어댑터를 wsLifecyclePort로 배선한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    // 기본 경로(buildApp→registerWebsocket 2-arg)는 no-op 어댑터를 세운다 — onSessionEnd 표면이 존재한다.
    expect(typeof app.wsLifecyclePort.onSessionEnd).toBe('function')
    expect(() =>
      app.wsLifecyclePort.onSessionEnd({
        accountId: 'acc-1',
        characterId: 'char-1',
        reason: 'graceExpired',
      }),
    ).not.toThrow()

    await app.close()
  })

  it('https 옵션을 Fastify 서버로 pass-through한다 (TLS-ready)', async () => {
    const secure = buildApp({ https: {} })
    expect(secure.server).toBeInstanceOf(HttpsServer)
    await secure.close()

    const plain = buildApp()
    expect(plain.server).not.toBeInstanceOf(HttpsServer)
    await plain.close()
  })

  // ── Story 5 — 연결 수명주기 런타임(등록·close 판정·grace 재연결) 종단 배선 ──────────────────
  // registry·resolveDisconnect·lifecycle가 실 소켓 close·재접속에 배선됐는지 injectWS로 관측한다.
  // 종결 포트 호출 관측이 필요한 케이스는 스파이 lifecyclePort를 buildSeededApp으로 주입한다.

  /** onSessionEnd를 스파이하는 lifecyclePort. buildSeededApp({ lifecyclePort })로 주입해 종결을 관측한다. */
  function spyPort(): SessionLifecyclePort & { onSessionEnd: ReturnType<typeof vi.fn> } {
    return { onSessionEnd: vi.fn() }
  }

  it('command 진입 시 세션 레지스트리에 live 바인딩을 등록한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await enterCommandState(ws)

    const binding = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(binding?.link).toBe('live')
    // 바인딩의 connection이 이 소켓의 ctx를 가리킨다(등록 seam이 ctx를 배선).
    expect(binding?.connection).toBe([...app.wsConnections.values()][0])

    ws.terminate()
    await app.close()
  })

  it('command 소켓 클라 close 시 markLinkDead로 바인딩이 grace 동안 레지스트리에 유지된다', async () => {
    const port = spyPort()
    const app = buildSeededApp({ lifecyclePort: port })
    await app.ready()

    const ws = await injectAuthedWS(app)
    await enterCommandState(ws)
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link).toBe('live')

    ws.terminate()
    // transport는 정리되지만(connections 비움) 도메인 바인딩은 link-dead로 registry에 남는다(기본 grace 30s).
    await waitFor(() => app.wsConnections.size === 0)
    await waitFor(() => app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link === 'link-dead')
    // 클라 주도 drop은 grace 창일 뿐 종결이 아니다 — 포트는 호출되지 않는다.
    expect(port.onSessionEnd).not.toHaveBeenCalled()

    await app.close()
  })

  it('grace 내 같은 캐릭터 재접속·select 시 rebind되어 session:resumed 발화 + command 상태를 복원한다', async () => {
    const app = buildSeededApp()
    await app.ready()

    // 첫 소켓으로 월드 진입 후 drop → link-dead.
    const ws1 = await injectAuthedWS(app)
    await enterCommandState(ws1)
    const deadBinding = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    ws1.terminate()
    await waitFor(() => app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link === 'link-dead')

    // grace 내 새 소켓으로 재접속해 같은 캐릭터를 select한다.
    const ws2 = await injectAuthedWS(app)
    const reader = createMessageReader(ws2)
    await reader.next() // system:hello
    ws2.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // characterList
    await reader.next() // prompt(selectCharacter)
    ws2.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    const resumed = await reader.next()

    // 재연결이라 entered가 아니라 resumed가 발화된다.
    expect(resumed).toMatchObject({ type: 'session:resumed', characterId: SEED_CHARACTER_ID })
    // 새 바인딩이 map을 차지한다(옛 link-dead 객체가 아니라 새 ctx를 가리키는 live 바인딩).
    const rebound = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(rebound?.link).toBe('live')
    expect(rebound).not.toBe(deadBinding)
    expect(rebound?.connection).toBe([...app.wsConnections.values()][0])
    // command 상태가 복원돼 debug:echo가 라우터에 도달한다.
    ws2.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'r1' }))
    const echo = await reader.next()
    expect(echo).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'r1' })

    ws2.terminate()
    await app.close()
  })

  it('characterSelect 상태 close는 transport 정리만 하고 포트를 호출하지 않는다 (미등록)', async () => {
    const port = spyPort()
    const app = buildSeededApp({ lifecyclePort: port })
    await app.ready()

    const ws = await injectAuthedWS(app)
    // ready까지만 진행해 characterSelect에 머문다(select 미송신 → 레지스트리 미등록).
    const reader = createMessageReader(ws)
    await reader.next() // system:hello
    ws.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    await reader.next() // characterList
    await reader.next() // prompt(selectCharacter)

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)

    // 미등록 연결의 close는 도메인 종결 대상이 아니다 — 포트 미호출·레지스트리 미등록.
    expect(port.onSessionEnd).not.toHaveBeenCalled()
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)).toBeUndefined()

    await app.close()
  })

  it('같은 캐릭터 live 재로그인 시 기존 바인딩을 evictedByNewLogin으로 종결(포트 1회) 후 재등록한다', async () => {
    const port = spyPort()
    const app = buildSeededApp({ lifecyclePort: port })
    await app.ready()

    // 첫 소켓으로 월드 진입(live 등록).
    const ws1 = await injectAuthedWS(app)
    await enterCommandState(ws1)
    const oldBinding = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(oldBinding?.link).toBe('live')

    // 둘째 소켓으로 같은 캐릭터 재로그인 → register가 기존 live 바인딩을 evict한다.
    const ws2 = await injectAuthedWS(app)
    await enterCommandState(ws2)

    // (a) 옛 바인딩이 evictedByNewLogin으로 종결돼 포트가 정확히 1회 호출됐다.
    await waitFor(() => port.onSessionEnd.mock.calls.length === 1)
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(port.onSessionEnd).toHaveBeenCalledWith({
      accountId: SEED_ACCOUNT_ID,
      characterId: SEED_CHARACTER_ID,
      reason: 'evictedByNewLogin',
    })
    // (b) 레지스트리는 종결 후 fresh 바인딩을 보유한다(옛 객체가 아니다).
    const fresh = app.wsSessionRegistry.get(SEED_CHARACTER_ID)
    expect(fresh?.link).toBe('live')
    expect(fresh).not.toBe(oldBinding)

    // 서버 주도 종료로 옛 소켓(ws1)이 닫힌다.
    await waitFor(() => ws1.readyState === ws1.CLOSED || ws1.readyState === ws1.CLOSING)
    // §3.4 재진입 금지: 옛 소켓의 뒤늦은 close는 identity 불일치라 markLinkDead·포트 재호출을 하지 않는다
    // (포트는 여전히 1회, fresh 바인딩은 여전히 live로 유지).
    expect(port.onSessionEnd).toHaveBeenCalledTimes(1)
    expect(app.wsSessionRegistry.get(SEED_CHARACTER_ID)?.link).toBe('live')

    ws2.terminate()
    await app.close()
  })
})
