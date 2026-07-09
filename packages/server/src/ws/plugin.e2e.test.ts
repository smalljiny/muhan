import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { resetConfigForTests } from '../config/env.js'
import { PROTOCOL_VERSION, type ServerEvent } from 'shared'
import {
  buildSeededApp,
  startTestServer,
  newAuthedClient,
  waitForOpen,
  waitForMessage,
  waitForClose,
  createMessageReader,
  DEFAULT_TEST_ORIGIN,
  type AuthHeaderOptions,
  type RealClientOptions,
  type MessageReader,
} from './wsTestClient.testutil.js'
import {
  SELECT_CHARACTER_PROMPT_ID,
  CREATE_SENTINEL,
  CREATE_CONFIRM_VALUE,
  CREATE_PROMPT_IDS,
} from './fsm/sessionFsm.js'
import { SEED_CHARACTER_ID } from '../auth/inMemorySessionAuthAdapter.js'

// Story 7 — 실 네트워크 소켓 E2E. injectWS in-process 단위 테스트(plugin.test.ts)와 구별되는
// 실 TCP 흐름을 증명한다: app을 포트 0(127.0.0.1)로 리슨시키고 실 `ws` 클라이언트로 연결해
// 세션 계층 전체 경로를 관찰한다 — 인증 세션 진입(T7.1: characterList·prompt·entered 프레임 상관까지
// 단언)·create 다단 대화(T7.2: 단계별 promptId 상관)·버전 거부·하트비트 종료·진행 데드라인 close(T7.4).
// 핸드셰이크 거부(무효 쿠키 401·비허용 Origin 403)의 실 소켓 관측은 auth.gate.test.ts의 "실 소켓 관찰"
// 블록(waitForUnexpectedResponse)이 이미 소유하므로 여기서 중복하지 않는다(T7.3 완료 기준은 그 테스트가 충족).
//
// getConfig()는 연결 핸들러에서 호출되므로 MONGODB_URI를 더미로 채워 fail-fast를 피한다.
// env를 조작하는 테스트(T7.4)는 process.env 세팅 후 buildApp 전에 resetConfigForTests()로
// 싱글턴을 초기화한다(env.test.ts 격리 패턴 미러).
describe('WS transport E2E (실 소켓)', () => {
  let savedEnv: NodeJS.ProcessEnv
  // suite-level 추적 — 각 테스트가 만든 실 서버·클라이언트를 등록해 afterEach가 실패 경로에서도
  // 정리한다(리스닝 소켓 + 비-unref 하트비트 인터벌 누수 방지). 실 listen이라 누수 표면이 크다.
  let apps: FastifyInstance[]
  let clients: WebSocket[]

  beforeEach(() => {
    savedEnv = { ...process.env }
    process.env.MONGODB_URI = 'mongodb://localhost:27017'
    process.env.WS_ALLOWED_ORIGINS = DEFAULT_TEST_ORIGIN
    resetConfigForTests()
    apps = []
    clients = []
  })

  afterEach(async () => {
    // 클라이언트를 먼저 닫고 서버 close를 await한다 — preClose가 소켓을 닫고 heartbeat.stop()이
    // per-connection 인터벌을 clear해야 vitest가 열린 핸들로 행하지 않는다. close()는 idempotent라
    // 정상 종료한 테스트에서 재호출돼도 무해하다.
    for (const client of clients) client.close()
    await Promise.all(apps.map((app) => app.close()))
    process.env = savedEnv
    resetConfigForTests()
  })

  /** 실 서버를 포트 0으로 리슨시키고 소켓 URL을 돌려준다. app을 정리 목록에 등록한다. */
  async function startTracked(app: FastifyInstance): Promise<string> {
    // app.ready()는 생략한다 — startTestServer의 app.listen()이 내부적으로 ready를 await한다.
    // apps.push는 어떤 await보다 먼저 실행해 listen 실패 시에도 afterEach가 정리하게 한다.
    apps.push(app)
    return startTestServer(app)
  }

  /** 유효 쿠키+허용 Origin 실 클라이언트를 만들어 정리 목록에 등록한다(게이트 통과). */
  function trackedClient(url: string, options?: AuthHeaderOptions & RealClientOptions): WebSocket {
    const client = newAuthedClient(url, options)
    clients.push(client)
    return client
  }

  /**
   * 실 클라이언트로 연결 직후 서버가 push하는 `system:hello`를 소비해 돌려준다.
   *
   * hello는 서버가 `setImmediate`로 push하므로, message 리스너를 open **전에** 걸어야 유실되지 않는다.
   * 이 순서 불변식(listener-before-open)을 한 곳에 고정해, 각 테스트가 재현하며 실수로 뒤집는 것을 막는다.
   */
  async function consumeHello(client: WebSocket): Promise<ServerEvent> {
    const helloReceived = waitForMessage(client)
    await waitForOpen(client)
    return helloReceived
  }

  /**
   * 소켓을 characterSelect 진입까지 왕복시키고, 유실 없는 리더와 소비한 프레임을 함께 돌려준다.
   *
   * enterCommandState/enterCreateFlow(testutil)는 characterList·prompt 등 중간 프레임을 소비만 하고
   * 버려 T7.1/T7.2가 요구하는 상관 단언을 못 한다. 따라서 여기서 인라인 walk하되, 그 헬퍼들과 동일한
   * reader-before-open·before-send 규약을 지킨다 — accept가 characterList+prompt를 한 tick에 동기 발화하므로
   * 리더를 open 이전에 걸어야 두 프레임이 유실되지 않는다. hello 소비 후 system:ready를 보내 핸드셰이크를
   * 통과시키고, characterList와 selectCharacter prompt를 차례로 꺼내 반환한다(호출자가 단언·분기).
   */
  async function reachCharacterSelect(
    client: WebSocket,
  ): Promise<{ reader: MessageReader; hello: ServerEvent; characterList: ServerEvent; prompt: ServerEvent }> {
    const reader = createMessageReader(client)
    await waitForOpen(client)
    const hello = await reader.next() // system:hello
    client.send(JSON.stringify({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION }))
    const characterList = await reader.next() // session:characterList
    const prompt = await reader.next() // session:prompt(selectCharacter)
    return { reader, hello, characterList, prompt }
  }

  it('T7.1: 인증 세션 전체 경로 — hello→ready→characterList·prompt→선택→entered→command→echo', async () => {
    // 기본 하트비트 간격(25s)이라 테스트 중 ping이 발화해 간섭하지 않는다.
    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    // hello 소비·open 대기·핸드셰이크까지 왕복하고 characterList·selectCharacter prompt를 손에 쥔다.
    const { reader, hello, characterList, prompt } = await reachCharacterSelect(client)

    expect(hello).toMatchObject({ type: 'system:hello', protocolVersion: PROTOCOL_VERSION })

    // characterList에 시드 캐릭터가 실려 온다(빈 목록 아님) — accept 직후 서버가 계정 캐릭터를 조회해 발화.
    expect(characterList.type).toBe('session:characterList')
    if (characterList.type === 'session:characterList') {
      expect(characterList.characters).toContainEqual(
        expect.objectContaining({ characterId: SEED_CHARACTER_ID, name: '무한전사' }),
      )
    }

    // selectCharacter prompt는 결정적 promptId·kind를 싣는다(sessionFsm 상수 대조, 하드코딩 금지).
    expect(prompt).toMatchObject({
      type: 'session:prompt',
      kind: 'selectCharacter',
      promptId: SELECT_CHARACTER_PROMPT_ID,
    })

    // 시드 캐릭터를 선택하면 소유권 게이트를 통과해 entered로 월드에 진입한다.
    client.send(JSON.stringify({ type: 'session:selectCharacter', characterId: SEED_CHARACTER_ID }))
    const entered = await reader.next() // session:entered
    expect(entered).toMatchObject({ type: 'session:entered', characterId: SEED_CHARACTER_ID })

    // command 상태이므로 debug:echo가 라우터 dispatch에 도달해 echo:result로 돌아온다(command 도달 증명).
    client.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'c1' }))
    const echo = await reader.next()
    expect(echo).toMatchObject({ type: 'debug:echo:result', text: '핑', correlationId: 'c1' })
    expect(client.readyState).toBe(client.OPEN)
    // 서버·클라이언트 정리는 afterEach가 소유한다(실패 경로 포함).
  })

  it('T7.2: create 다단 — sentinel→이름→클래스→종족→확인→entered→command→echo', async () => {
    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    // characterSelect까지 왕복해 select prompt를 확보한 뒤, sentinel로 응답해 create로 전이한다.
    const { reader, prompt } = await reachCharacterSelect(client)
    expect(prompt).toMatchObject({ type: 'session:prompt', promptId: SELECT_CHARACTER_PROMPT_ID })

    // 각 단계 promptId 상관을 정확히 지켜 왕복한다 — 서버가 발화한 prompt의 promptId로만 다음 reply를 짝짓는다.
    client.send(
      JSON.stringify({ type: 'session:reply', promptId: SELECT_CHARACTER_PROMPT_ID, value: CREATE_SENTINEL }),
    )
    const namePrompt = await reader.next() // session:prompt(create:name)
    expect(namePrompt).toMatchObject({ type: 'session:prompt', kind: 'createField', promptId: CREATE_PROMPT_IDS.name })

    client.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.name, value: '테스토스' }))
    const classPrompt = await reader.next() // session:prompt(create:class)
    expect(classPrompt).toMatchObject({ type: 'session:prompt', promptId: CREATE_PROMPT_IDS.class })

    client.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.class, value: '2' }))
    const racePrompt = await reader.next() // session:prompt(create:race)
    expect(racePrompt).toMatchObject({ type: 'session:prompt', promptId: CREATE_PROMPT_IDS.race })

    client.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.race, value: '3' }))
    const confirmPrompt = await reader.next() // session:prompt(create:confirm)
    expect(confirmPrompt).toMatchObject({ type: 'session:prompt', promptId: CREATE_PROMPT_IDS.confirm })

    // confirm 승인값으로 확정하면 새 캐릭터가 생성되고 entered로 command에 진입한다.
    client.send(JSON.stringify({ type: 'session:reply', promptId: CREATE_PROMPT_IDS.confirm, value: CREATE_CONFIRM_VALUE }))
    const entered = await reader.next() // session:entered
    expect(entered.type).toBe('session:entered')
    if (entered.type === 'session:entered') {
      // 시드 캐릭터(seed-char-1)가 아니라 새로 생성된 캐릭터 id(어댑터 createCharacter의 char-N)로 입장한다.
      expect(entered.characterId).toMatch(/^char-/)
    }

    // command 도달 증명 — echo 왕복이 라우터 dispatch까지 관통한다.
    client.send(JSON.stringify({ type: 'debug:echo', text: '퐁', id: 'c2' }))
    const echo = await reader.next()
    expect(echo).toMatchObject({ type: 'debug:echo:result', text: '퐁', correlationId: 'c2' })
    // 정리는 afterEach가 소유한다.
  })

  it('T7.4: 진행 데드라인 close — characterSelect에서 미진행 시 소켓이 close된다', async () => {
    // 짧은 진행 데드라인(80ms) + 데드라인의 수십 배로 큰 하트비트 간격(2000ms)으로 무장한다. 하트비트
    // terminate는 ≈ interval×(maxMissed+1) ≈ 8s라 이 창에 절대 발화하지 않으므로, 80ms 근방의 close는
    // 오직 진행 데드라인(graceful close)이 원인임을 타이밍으로 격리한다(하트비트 terminate와 구별).
    // env 세팅 후 buildApp 전에 싱글턴을 초기화해 이 테스트만의 데드라인 튜닝이 적용되게 한다.
    process.env.WS_SESSION_DEADLINE_MS = '80'
    process.env.WS_HEARTBEAT_PING_INTERVAL_MS = '2000'
    resetConfigForTests()

    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    // characterSelect까지 진입하면 데드라인이 무장된다(enterInitialState→rearmDeadline). 이후 진행하지 않는다
    // (selectCharacter/reply 미송신) — 데드라인이 만료되어 서버가 소켓을 close해야 한다.
    const { prompt } = await reachCharacterSelect(client)
    expect(prompt).toMatchObject({ type: 'session:prompt', promptId: SELECT_CHARACTER_PROMPT_ID })

    // 데드라인 80ms + 넉넉한 close 대기 마진(2000ms)으로 flaky를 피한다. close 이벤트가 오면 데드라인 만료→
    // close 체인이 실 플러그인 배선을 관통한 것이다. close code로 원인 메커니즘을 자체 검증한다: 진행 데드라인은
    // deadline.socket.close()(상태코드 없는 graceful close)라 1005로 관측되고, 하트비트 terminate는 1006이다.
    // 1005 단언은 이 close가 하트비트가 아니라 진행 데드라인에서 왔음을 타이밍 격리에 더해 코드로도 못박는다.
    const code = await waitForClose(client, 2000)
    expect(code).toBe(1005)
    // 정리는 afterEach가 소유한다.
  })

  it('버전 불일치 시 실 클라이언트가 system:reload를 수신하고 소켓이 닫힌다', async () => {
    const url = await startTracked(buildSeededApp())
    const client = trackedClient(url)

    await consumeHello(client)

    // reload 프레임 수신과 close를 send 전에 모두 건다 — 서버는 reload를 먼저 보내고 다음 tick에
    // close한다. 실 TCP는 단일 연결 in-order 전달이라 reload가 close 앞에 확실히 도착한다.
    const reloadReceived = waitForMessage(client)
    const closed = waitForClose(client)
    client.send(JSON.stringify({ type: 'system:ready', protocolVersion: 999 }))

    const reload = await reloadReceived
    expect(reload).toMatchObject({ type: 'system:reload' })

    const code = await closed
    expect(typeof code).toBe('number')
    // 정리는 afterEach가 소유한다.
  })

  it('pong 미응답 시 서버가 실 소켓을 terminate한다 (단일 하트비트-miss)', async () => {
    // 짧은 ping 간격 + MAX_MISSED=1로 종료를 bounded 시간 안에 강제한다. env 세팅 후 buildApp
    // 전에 싱글턴을 초기화해 이 테스트만의 하트비트 튜닝이 적용되게 한다.
    process.env.WS_HEARTBEAT_PING_INTERVAL_MS = '50'
    process.env.WS_HEARTBEAT_MAX_MISSED = '1'
    resetConfigForTests()

    const url = await startTracked(buildSeededApp())

    // autoPong:false가 없으면 클라이언트가 프로토콜 레벨에서 ping에 자동 pong해 절대 terminate되지
    // 않는다 — 자동 pong을 억제해 미응답을 강제한다.
    const client = trackedClient(url, { autoPong: false })
    await consumeHello(client)

    // 약 2 인터벌(≈100ms) 뒤 서버가 terminate → 클라이언트 close 이벤트 발화. bounded 2s 대기.
    const closed = waitForClose(client, 2000)
    const code = await closed
    expect(typeof code).toBe('number')
    // 정리는 afterEach가 소유한다.
  })
})
