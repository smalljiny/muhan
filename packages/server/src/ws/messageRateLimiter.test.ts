import { describe, it, expect } from 'vitest'

import { createMessageRateLimiter } from './messageRateLimiter.js'
import type { MessageRateLimits } from './messageRateLimiter.js'

/** 고정 상한으로 limiter를 만든다. thunk 관례를 미러하되 테스트는 결정적 상수를 넘긴다. */
function makeLimiter(capacity: number, refillPerSec: number, maxViolations: number) {
  const limits: MessageRateLimits = { capacity, refillPerSec, maxViolations }
  return createMessageRateLimiter(() => limits)
}

describe('createMessageRateLimiter', () => {
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

  it('생성 시 상한을 조회하지 않는다 — 던지는 thunk로도 인스턴스화된다', () => {
    // getLimits는 생성 시점이 아니라 첫 check에서만 호출돼야 한다.
    expect(() =>
      createMessageRateLimiter(() => {
        throw new Error('생성 시 조회되면 안 된다')
      }),
    ).not.toThrow()
  })

  it('limits thunk를 첫 check에서 지연 조회한다 — 생성 후 변경을 반영한다', () => {
    let capacity = 1
    const limiter = createMessageRateLimiter(() => ({ capacity, refillPerSec: 0, maxViolations: 5 }))

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
