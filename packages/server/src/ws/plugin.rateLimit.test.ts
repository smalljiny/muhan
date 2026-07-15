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

  // ── (6) 마지막 연결 close 시 계정 버킷 반납 ─────────────────────────────────────
  it('마지막 연결 close 시 releaseAccount가 발화해 activeAccountCount가 감소한다', async () => {
    setLimits({ capacity: '100', refill: '100', accountCapacity: '1000', accountRefill: '1000' })
    const app = buildSeededApp()
    await app.ready()

    const ws = await injectAuthedWS(app)
    await waitFor(() => app.wsConnections.size === 1)
    // 연결 open 시 계정 버킷 엔트리가 하나 생긴다(createConnection).
    await waitFor(() => app.wsMessageRateLimiter.activeAccountCount() === 1)

    ws.terminate()
    // close 리스너가 releaseAccount를 발화해 refCount 0 → 엔트리 삭제 → activeAccountCount 0.
    await waitFor(() => app.wsMessageRateLimiter.activeAccountCount() === 0)
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(0)

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

    // 서버측 소켓(wsConnections 키)을 첫 emit 전에 캡처한다 — cleanup이 첫 close에서 엔트리를 삭제한다.
    const serverSockets = [...app.wsConnections.keys()]
    const sock1 = serverSockets[0]

    // ⚠️ ws 'close'는 이 코드베이스에서 2회 이상 발화할 수 있다(releaseQuota가 releaseOnce인 이유와 동일).
    // 첫 연결의 close를 2회 합성 발화한다 — once-guard가 없으면 releaseAccount가 이중 감소해 살아 있는
    // 형제 연결의 계정 엔트리를 지운다(activeAccountCount 0, cap 우회). once-guard가 있으면 refCount 2→1로 유지.
    sock1?.emit('close')
    sock1?.emit('close')

    // 형제(ws2) 연결이 살아 있으므로 계정 엔트리는 삭제되지 않고 유지된다(정확히 1회 감소).
    expect(app.wsMessageRateLimiter.activeAccountCount()).toBe(1)

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
