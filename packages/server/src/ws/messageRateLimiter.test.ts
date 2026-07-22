import { describe, it, expect } from 'vitest'

import { createMessageRateLimiterFactory } from './messageRateLimiter.js'
import type { MessageRateLimits } from './messageRateLimiter.js'

/**
 * 연결 차원만 시험하는 단일 연결 핸들을 만든다. factory가 유일한 프로덕션 경로이므로 연결 차원도
 * `createConnection` 핸들로 검증한다. 계정 버킷이 연결 차원 판정에 끼어들지 않도록 accountCapacity를
 * 넉넉히(고갈 불가) 두고 리필은 0으로 둔다 — verdict는 오롯이 연결 버킷·위반 카운터에서만 나온다.
 */
function makeLimiter(capacity: number, refillPerSec: number, maxViolations: number) {
  const limits: MessageRateLimits = {
    capacity,
    refillPerSec,
    maxViolations,
    accountCapacity: Number.MAX_SAFE_INTEGER,
    accountRefillPerSec: 0,
    accountMaxEntries: 4096,
  }
  return createMessageRateLimiterFactory(() => limits).createConnection('solo', 0)
}

/** 고정 상한으로 factory를 만든다. 결정적 상수를 combined limits로 넘긴다. */
function makeFactory(overrides: Partial<MessageRateLimits> = {}) {
  const limits: MessageRateLimits = {
    capacity: 10,
    refillPerSec: 0,
    maxViolations: 100,
    accountCapacity: 10,
    accountRefillPerSec: 0,
    accountMaxEntries: 4096,
    ...overrides,
  }
  return createMessageRateLimiterFactory(() => limits)
}

describe('연결 차원 (factory.createConnection 핸들)', () => {
  it('버킷이 가득 찬 상태에서 용량 이내 연속 check는 모두 accept한다', () => {
    // capacity=3 → 같은 now에서 3번 소비 성공, 4번째는 토큰 고갈로 drop.
    const limiter = makeLimiter(3, 1, 5)

    expect(limiter.check(0)).toBe('accept')
    expect(limiter.check(0)).toBe('accept')
    expect(limiter.check(0)).toBe('accept')
    expect(limiter.check(0)).toBe('drop-warn')
  })

  it('첫 check에서 버킷을 capacity로 시드하고 토큰 1개를 소비한다', () => {
    // 인스펙터로 시드+소비를 직접 관측: 첫 accept 후 남은 토큰은 capacity-1.
    const limiter = makeLimiter(3, 1, 5)

    expect(limiter.check(0)).toBe('accept')
    expect(limiter.peekConnectionTokens()).toBeCloseTo(2)
  })

  it('limits thunk를 첫 check에서 지연 조회한다 — 생성 후 변경을 반영한다', () => {
    let capacity = 1
    const limiter = createMessageRateLimiterFactory(() => ({
      capacity,
      refillPerSec: 0,
      maxViolations: 5,
      accountCapacity: Number.MAX_SAFE_INTEGER,
      accountRefillPerSec: 0,
      accountMaxEntries: 4096,
    })).createConnection('solo', 0)

    // 생성 후 첫 check 전에 상한을 바꾸면 첫 check가 이 값을 시드로 반영해야 한다.
    capacity = 2

    expect(limiter.check(0)).toBe('accept') // 시드=2, 소비 후 1
    expect(limiter.check(0)).toBe('accept') // 소비 후 0
    expect(limiter.check(0)).toBe('drop-warn') // 고갈
  })

  it('now 전진 시 elapsedSec * refillPerSec 만큼 비례 리필한다', () => {
    // capacity=2, refill=1/s. 2개 소비로 고갈 후 1초 경과 → 토큰 1개 회복 → 1번 accept.
    const limiter = makeLimiter(2, 1, 5)

    expect(limiter.check(0)).toBe('accept') // 2 → 1
    expect(limiter.check(0)).toBe('accept') // 1 → 0
    expect(limiter.check(0)).toBe('drop-warn') // 0 → drop

    expect(limiter.check(1000)).toBe('accept') // +1초 → 1토큰 리필 → 소비 (warn-edge 재무장)
    expect(limiter.check(1000)).toBe('drop-warn') // 다시 고갈 → 재무장된 엣지라 warn
  })

  it('리필은 capacity를 넘지 않는다 — 큰 시간 경과에도 상한에서 clamp된다', () => {
    // capacity=2 소진 후 100초 경과 → min(2, 100)=2. 딱 2개만 accept, 3번째 drop.
    const limiter = makeLimiter(2, 1, 5)

    limiter.check(0) // 2 → 1
    limiter.check(0) // 1 → 0
    limiter.check(0) // drop

    expect(limiter.check(100_000)).toBe('accept') // clamp된 2 → 1 (warn-edge 재무장)
    expect(limiter.check(100_000)).toBe('accept') // 1 → 0
    expect(limiter.check(100_000)).toBe('drop-warn') // clamp가 없으면 100토큰이라 계속 accept였을 것
    expect(limiter.peekConnectionTokens()).toBeCloseTo(0)
  })

  it('maxViolations 연속 drop 후 shouldTerminate가 true가 된다', () => {
    // capacity=1, refill=0, maxViolations=3. 첫 accept 후 토큰 고갈 → 3연속 drop.
    const limiter = makeLimiter(1, 0, 3)

    expect(limiter.check(0)).toBe('accept')
    expect(limiter.shouldTerminate()).toBe(false)

    limiter.check(0) // 위반 1
    expect(limiter.shouldTerminate()).toBe(false)
    limiter.check(0) // 위반 2
    expect(limiter.shouldTerminate()).toBe(false)
    limiter.check(0) // 위반 3 → 임계 도달
    expect(limiter.shouldTerminate()).toBe(true)
  })

  it('중간에 accept가 발생하면 위반 카운터가 리셋된다', () => {
    // capacity=1, refill=1/s, maxViolations=3. 2번 drop 후 리필로 accept → 카운터 리셋.
    const limiter = makeLimiter(1, 1, 3)

    limiter.check(0) // accept (1 → 0)
    limiter.check(0) // 위반 1
    limiter.check(0) // 위반 2
    expect(limiter.shouldTerminate()).toBe(false)

    limiter.check(1000) // +1초 리필 → accept, 카운터 리셋
    expect(limiter.shouldTerminate()).toBe(false)

    // 리셋됐으므로 임계 도달까지 다시 3번의 drop이 필요하다.
    limiter.check(1000) // 위반 1
    limiter.check(1000) // 위반 2
    expect(limiter.shouldTerminate()).toBe(false)
    limiter.check(1000) // 위반 3
    expect(limiter.shouldTerminate()).toBe(true)
  })

  it('첫 drop은 drop-warn, 연속 후속 drop은 drop이다', () => {
    // capacity=1, refill=0. 첫 accept 후 고갈 → 첫 drop만 warn, 이후는 drop.
    const limiter = makeLimiter(1, 0, 100)

    expect(limiter.check(0)).toBe('accept')
    expect(limiter.check(0)).toBe('drop-warn') // 첫 drop → warn-edge 세팅
    expect(limiter.check(0)).toBe('drop') // 연속 drop → 증폭 방지
    expect(limiter.check(0)).toBe('drop')
  })

  it('accept가 warn-edge를 재무장한다 — 다음 drop이 다시 drop-warn이 된다', () => {
    // capacity=1, refill=1/s. drop-warn → 리필 accept → 다음 drop이 다시 drop-warn.
    const limiter = makeLimiter(1, 1, 100)

    expect(limiter.check(0)).toBe('accept')
    expect(limiter.check(0)).toBe('drop-warn') // 첫 drop
    expect(limiter.check(0)).toBe('drop') // 연속 drop

    expect(limiter.check(1000)).toBe('accept') // 리필 → warn-edge 재무장
    expect(limiter.check(1000)).toBe('drop-warn') // 재무장됐으므로 다시 warn
  })
})

describe('createMessageRateLimiterFactory', () => {
  it('[OQ1 공유 + 트랩#1] 같은 accountId 두 연결이 계정 버킷을 공유한다 — A로 고갈 후 B는 drop, B 연결 토큰 미소비', () => {
    // capacity=10(연결 여유), accountCapacity=3(계정이 먼저 고갈), refill=0.
    const factory = makeFactory({ capacity: 10, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0)
    const b = factory.createConnection('acct1', 0)

    // A가 공유 계정 버킷 3개를 모두 소비(연결 버킷은 10 중 3만 소비).
    expect(a.check(0)).toBe('accept')
    expect(a.check(0)).toBe('accept')
    expect(a.check(0)).toBe('accept')
    expect(a.peekAccountTokens()).toBeCloseTo(0) // 계정 버킷 고갈

    // B는 연결 토큰이 남아 있지만 공유 계정 버킷이 비어 drop. 첫 drop은 warn-edge라 drop-warn,
    // 연속 후속 drop이 리터럴 drop이다(criteria 1의 verdict `drop`).
    expect(b.check(0)).toBe('drop-warn')
    expect(b.check(0)).toBe('drop')

    // 트랩#1 원자성: 계정 고갈로 reject된 B는 연결 토큰을 소비하지 않는다(시드된 capacity 그대로).
    expect(b.peekConnectionTokens()).toBeCloseTo(10)
    // 공유 계정 버킷도 여전히 0 — B가 부분 소비하지 않았다.
    expect(b.peekAccountTokens()).toBeCloseTo(0)
  })

  it('[트랩#1 역방향] 연결 버킷 空 + 계정 버킷 有 → drop, 계정 토큰 미감소', () => {
    // capacity=2(연결이 먼저 고갈), accountCapacity=10, refill=0.
    const factory = makeFactory({ capacity: 2, accountCapacity: 10, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0)

    expect(a.check(0)).toBe('accept') // conn 2→1, acct 10→9
    expect(a.check(0)).toBe('accept') // conn 1→0, acct 9→8
    expect(a.peekConnectionTokens()).toBeCloseTo(0)
    expect(a.peekAccountTokens()).toBeCloseTo(8)

    // 연결 버킷 고갈 → drop. 계정 버킷은 토큰이 있어도 건드리지 않는다.
    expect(a.check(0)).toBe('drop-warn')
    expect(a.check(0)).toBe('drop')
    expect(a.peekAccountTokens()).toBeCloseTo(8) // 미감소
  })

  it('[OQ1 refcount] 같은 accountId 2회 생성 → activeAccountCount 1, 마지막 release 후에도 엔트리 생존', () => {
    const factory = makeFactory()
    factory.createConnection('acct1', 0)
    factory.createConnection('acct1', 0)
    expect(factory.activeAccountCount()).toBe(1)

    factory.releaseAccount('acct1')
    expect(factory.activeAccountCount()).toBe(1) // refCount 2→1, 아직 살아 있음
    factory.releaseAccount('acct1')
    // keep-until-refilled — refCount 1→0이어도 엔트리는 zero-refcount로 생존한다(즉시 재연결 시
    // fresh full 버스트 대신 고갈 버킷을 재사용하기 위해). 삭제는 Story 3의 lazy sweep이 담당한다.
    expect(factory.activeAccountCount()).toBe(1)
  })

  it('[OQ1 refcount] 부재·중복 releaseAccount는 no-op이다 (음수·누수 없음)', () => {
    const factory = makeFactory()
    factory.releaseAccount('ghost') // 부재 계정 → 엔트리 생성 없이 no-op
    expect(factory.activeAccountCount()).toBe(0)

    factory.createConnection('acct1', 0)
    factory.releaseAccount('acct1') // refCount 1→0, 엔트리 생존(keep)
    factory.releaseAccount('acct1') // zero-refcount 엔트리 중복 release → refCount<=0 가드로 no-op(음수 방지)
    expect(factory.activeAccountCount()).toBe(1) // 생존한 엔트리 하나

    // 중복 release가 refCount를 음수로 만들지 않았다면 재연결은 refCount 0→1로 정상 복귀한다.
    // (음수였다면 release 한 번으로는 0에 못 미쳐 sibling-refcount 회계가 깨진다 — Story 3 sweep의 전제.)
    factory.createConnection('acct1', 0) // 생존 엔트리 재사용, refCount 0→1
    expect(factory.activeAccountCount()).toBe(1)
    factory.releaseAccount('acct1') // 1→0
    factory.releaseAccount('acct1') // 이미 0 → no-op
    expect(factory.activeAccountCount()).toBe(1)
  })

  it('accept 시 연결·계정 버킷에서 각각 정확히 1개씩 소비한다', () => {
    const factory = makeFactory({ capacity: 5, accountCapacity: 5, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0)

    expect(a.check(0)).toBe('accept')
    expect(a.peekConnectionTokens()).toBeCloseTo(4)
    expect(a.peekAccountTokens()).toBeCloseTo(4)
  })

  it('서로 다른 accountId는 독립 계정 버킷을 가진다', () => {
    const factory = makeFactory({ capacity: 10, accountCapacity: 1, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0)
    const b = factory.createConnection('acct2', 0)

    expect(a.check(0)).toBe('accept') // acct1 계정 버킷 고갈
    expect(a.check(0)).toBe('drop-warn')
    // acct2 계정 버킷은 독립이라 영향 없다.
    expect(b.check(0)).toBe('accept')
    expect(factory.activeAccountCount()).toBe(2)
  })

  it('계정 버킷도 lazy refill한다 — now 전진 시 자체 경과로 리필된다', () => {
    const factory = makeFactory({
      capacity: 100,
      accountCapacity: 1,
      refillPerSec: 0,
      accountRefillPerSec: 1,
    })
    const a = factory.createConnection('acct1', 0)

    expect(a.check(0)).toBe('accept') // acct 1→0
    expect(a.check(0)).toBe('drop-warn') // 계정 고갈
    expect(a.check(1000)).toBe('accept') // +1초 → 계정 버킷 1토큰 리필 → accept
  })

  it('생성 시 상한을 조회하지 않는다 — 던지는 thunk로도 팩토리·연결이 만들어진다', () => {
    const factory = createMessageRateLimiterFactory(() => {
      throw new Error('생성 시 조회되면 안 된다')
    })
    expect(() => factory.createConnection('acct1', 0)).not.toThrow()
  })

  it('shouldTerminate는 연결 단위 위반 임계다 — 공유 계정 고갈이라도 핸들별로 독립 카운트', () => {
    // maxViolations=2. 공유 계정 버킷 고갈로 둘 다 drop되지만 위반 카운터는 핸들별로 분리된다.
    const factory = makeFactory({ capacity: 10, accountCapacity: 1, maxViolations: 2, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0)
    const b = factory.createConnection('acct1', 0)

    expect(a.check(0)).toBe('accept') // 공유 계정 1→0
    a.check(0) // a 위반 1
    expect(a.shouldTerminate()).toBe(false)
    a.check(0) // a 위반 2 → 임계 도달
    expect(a.shouldTerminate()).toBe(true)

    // b는 아직 check한 적 없어 위반 0 — 계정 공유와 무관하게 독립이다.
    expect(b.shouldTerminate()).toBe(false)
  })
})

describe('keep-until-refilled 재사용 (churn 우회 차단, issue #77)', () => {
  it('[reuse] drain→release→즉시 reconnect: 살아남은 고갈 버킷을 재사용한다(fresh full 버스트 없음)', () => {
    // accountCapacity=3, accountRefillPerSec=1. 계정 버킷을 고갈시킨 뒤 반납하고 같은 now에 재연결한다.
    // keep-until-refilled면 엔트리가 생존하고, 재연결이 리필-후-재사용하지만 경과 0이라 여전히 고갈이어야 한다.
    const factory = makeFactory({ capacity: 100, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 1 })
    const a = factory.createConnection('acct1', 0)
    expect(a.check(0)).toBe('accept') // acct 3→2
    expect(a.check(0)).toBe('accept') // 2→1
    expect(a.check(0)).toBe('accept') // 1→0
    expect(a.peekAccountTokens()).toBeCloseTo(0)

    factory.releaseAccount('acct1') // refCount 1→0, 엔트리 생존
    expect(factory.activeAccountCount()).toBe(1)

    // 즉시(now=0) 재연결 — 고갈 버킷을 리필-후-재사용. 경과 0이라 회복 없음 → 여전히 고갈.
    const b = factory.createConnection('acct1', 0)
    expect(b.peekAccountTokens()).toBeCloseTo(0) // fresh full(=3)이 아니라 고갈 유지
    expect(b.check(0)).toBe('drop-warn') // 계정 버킷 비어 즉시 drop — 버스트 우회 차단
  })

  it('[reuse] drain→release→refill-horizon 경과 후 reconnect: 계정 버킷이 full로 회복된다', () => {
    // accountCapacity=3, accountRefillPerSec=1. 고갈·반납 후 3초 경과 재연결 → 3토큰 회복 = full.
    const factory = makeFactory({ capacity: 100, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 1 })
    const a = factory.createConnection('acct1', 0)
    a.check(0)
    a.check(0)
    a.check(0)
    expect(a.peekAccountTokens()).toBeCloseTo(0)

    factory.releaseAccount('acct1') // 엔트리 생존
    expect(factory.activeAccountCount()).toBe(1)

    // 3초 경과 후 재연결 — 리필-후-재사용이 accountRefillPerSec=1로 3토큰 회복 → capacity 3에서 clamp.
    const b = factory.createConnection('acct1', 3000)
    expect(b.peekAccountTokens()).toBeCloseTo(3) // full 회복 (check 없이 재연결 시점에 관측)
  })

  it('[reuse] 형제 연결(refCount>0) 생존 중 reconnect+release는 계정 엔트리를 조기 삭제·리셋하지 않는다', () => {
    // 형제 refCount 안전성: a가 살아 있는 동안 b 반납·c 재연결·c 반납이 반복돼도 공유 버킷은 그대로다.
    const factory = makeFactory({ capacity: 100, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 0 })
    const a = factory.createConnection('acct1', 0) // refCount 1
    const b = factory.createConnection('acct1', 0) // refCount 2 (공유 버킷)

    // 공유 계정 버킷 3개를 모두 소비.
    expect(a.check(0)).toBe('accept')
    expect(a.check(0)).toBe('accept')
    expect(a.check(0)).toBe('accept')
    expect(a.peekAccountTokens()).toBeCloseTo(0)

    factory.releaseAccount('acct1') // refCount 2→1, a 살아 있어 생존
    expect(factory.activeAccountCount()).toBe(1)

    // a 생존 중 재연결 — refCount 1→2. accountRefillPerSec=0이라 재사용 버킷은 고갈 유지.
    const c = factory.createConnection('acct1', 5000)
    expect(c.peekAccountTokens()).toBeCloseTo(0) // 공유 고갈 버킷 재사용(형제와 동일 상태)
    expect(a.peekAccountTokens()).toBeCloseTo(0) // 형제 a도 같은 버킷 — 리셋되지 않음

    factory.releaseAccount('acct1') // refCount 2→1, 여전히 a 살아 있어 생존
    expect(factory.activeAccountCount()).toBe(1)
  })
})

describe('lazy sweep + 하드 캡 (bounded 레지스트리, Story 3)', () => {
  it('[T3.1] lazy sweep — now로 리필해 완전 회복(tokens>=accountCapacity)된 zero-refcount 엔트리만 삭제한다', () => {
    // accountCapacity=4, accountRefillPerSec=1. A는 t=0 고갈(0/4), B는 t=0 절반 소비(2/4) 후 반납.
    const factory = makeFactory({ capacity: 100, accountCapacity: 4, refillPerSec: 0, accountRefillPerSec: 1 })
    const a = factory.createConnection('A', 0)
    a.check(0)
    a.check(0)
    a.check(0)
    a.check(0) // A 4→0
    factory.releaseAccount('A')
    const b = factory.createConnection('B', 0)
    b.check(0)
    b.check(0) // B 4→2
    factory.releaseAccount('B')
    expect(factory.activeAccountCount()).toBe(2) // 둘 다 미회복 → 생존

    // t=2000: A는 +2 → 2/4(미회복 survive), B는 +2 → 4/4 완전 회복(삭제). C 생성으로 sweep 트리거.
    factory.createConnection('C', 2000)
    // 삭제: B. 생존: A(2/4). 추가: C(live). → size 2
    expect(factory.activeAccountCount()).toBe(2)

    // B는 삭제됐다 → 재연결은 fresh(미시드 peek 0). A는 생존 → 재연결은 reused(2 유지).
    const rb = factory.createConnection('B', 2000)
    expect(rb.peekAccountTokens()).toBeCloseTo(0) // fresh (reused였다면 완전 회복된 4였을 것)
    const ra = factory.createConnection('A', 2000)
    expect(ra.peekAccountTokens()).toBeCloseTo(2) // reused — 삭제되지 않은 잔량 2
  })

  it('[T3.4] 작은 accountMaxEntries 주입: 캡 초과 시 activeAccountCount가 캡 이내로 유지된다', () => {
    // 캡(3)보다 많은 계정을 만들고 각각 부분 소비·반납해 zero-refcount 축출 후보로 만든다(rate0이라
    // sweep에서 완전 회복되지 않아 후보로 생존한다).
    const factory = makeFactory({ capacity: 100, accountCapacity: 5, refillPerSec: 0, accountRefillPerSec: 0, accountMaxEntries: 3 })
    for (let i = 0; i < 6; i++) {
      const id = `acct${i}`
      const h = factory.createConnection(id, 0)
      h.check(0) // 계정 버킷 5→4
      factory.releaseAccount(id)
    }
    // 매 createConnection의 sweep/캡이 zero-refcount 후보를 정리해 size를 캡 이내로 묶는다.
    expect(factory.activeAccountCount()).toBeLessThanOrEqual(3)
  })

  it('[T3.5] 캡 축출은 zero-refcount 엔트리를 가장 가득 찬 것부터(most-refilled-first) 제거한다', () => {
    // 가변 캡 thunk — 축출 강제 후 캡을 풀어 검증 재연결이 추가 축출을 일으키지 않게 한다.
    let maxEntries = 3
    const factory = createMessageRateLimiterFactory(() => ({
      capacity: 100,
      refillPerSec: 0,
      maxViolations: 100,
      accountCapacity: 5,
      accountRefillPerSec: 0,
      accountMaxEntries: maxEntries,
    }))

    // 잔량 서열과 삽입 순서를 어긋나게 둔다 — most-refilled-first가 삽입순(FIFO) 축출과 구별되게 하기
    // 위함이다. A는 2/5(three checks, 첫 삽입), B는 4/5(one check, 둘째 삽입 · 가장 가득 참), C는
    // 0/5(five checks, 셋째 삽입). FIFO면 A가, most-refilled-first면 B가 먼저 축출된다. 모두 반납.
    const a = factory.createConnection('A', 0)
    a.check(0)
    a.check(0)
    a.check(0) // 5→2
    factory.releaseAccount('A')
    const b = factory.createConnection('B', 0)
    b.check(0) // 5→4 (가장 가득 참)
    factory.releaseAccount('B')
    const c = factory.createConnection('C', 0)
    c.check(0)
    c.check(0)
    c.check(0)
    c.check(0)
    c.check(0) // 5→0
    factory.releaseAccount('C')
    expect(factory.activeAccountCount()).toBe(3)

    // 새 계정 D 생성 → 캡(3) 초과 → 가장 가득 찬 B(4)가 먼저 축출된다(FIFO였다면 A).
    factory.createConnection('D', 0)

    maxEntries = 100 // 캡 완화 — 아래 검증 재연결이 추가 축출을 일으키지 않게 한다.
    const ra = factory.createConnection('A', 0)
    expect(ra.peekAccountTokens()).toBeCloseTo(2) // A는 생존 → reused 잔량 2 (FIFO였다면 축출돼 0)
    const rb = factory.createConnection('B', 0)
    expect(rb.peekAccountTokens()).toBeCloseTo(0) // B는 축출됨(가장 가득 참) → fresh 미시드
  })

  it('[T3.6] live(refCount>0) 엔트리는 캡 압력에도 절대 축출되지 않는다', () => {
    // 캡(2)보다 많은 live 연결을 만들되 반납하지 않는다 — 셋 다 생존해야 한다(live 축출 불가).
    const factory = makeFactory({ capacity: 100, accountCapacity: 5, refillPerSec: 0, accountRefillPerSec: 0, accountMaxEntries: 2 })
    const l1 = factory.createConnection('L1', 0)
    l1.check(0)
    const l2 = factory.createConnection('L2', 0)
    l2.check(0)
    const l3 = factory.createConnection('L3', 0)
    l3.check(0) // 3 live > 캡 2

    expect(factory.liveAccountCount()).toBe(3) // 셋 다 live로 생존
    expect(factory.activeAccountCount()).toBe(3) // 캡을 넘겨도 live는 축출 불가
  })

  it('[T3.7] Map-size-bound: 완전 회복된 zero-refcount 엔트리는 sweep로 제거돼 size가 (live + 미회복 zero-refcount)로 유지된다', () => {
    const factory = makeFactory({ capacity: 100, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 1, accountMaxEntries: 4096 })
    const a = factory.createConnection('A', 0)
    a.check(0)
    a.check(0)
    a.check(0) // A 고갈 0/3
    factory.releaseAccount('A')
    const b = factory.createConnection('B', 0)
    b.check(0)
    b.check(0)
    b.check(0) // B 고갈 0/3
    factory.releaseAccount('B')
    expect(factory.activeAccountCount()).toBe(2) // 아직 미회복 → 생존

    // refill-horizon(3초) 경과 후 C 생성 → sweep가 A,B를 완전 회복(3=capacity) 판정해 삭제.
    factory.createConnection('C', 3000)
    expect(factory.activeAccountCount()).toBe(1) // C(live)만 남는다
    expect(factory.liveAccountCount()).toBe(1)
  })

  it('[T3.8 churn] 캡 압력 하 재연결: 대상은 축출 후 fresh가 아니라 고갈 버킷을 재사용한다', () => {
    // 재연결 대상 T는 sweep·캡 축출 후보에서 제외돼 in-place 재사용된다(depleted→fresh 우회 차단).
    const factory = makeFactory({ capacity: 100, accountCapacity: 3, refillPerSec: 0, accountRefillPerSec: 0, accountMaxEntries: 2 })
    const t = factory.createConnection('T', 0)
    t.check(0)
    t.check(0) // T 계정 3→1 (고갈에 가까운 잔량 1)
    factory.releaseAccount('T')
    const y = factory.createConnection('Y', 0)
    y.check(0)
    y.check(0)
    y.check(0) // Y 계정 3→0
    factory.releaseAccount('Y')
    expect(factory.activeAccountCount()).toBe(2)

    // 캡(2) 압력 하 T 재연결 — Y는 축출 후보지만 T(대상)는 절대 축출·리셋되지 않는다.
    const t2 = factory.createConnection('T', 0)
    expect(t2.peekAccountTokens()).toBeCloseTo(1) // 재사용된 잔량 1 (fresh였다면 0)
  })

  it('[T3.3 inspector] liveAccountCount는 refCount>0 엔트리 수를 정확히 반환한다', () => {
    const factory = makeFactory({ capacity: 100, accountCapacity: 5, refillPerSec: 0, accountRefillPerSec: 0 })
    expect(factory.liveAccountCount()).toBe(0)

    factory.createConnection('A', 0) // refCount 1
    factory.createConnection('B', 0) // refCount 1
    expect(factory.liveAccountCount()).toBe(2)
    expect(factory.activeAccountCount()).toBe(2)

    factory.releaseAccount('A') // A refCount 0 (zero-refcount 생존)
    expect(factory.liveAccountCount()).toBe(1) // B만 live
    expect(factory.activeAccountCount()).toBe(2) // A는 아직 레지스트리에 생존
  })
})
