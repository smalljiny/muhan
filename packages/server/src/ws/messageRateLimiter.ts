/**
 * 연결별 메시지 유량 제한 코어 — 토큰 버킷 회계를 주입 clock으로 순수 계산한다.
 *
 * 연결 하나마다 용량(capacity)과 초당 리필(refillPerSec)을 가진 버킷을 두고, 프레임이 도착할 때마다
 * `check(now)`로 토큰 1개를 소비 시도한다. clock을 인자로 받아 부수효과 없이(setTimeout·전송·close 없음)
 * verdict만 반환하는 순수 코어다 — 실제 전송·경고·종료 같은 부수효과는 상위 플러그인이 이 verdict를 읽고
 * 수행한다. 위반 카운터와 경고 엣지(warn-edge)를 코어가 소유해, 플러그인이 엣지를 재계산하지 않고 verdict만
 * 소비하게 한다. 상한은 thunk로 지연 조회해(createConnectionQuota 관례 미러) 미설정 env가 팩토리 생성을
 * 막지 않게 하고, 첫 check 시점의 최신값을 시드로 반영한다.
 *
 * 계정 차원(account dimension)은 이 코어 범위 밖이며 후속 AND 게이트로 추가된다 — 지금은 단일 연결 버킷만
 * 다루되 확장 여지를 남긴다.
 */

/**
 * 유량 제한 상한(연결 차원). 버킷 용량·초당 리필 속도·종료 임계 위반 횟수를 정한다.
 * 계정 차원은 후속 Story가 AND 게이트로 얹으므로 이 형태는 그 확장에 열려 있다.
 */
export interface MessageRateLimits {
  readonly capacity: number
  readonly refillPerSec: number
  readonly maxViolations: number
}

/**
 * check 판정 결과. `accept`=토큰 소비 성공, `drop`=고갈로 폐기, `drop-warn`=고갈 폐기이면서 경고 엣지
 * (연속 폐기 구간의 첫 폐기)라 상위가 사용자에게 1회 경고를 보내야 함을 뜻한다.
 */
export type RateVerdict = 'accept' | 'drop' | 'drop-warn'

/** 유량 제한 핸들. `check`는 순수 판정, `shouldTerminate`는 부수효과 없는 읽기다. */
export interface MessageRateLimiter {
  check(now: number): RateVerdict
  shouldTerminate(): boolean
  /**
   * 테스트 전용 인스펙터 — 현재 버킷의 잔여 토큰 수를 반환한다. 시드·소비·리필·clamp 동작은
   * verdict만으로는 구간 경계에서 관측이 어려우므로 이 인스펙터로 직접 본다. 프로덕션 회계에는
   * 참여하지 않는다.
   */
  peekConnectionTokens(): number
}

/**
 * 유량 제한기를 만든다. 상태(잔여 토큰·마지막 리필 시각·위반 카운터·경고 엣지)는 클로저에 캡슐화한다.
 *
 * 생성 시점에는 상한을 조회하지 않는다(thunk 관례) — `lastRefill === null`을 "아직 시드되지 않음" 센티넬로
 * 두고, 첫 `check`에서 비로소 `getLimits()`를 읽어 버킷을 capacity로 시드한다. 이후 매 check는 먼저
 * `elapsed/1000 * refillPerSec`만큼 리필(capacity에서 clamp)한 뒤 토큰 1개 소비를 시도한다. now는 단조
 * 비감소로 가정한다.
 */
export function createMessageRateLimiter(getLimits: () => MessageRateLimits): MessageRateLimiter {
  let tokens = 0
  let lastRefill: number | null = null
  // 위반 카운터가 경고 엣지도 겸한다 — accept가 0으로 리셋하므로 연속 폐기 구간의 첫 폐기는 항상 1이다.
  let violations = 0

  function check(now: number): RateVerdict {
    // 매 호출 상한을 지연 조회한다(thunk 관례). 첫 check가 이 값을 시드로 반영한다.
    const limits = getLimits()

    if (lastRefill === null) {
      // 최초 시드 — 버킷을 가득 채운다. 이번 리필 경과는 0이다.
      tokens = limits.capacity
    } else {
      // 지연 리필 — 경과 시간에 비례해 토큰을 회복하되 capacity에서 clamp한다.
      const elapsedSec = (now - lastRefill) / 1000
      tokens = Math.min(limits.capacity, tokens + elapsedSec * limits.refillPerSec)
    }
    lastRefill = now

    if (tokens >= 1) {
      // 소비 성공 — 위반 카운터를 리셋해 경고 엣지도 함께 재무장한다.
      tokens -= 1
      violations = 0
      return 'accept'
    }

    // 고갈 — 토큰은 소비하지 않고 위반만 누적한다. 구간 첫 폐기(violations===1)만 경고로 승격해
    // 증폭을 막고, 후속 폐기는 억제한다.
    violations += 1
    return violations === 1 ? 'drop-warn' : 'drop'
  }

  function shouldTerminate(): boolean {
    // 순수 읽기 — 위반 카운터가 임계에 도달했는지만 본다.
    return violations >= getLimits().maxViolations
  }

  function peekConnectionTokens(): number {
    return tokens
  }

  return { check, shouldTerminate, peekConnectionTokens }
}
