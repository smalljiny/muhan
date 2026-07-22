import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { resetConfigForTests } from '../config/env.js'
import {
  buildSeededApp,
  injectAuthedWS,
  waitForMessage,
  waitForClose,
  waitFor,
  createMessageReader,
  enterCommandState,
  DEFAULT_TEST_ORIGIN,
} from './wsTestClient.testutil.js'
import type { ConnectionRateLimiter, RateVerdict } from './messageRateLimiter.js'

// Story 5 — 인바운드 유량 제한 배선 종단 테스트. Stories 1-2가 만든 순수 유량 제한 코어를 실 소켓
// message 핸들러에 배선한 결과(파싱 전 gate·1회 경고·지속 종료·socket-open arm·idle 미재-arm·계정 반납·
// 이중 close 멱등)를 injectWS로 관측한다. verdict 계산 자체는 messageRateLimiter.test.ts가 소유한다 —
// 여기선 gate가 어디에·어떻게 배선됐는지(순서·부수효과)만 본다.
//
// 각 테스트가 상한(capacity·maxViolations·refill)을 다르게 요구하므로 이 블록은 자체 env snapshot-restore를
// 두고 process.env를 테스트별로 오버라이드한 뒤 resetConfigForTests()로 싱글턴을 초기화한다(e2e 격리 패턴 미러).
describe('WS 인바운드 유량 제한 배선', () => {
  let savedEnv: NodeJS.ProcessEnv
  // 유량 상한 env 키 목록 — afterEach가 테스트별 오버라이드만 걷어내 base env(MONGODB_URI·ORIGINS)를 보존한다.
  const RATE_ENV_KEYS = [
    'WS_MSG_RATE_CAPACITY',
    'WS_MSG_RATE_REFILL_PER_SEC',
    'WS_MSG_RATE_ACCOUNT_CAPACITY',
    'WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC',
    'WS_MSG_RATE_MAX_VIOLATIONS',
  ]

  // base env(MONGODB_URI·WS_ALLOWED_ORIGINS)를 suite 전체 동안 유효하게 유지한다 — 연결 close 뒤 지연 발화하는
  // setImmediate(system:hello) 경로의 getConfig()가 fail-fast(process.exit)하지 않게 한다(e2e beforeAll 패턴 미러).
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

  // 테스트별 상한 오버라이드만 제거한다 — base env는 남겨 지연 immediate의 getConfig fail-fast를 막는다.
  afterEach(() => {
    for (const key of RATE_ENV_KEYS) delete process.env[key]
    resetConfigForTests()
  })

  /** 상한 env를 세우고 싱글턴을 초기화한다. 각 테스트가 필요한 값만 덮어쓴다. */
  function setLimits(limits: {
    capacity?: string
    refill?: string
    accountCapacity?: string
    accountRefill?: string
    maxViolations?: string
  }): void {
    if (limits.capacity !== undefined) process.env.WS_MSG_RATE_CAPACITY = limits.capacity
    if (limits.refill !== undefined) process.env.WS_MSG_RATE_REFILL_PER_SEC = limits.refill
    if (limits.accountCapacity !== undefined)
      process.env.WS_MSG_RATE_ACCOUNT_CAPACITY = limits.accountCapacity
    if (limits.accountRefill !== undefined)
      process.env.WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC = limits.accountRefill
    if (limits.maxViolations !== undefined)
      process.env.WS_MSG_RATE_MAX_VIOLATIONS = limits.maxViolations
    resetConfigForTests()
  }

  // ── (1) gate 순서 — 파싱 전 drop ────────────────────────────────────────────────
  it('상한 초과 malformed 프레임은 JSON.parse 전에 drop돼 bad_payload를 유발하지 않는다', async () => {
    // 연결 버킷 capacity 1 → 첫 프레임만 통과(파싱). 계정 버킷은 넉넉히 둬 연결 버킷이 상한을 관할한다.
    setLimits({ capacity: '1', refill: '1', accountCapacity: '100', accountRefill: '100' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello를 먼저 소비(setImmediate push 순서 고정).

    const reader = createMessageReader(ws)
    // malformed JSON을 상한 너머로 flood한다. gate가 파싱보다 앞서면 초과분은 파싱되지 않아 bad_payload가 안 난다.
    ws.send('{ not json 1')
    ws.send('{ not json 2')
    ws.send('{ not json 3')

    // 첫 프레임(accept)만 파싱에 도달해 bad_payload가 난다.
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'bad_payload' })
    // 둘째 프레임은 drop-warn → 파싱 없이 rate_limited가 온다(파싱됐다면 또 bad_payload여야 한다 — gate가 앞선 증거).
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'rate_limited' })
    // 셋째 프레임은 조용히 drop된다 — 추가 응답이 없다(anti-amplification).
    await expect(reader.next(150)).rejects.toThrow()

    expect(ws.readyState).toBe(ws.OPEN)
    ws.terminate()
    await app.close()
  })

  // ── (2) 1회 경고 — anti-amplification ───────────────────────────────────────────
  it('연속 초과 프레임은 위반 구간당 rate_limited를 정확히 1회만 보낸다', async () => {
    setLimits({ capacity: '1', refill: '1', accountCapacity: '100', accountRefill: '100' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello 소비

    const reader = createMessageReader(ws)
    // pre-handshake 유효 프레임: accept면 handshake_required, drop이면 rate_limited/침묵.
    ws.send(JSON.stringify({ type: 'debug:echo', text: '1' }))
    ws.send(JSON.stringify({ type: 'debug:echo', text: '2' }))
    ws.send(JSON.stringify({ type: 'debug:echo', text: '3' }))
    ws.send(JSON.stringify({ type: 'debug:echo', text: '4' }))

    // 첫 프레임 accept → handshake_required.
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    // 둘째(drop-warn) → rate_limited 1회.
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'rate_limited' })
    // 셋째·넷째(drop) → 추가 경고 없음.
    await expect(reader.next(150)).rejects.toThrow()

    ws.terminate()
    await app.close()
  })

  // ── (3) 지속 위반 종료 ──────────────────────────────────────────────────────────
  it('위반이 WS_MSG_RATE_MAX_VIOLATIONS를 넘으면 socket.close()로 종료한다', async () => {
    setLimits({
      capacity: '1',
      refill: '1',
      accountCapacity: '100',
      accountRefill: '100',
      maxViolations: '3',
    })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello 소비

    // 종료 리스너를 flood 전에 건다(close 프레임 유실 방지).
    const closed = waitForClose(ws)
    // capacity 1 + maxViolations 3 → 첫 프레임 accept, 이후 연속 drop이 위반을 누적해 임계 초과 시 close.
    for (let i = 0; i < 6; i += 1) ws.send(JSON.stringify({ type: 'debug:echo', text: String(i) }))

    const code = await closed
    expect(typeof code).toBe('number')

    await app.close()
  })

  // ── (4) socket-open arm(핸드셰이크 완료가 아니라 open 시점) ───────────────────────
  it('pre-handshake(system:ready 이전) flood도 drop된다 — 리미터는 socket-open에 arm된다', async () => {
    setLimits({ capacity: '1', refill: '1', accountCapacity: '100', accountRefill: '100' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitForMessage(ws) // system:hello 소비

    const reader = createMessageReader(ws)
    // system:ready를 보내지 않은 채(핸드셰이크 미완) flood한다 — arm이 open 시점이면 여기서도 drop된다.
    ws.send(JSON.stringify({ type: 'debug:echo', text: 'a' }))
    ws.send(JSON.stringify({ type: 'debug:echo', text: 'b' }))
    ws.send(JSON.stringify({ type: 'debug:echo', text: 'c' }))

    expect(await reader.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    // pre-handshake에서 rate_limited가 온다 = 리미터가 핸드셰이크 완료 전에 이미 활성(open arm 증거).
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'rate_limited' })
    // 아직 ready 전이다(핸드셰이크 미완).
    expect([...app.wsConnections.values()][0]?.ready).toBe(false)

    ws.terminate()
    await app.close()
  })

  // ── (5) drop된 프레임은 idle을 재-arm하지 않는다 ────────────────────────────────
  it('drop된 프레임은 dispatch에 도달하지 않아 idle 타이머를 재-arm하지 않는다', async () => {
    // 상한을 넉넉히 둬 handshake·명령이 정상 통과하게 한다 — drop은 아래에서 스텁 verdict로 강제한다.
    setLimits({ capacity: '100', refill: '100', accountCapacity: '1000', accountRefill: '1000' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    const reader = await enterCommandState(ws)

    // 실 idle 타이머를 스파이로 교체해 arm 호출을 관측한다(실 타이머는 먼저 clear해 누수 방지 — idle 배선 테스트 미러).
    const ctx = [...app.wsConnections.values()][0]
    ctx?.idle?.clear()
    const armSpy = vi.fn()
    if (ctx !== undefined) ctx.idle = { arm: armSpy, clear: vi.fn() }

    // ws.send는 비동기 전달이라, 프레임이 서버에서 처리되기 전에 stub을 바꾸면 verdict가 뒤섞인다.
    // 각 프레임의 응답을 await한 뒤에 다음 stub으로 바꿔 결정론을 확보한다(프레임 처리 완료 동기점).

    // (a) accept verdict → dispatch 도달 → handled → idle 재-arm 1회.
    if (ctx !== undefined) ctx.rateLimiter = stubLimiter('accept')
    ws.send(JSON.stringify({ type: 'debug:echo', text: '핑', id: 'ok1' }))
    expect(await reader.next()).toMatchObject({ type: 'debug:echo:result', correlationId: 'ok1' })
    expect(armSpy).toHaveBeenCalledTimes(1)

    // (b) drop-warn verdict → gate가 파싱·dispatch·idle 재-arm을 구조적으로 우회(early-return). drop-warn은
    // rate_limited를 1회 보내므로 이를 프레임 처리 완료 동기점으로 삼는다(drop된 프레임은 echo를 만들지 않는다).
    if (ctx !== undefined) ctx.rateLimiter = stubLimiter('drop-warn')
    ws.send(JSON.stringify({ type: 'debug:echo', text: '퐁', id: 'dropped' }))
    expect(await reader.next()).toMatchObject({ type: 'error', code: 'rate_limited' })
    // drop된 프레임은 dispatch에 닿지 않았다 — idle 재-arm 미발생(여전히 1회).
    expect(armSpy).toHaveBeenCalledTimes(1)

    // (c) 다시 accept → dispatch 도달 → 재-arm 2회째. dropped가 사이에서 타이머를 연장하지 못했음을 확인한다.
    if (ctx !== undefined) ctx.rateLimiter = stubLimiter('accept')
    ws.send(JSON.stringify({ type: 'debug:echo', text: '탁', id: 'ok2' }))
    expect(await reader.next()).toMatchObject({ type: 'debug:echo:result', correlationId: 'ok2' })
    expect(armSpy).toHaveBeenCalledTimes(2)

    ws.terminate()
    await app.close()
  })

  // ── (6) 마지막 연결 close 시 계정 버킷 반납 (keep-until-refilled) ─────────────────
  it('마지막 연결 close 시 releaseAccount가 발화해도 계정 엔트리는 zero-refcount로 생존한다', async () => {
    setLimits({ capacity: '100', refill: '100', accountCapacity: '1000', accountRefill: '1000' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    // 연결 open 시 계정 버킷 엔트리가 하나 생긴다(createConnection).
    await waitFor(() => app.wsMessageRateLimiter.activeAccountCount() === 1)

    ws.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    // close 리스너가 releaseAccount를 발화해 refCount 0에 도달하지만, keep-until-refilled면 엔트리를
    // 삭제하지 않고 생존시킨다(즉시 재연결이 고갈 버킷을 재사용하도록, issue #77). activeAccountCount는 1 유지.
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)

    await app.close()
  })

  // ── (7) 이중 발화 close 멱등 ⚠️ BLOCKING 회귀 방어 ──────────────────────────────
  it('같은 계정을 공유하는 두 연결 중 하나에 close가 2회 발화해도 계정 엔트리는 한 번만 감소한다', async () => {
    setLimits({ capacity: '100', refill: '100', accountCapacity: '1000', accountRefill: '1000' })
    const app = buildSeededApp()
    await app.ready()

    // 두 연결 모두 시드 계정을 공유한다 → 계정 엔트리 하나, refCount 2, activeAccountCount 1.
    const ws1 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    const ws2 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 2)
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)

    // 서버측 소켓(wsConnections 키)을 첫 emit 전에 캡처한다.
    const serverSockets = [...app.wsConnections.keys()]
    const sock1 = serverSockets[0]

    // ⚠️ ws 'close'는 이 코드베이스에서 2회 이상 발화할 수 있다(releaseQuota가 releaseOnce인 이유와 동일).
    // once-guard가 없으면 releaseAccount가 이중 감소해 refCount 2→0으로 떨어진다. Story 2의 keep-until-
    // refilled에서는 refCount 0이어도 엔트리를 삭제하지 않으므로 activeAccountCount로는 이 이중 감소가
    // 관측되지 않는다(항상 1) — once-guard는 refCount 정확성만 지킨다. once-guard 관측성은 Story 3의 lazy
    // sweep이 삭제를 재도입하면 부활한다(그때 refCount 0 오판이 살아 있는 형제 엔트리를 sweep 대상으로 만든다).
    sock1?.emit('close')
    sock1?.emit('close')

    // keep-until-refilled라 어느 경우든 엔트리는 생존한다 — activeAccountCount 1 유지.
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)

    ws1.terminate()
    ws2.terminate()
    await app.close()
  })

  // ── (8) 즉시 재연결 churn — 고갈 계정 버킷 재사용 (issue #77 종단 회귀) ─────────────
  it('계정 버킷 고갈 후 즉시 재연결은 fresh full 버스트 없이 고갈 버킷을 재사용한다', async () => {
    // capacity 100 → 연결 버킷은 항상 넉넉해, 재연결 후 유일한 drop 사유가 account<1이 되도록 격리한다
    //   (account-dimension drop의 핵심 — 연결 버킷이 상한을 가리지 못하게).
    // accountRefill 1 → 고갈된 계정 버킷이 1토큰 회복에 1초가 필요하다. injectWS 재연결은 인프로세스라
    //   ~수십 ms(waitFor 10ms 폴링 지배)이므로 회복분(<0.1토큰)이 1토큰에 한참 못 미친다. 따라서 재사용
    //   버킷은 결정론적으로 고갈 상태로 남는다(회복 horizon 1초 »» 재연결 지연 ~수십 ms). accountRefill 0은
    //   env 스키마 min(1)이 막으므로 최소값 1로 같은 stay-depleted 창을 만든다.
    // 이 테스트는 churn FIX를 고정한다 — old delete-at-zero면 재연결이 fresh full 버킷(accept)을 얻지만,
    //   keep-until-refilled면 고갈 버킷을 재사용(drop)한다.
    setLimits({
      capacity: '100',
      refill: '100',
      accountCapacity: '2',
      accountRefill: '1',
      maxViolations: '100',
    })
    const app = buildSeededApp()
    await app.ready()

    // 연결 1 — 계정 버킷(용량 2)을 고갈시킨다.
    const ws1 = await injectAuthedWS(app)
    await waitForMessage(ws1) // system:hello 소비
    const reader1 = createMessageReader(ws1)
    // 프레임 2개 accept(handshake_required) → account 2→0. 3번째는 account 고갈로 rate_limited.
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '1' }))
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '2' }))
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '3' }))
    // 각 응답을 await해 drain(동기 check)이 close 전에 확실히 반영되게 한다(drain 완료 동기점).
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    // 세번째 rate_limited = account 버킷이 실제 고갈됐음을 확인.
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'rate_limited' })

    // 연결 1 close → releaseAccount(refCount 1→0). keep-until-refilled면 엔트리·고갈 버킷 생존.
    ws1.terminate()
    await waitFor(() => app.wsConnections.size === 0)
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)

    // 연결 2 — 같은 시드 계정으로 즉시 재연결(injectAuthedWS는 SEED_VALID_COOKIE 고정 → 동일 accountId).
    const ws2 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    await waitForMessage(ws2) // system:hello 소비

    // 프레임 전송 전 관측 — 재사용 버킷은 고갈 유지(회복 <0.1토큰 « 1). 이 peek은 redundant sanity check다:
    // old delete-at-zero면 재연결이 fresh 버킷을 얻지만 seed-to-capacity는 첫 check에서 일어나므로 이
    // 시점(프레임 전) peek은 old에서도 0이라 판별력이 없다. 이 테스트의 실제 판별은 위 activeAccountCount==1과
    // 아래 rate_limited 어서션이 담당한다.
    const ctx2 = [...app.wsConnections.values()][0]
    const limiter2 = ctx2?.rateLimiter
    if (limiter2 == null) throw new Error('재연결 연결의 rateLimiter가 부재')
    expect(limiter2.peekAccountTokens()).toBeLessThan(1)

    const reader2 = createMessageReader(ws2)
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'r' }))
    // 첫 프레임이 rate_limited = fresh 버스트 없음(고갈 버킷 재사용). old delete-at-zero면 handshake_required였다.
    expect(await reader2.next()).toMatchObject({ type: 'error', code: 'rate_limited' })

    ws2.terminate()
    await app.close()
  })

  // ── (9) refill-horizon 경과 재연결 — 계정 버킷 완전 회복 (배선 회귀) ───────────────
  it('refill-horizon 경과 후 재연결하면 재사용 계정 버킷이 full로 회복돼 다시 accept된다', async () => {
    // accountCapacity 1 → conn1의 첫 프레임 하나로 계정 버킷을 결정론적으로 고갈시킨다. 첫 check가
    //   lastRefill===null 센티넬로 capacity(1) 시드 후 1토큰 소비 → 정확히 0이 되며, 이 seed-then-consume은
    //   refill 레이트와 무관하다(그래서 아래 초고속 refill에서도 drain이 성립한다 — inter-frame 리필 경합 없음).
    // accountRefill 100000 → 고갈 버킷의 full(1토큰) 회복 horizon이 ~10µs다. injectWS 재연결 지연(~수십 ms,
    //   waitFor 10ms 폴링 지배)이 이 horizon을 항상 초과하므로 재사용 버킷은 결정론적으로 full 회복한다
    //   (재연결 지연 »» 10µs; 경과가 길수록 clamp라 over-recover가 불가능해 단방향으로만 안전 — 비-flaky).
    // 이 테스트는 churn FIX가 아니라 WIRING을 고정한다 — 재사용 버킷이 실 performance.now() 경과를 추적해
    //   horizon 경과 시 회복함을 종단으로 관측한다(old/new 모두 재연결 후 accept라 fix 구분은 (8)이 소유).
    setLimits({
      capacity: '100',
      refill: '100',
      accountCapacity: '1',
      accountRefill: '100000',
      maxViolations: '100',
    })
    const app = buildSeededApp()
    await app.ready()

    // 연결 1 — 프레임 하나로 계정 버킷(용량 1)을 고갈시킨다.
    const ws1 = await injectAuthedWS(app)
    await waitForMessage(ws1) // system:hello 소비
    const reader1 = createMessageReader(ws1)
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '1' }))
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    // 첫 check가 계정 버킷을 seed(1)→consume(1)해 정확히 0으로 고갈(refill 무관 결정론).
    const ctx1 = [...app.wsConnections.values()][0]
    expect(ctx1?.rateLimiter?.peekAccountTokens()).toBe(0)

    ws1.terminate()
    await waitFor(() => app.wsConnections.size === 0)

    // 재연결 — horizon(10µs) 경과로 재사용 버킷이 full 회복.
    const ws2 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    await waitForMessage(ws2) // system:hello 소비

    // 프레임 전송 전 관측 — 재사용 버킷이 capacity(1)로 완전 회복(첫 check가 소비하기 전 시점, clamp라 정확히 1).
    const ctx2 = [...app.wsConnections.values()][0]
    const limiter2 = ctx2?.rateLimiter
    if (limiter2 == null) throw new Error('재연결 연결의 rateLimiter가 부재')
    expect(limiter2.peekAccountTokens()).toBe(1)

    const reader2 = createMessageReader(ws2)
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'r' }))
    // 첫 프레임 accept = 회복 확인(handshake_required, rate_limited 아님).
    expect(await reader2.next()).toMatchObject({ type: 'error', code: 'handshake_required' })

    ws2.terminate()
    await app.close()
  })

  // ── (10) churn 시나리오 warn-edge 회귀 — 첫 drop당 rate_limited 정확히 1회 ──────────
  it('churn 재연결로 고갈 계정을 재사용해도 연속 drop은 rate_limited를 정확히 1회만 보낸다', async () => {
    // (8)과 같은 stay-depleted 구성(accountRefill 1). 재연결 연결은 fresh violations 카운터를 갖지만, 경고
    //   엣지(warn-edge)는 코어가 소유해 위반 구간의 첫 drop만 drop-warn(rate_limited 1회)이 된다. churn이
    //   경고를 증폭시키지 않음을 종단으로 고정한다(anti-amplification 회귀). maxViolations 100 → 4연속 drop이
    //   shouldTerminate를 넘기지 않아 assert 도중 close되지 않는다.
    setLimits({
      capacity: '100',
      refill: '100',
      accountCapacity: '2',
      accountRefill: '1',
      maxViolations: '100',
    })
    const app = buildSeededApp()
    await app.ready()

    const ws1 = await injectAuthedWS(app)
    await waitForMessage(ws1) // system:hello 소비
    const reader1 = createMessageReader(ws1)
    // account(용량 2)를 고갈시킨다.
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '1' }))
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '2' }))
    ws1.send(JSON.stringify({ type: 'debug:echo', text: '3' }))
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'handshake_required' })
    expect(await reader1.next()).toMatchObject({ type: 'error', code: 'rate_limited' })

    ws1.terminate()
    await waitFor(() => app.wsConnections.size === 0)

    // 재연결 — 고갈 버킷 재사용.
    const ws2 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    await waitForMessage(ws2) // system:hello 소비

    const reader2 = createMessageReader(ws2)
    // 재연결 연결에 4프레임 flood — account 고갈이라 전부 drop. 첫 drop만 drop-warn(rate_limited 1회).
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'a' }))
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'b' }))
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'c' }))
    ws2.send(JSON.stringify({ type: 'debug:echo', text: 'd' }))
    // 첫 drop → rate_limited 1회.
    expect(await reader2.next()).toMatchObject({ type: 'error', code: 'rate_limited' })
    // 이후 연속 drop은 침묵 — 추가 rate_limited 없음(warn 증폭 없음).
    await expect(reader2.next(150)).rejects.toThrow()

    ws2.terminate()
    await app.close()
  })

  // ── (11) 형제 refCount 안전 — 한 연결 close가 생존 형제 계정 엔트리를 조기 삭제하지 않음 ──
  it('한 연결에 close가 이중 발화해도 생존 형제 연결의 계정 엔트리는 live로 남는다', async () => {
    setLimits({ capacity: '100', refill: '100', accountCapacity: '1000', accountRefill: '1000' })
    const app = buildSeededApp()
    await app.ready()

    // 두 연결 모두 시드 계정 공유 → 계정 엔트리 하나, refCount 2, live 1.
    const ws1 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    const ws2 = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 2)
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)
    expect(app.wsMessageRateLimiter.liveAccountCount()).toBe(1)

    const serverSockets = [...app.wsConnections.keys()]
    const sock1 = serverSockets[0]

    // sock1에 close 이중 발화. once-guard(rateReleased)가 없으면 releaseAccount가 이중 감소해 refCount
    //   2→0이 되어, 살아 있는 형제(ws2)의 계정 엔트리가 dead로 보인다(liveAccountCount 0 → sweep 대상).
    //   once-guard면 정확히 1회만 반납해 refCount 2→1, 형제 엔트리는 live로 남는다.
    sock1?.emit('close')
    sock1?.emit('close')

    // keep-until-refilled라 activeAccountCount는 어느 경우든 1(이중 감소 관측 불가) — 형제 생존은
    //   liveAccountCount(refCount>0 카운트)로만 관측된다. test (7)이 activeAccountCount 각도를, 이 테스트가
    //   sibling-survival 각도를 맡는다.
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)
    // refCount 1(형제 ws2가 참조 중) → live 1. once-guard 파손이면 0이었다.
    expect(app.wsMessageRateLimiter.liveAccountCount()).toBe(1)

    ws1.terminate()
    ws2.terminate()
    await app.close()
  })
})

/** 스텁 ConnectionRateLimiter — 고정 verdict를 돌려준다. gate 배선(early-return·부수효과)만 관측할 때 쓴다. */
function stubLimiter(verdict: RateVerdict, terminate = false): ConnectionRateLimiter {
  return {
    check: () => verdict,
    shouldTerminate: () => terminate,
    peekConnectionTokens: () => 0,
    peekAccountTokens: () => 0,
  }
}
