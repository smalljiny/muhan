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
 * 계정 차원(account dimension)은 `createMessageRateLimiterFactory`가 계정 버킷을 연결 간 공유하는
 * 레지스트리로 얹고, 연결 핸들의 `check`가 연결·계정 두 버킷을 원자적으로 AND해 확장한다. 계정 버킷은
 * refcount로 소유하되 refCount가 0에 도달해도 삭제하지 않고 keep-until-refilled로 생존시킨다 — disconnect/
 * reconnect churn이 계정 상한을 우회하지 못하게, 즉시 재연결이 fresh full 버킷 버스트 대신 살아남은 고갈
 * 버킷을 리필-후-재사용하게 한다(issue #77). zero-refcount 엔트리의 실제 삭제(lazy sweep·하드 캡)는 Story 3가
 * `accounts.size > 0` 게이트 뒤에 얹는다.
 */

/**
 * 유량 제한 상한. 연결 차원(capacity·refillPerSec·maxViolations)과 계정 차원(accountCapacity·
 * accountRefillPerSec)을 하나의 combined 형태로 담는다. factory는 이 단일 thunk를 받아 연결 버킷과
 * 공유 계정 버킷을 각자의 상한으로 회계한다. maxViolations는 연결 단위 종료 임계이며 계정 버킷에는
 * 위반 카운터가 없다. accountMaxEntries는 계정 버킷 레지스트리 엔트리 수의 하드 캡으로, 캡 초과 시
 * most-refilled-first 축출의 backstop으로 런타임 회계에 참여한다.
 */
export interface MessageRateLimits {
  readonly capacity: number
  readonly refillPerSec: number
  readonly maxViolations: number
  readonly accountCapacity: number
  readonly accountRefillPerSec: number
  readonly accountMaxEntries: number
}

/**
 * 순수 토큰 버킷 — 잔여 토큰과 마지막 리필 시각만 소유한다. 연결 버킷과 공유 계정 버킷이 같은 회계를
 * 쓰므로 이 헬퍼로 통일한다. `refill`은 지연 리필(첫 호출은 `lastRefill === null` 센티넬로 capacity
 * 시드), `hasToken`/`consume`은 AND 게이트가 "둘 다 검사 → 둘 다 소비"를 부분 소비 없이 마치도록
 * 검사와 소비를 분리한다. now는 단조 비감소로 가정한다.
 */
interface TokenBucket {
  refill(now: number, capacity: number, refillPerSec: number): void
  hasToken(): boolean
  consume(): void
  peek(): number
}

function createTokenBucket(): TokenBucket {
  let tokens = 0
  let lastRefill: number | null = null

  function refill(now: number, capacity: number, refillPerSec: number): void {
    if (lastRefill === null) {
      // 최초 시드 — 버킷을 가득 채운다. 이번 리필 경과는 0이다.
      tokens = capacity
    } else {
      // 지연 리필 — 자체 lastRefill 이후 경과에 비례해 회복하되 capacity에서 clamp한다.
      const elapsedSec = (now - lastRefill) / 1000
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec)
    }
    lastRefill = now
  }

  return {
    refill,
    hasToken: () => tokens >= 1,
    consume: () => {
      tokens -= 1
    },
    peek: () => tokens,
  }
}

/**
 * check 판정 결과. `accept`=토큰 소비 성공, `drop`=고갈로 폐기, `drop-warn`=고갈 폐기이면서 경고 엣지
 * (연속 폐기 구간의 첫 폐기)라 상위가 사용자에게 1회 경고를 보내야 함을 뜻한다.
 */
export type RateVerdict = 'accept' | 'drop' | 'drop-warn'

/**
 * 연결 유량 제한 핸들(계정 차원 포함). factory가 `createConnection`으로 연결마다 하나씩 발급한다.
 * `check`는 연결 버킷과 공유 계정 버킷을 원자적으로 AND한 순수 판정이며, 위반 카운터·warn-edge·
 * shouldTerminate는 연결 단위로 이 핸들이 소유한다(계정 버킷은 위반 카운터가 없다). 인스펙터 두 개로
 * 연결·계정 버킷의 미소비 관측을 각각 검증한다.
 */
export interface ConnectionRateLimiter {
  check(now: number): RateVerdict
  shouldTerminate(): boolean
  peekConnectionTokens(): number
  peekAccountTokens(): number
}

/**
 * 유량 제한기 factory. 계정 버킷 레지스트리를 직접 소유하고 연결 핸들을 발급·정리한다.
 * plugin(배선 Story)이 소켓 open 시 `createConnection(accountId)`로 핸들을 얻고, 프레임마다
 * `handle.check(now)`/`handle.shouldTerminate()`를 호출하며, close 시 `releaseAccount(accountId)`로
 * 계정 참조를 반납한다.
 */
export interface MessageRateLimiterFactory {
  /**
   * 연결 핸들을 발급한다. `now`는 계정 버킷 리필용 단조 clock으로, `check`가 쓰는 것과 동일한
   * `performance.now()`를 넘긴다. 대상 계정 엔트리가 생존해 있으면 refCount를 올리고 기존 공유 버킷을
   * `now`로 리필-후-재사용한다(즉시 재연결은 경과 0이라 고갈 유지, refill-horizon 경과 후면 회복). 부재
   * 계정이면 fresh 버킷을 refCount=1로 등록한다 — 이 경로에서는 상한을 조회하지 않는다(thunk 관례).
   * 연결 전용 버킷은 항상 fresh다.
   */
  createConnection(accountId: string, now: number): ConnectionRateLimiter
  releaseAccount(accountId: string): void
  /**
   * 테스트 전용 인스펙터 — 현재 레지스트리에 있는 계정 버킷 엔트리 수를 반환한다(살아 있는 연결 +
   * zero-refcount 생존 엔트리 총합). keep-until-refilled에서 refCount 0 엔트리도 삭제되지 않고 남으므로
   * `accounts.size`가 그대로 이 총합이다. 재사용·생존을 직접 관측하는 용도이며 프로덕션 회계에는
   * 참여하지 않는다(connectionQuota.activeAccountCount 미러).
   */
  activeAccountCount(): number
  /**
   * 테스트 전용 인스펙터 — refCount>0(살아 있는 연결이 참조 중)인 계정 엔트리 수를 반환한다.
   * `activeAccountCount()`(= live + zero-refcount 총합)와 함께 쓰면 sweep·캡 축출이 zero-refcount
   * 엔트리만 제거하고 live 엔트리는 절대 축출하지 않음을 직접 관측한다. Story 2가 삭제를 관측 불가로
   * 만든 뒤 Story 3 sweep가 삭제를 재도입했으므로, 이 인스펙터로 캡 압력 하 live 보존을 재검증한다.
   * 프로덕션 회계에는 참여하지 않는다.
   */
  liveAccountCount(): number
}

/** 계정 버킷 레지스트리 엔트리 — 공유 버킷과 이 계정을 참조하는 살아 있는 연결 수. */
interface AccountEntry {
  readonly bucket: TokenBucket
  refCount: number
}

/**
 * 유량 제한기 factory를 만든다. 계정별 공유 버킷 Map을 클로저에 캡슐화한다(connectionQuota 미러 —
 * connectionQuota 카운터에 얹지 않는 별도 레지스트리다).
 *
 * `createConnection`은 계정 엔트리가 생존해 있으면 refCount를 올리고 기존 공유 버킷을 `now`로 리필-후-
 * 재사용한다(churn 재연결이 fresh full 버스트를 얻지 못하게). 부재 계정이면 버킷을 새로 만들어 refCount=1로
 * 등록한다. `releaseAccount`는 refCount를 내리되 0에 도달해도 엔트리를 삭제하지 않고 생존시킨다(keep-until-
 * refilled). 부재 계정 release나 zero-refcount 엔트리 이중 반납은 `refCount <= 0` 가드로 완전 no-op이다
 * (음수·누수 없음).
 *
 * 상한 조회(thunk)는 두 갈래다 — 부재 계정 생성은 상한을 조회하지 않아(각 버킷은 첫 `check`에서 자체
 * `lastRefill === null` 센티넬로 lazy 시드) fresh 팩토리에서 던지는 thunk로도 연결이 만들어진다. 생존
 * 엔트리 재사용만 리필을 위해 상한을 조회한다(그때는 이미 버킷이 존재하므로 조회가 안전하다).
 */
export function createMessageRateLimiterFactory(
  getLimits: () => MessageRateLimits,
): MessageRateLimiterFactory {
  const accounts = new Map<string, AccountEntry>()

  function createConnection(accountId: string, now: number): ConnectionRateLimiter {
    // Story 3 — zero-refcount 엔트리의 lazy sweep + 하드 캡 backstop으로 레지스트리를 스케줄러/타이머
    // 없이 bounded로 유지한다. 전체 블록을 accounts.size > 0 게이트 뒤에 둔다: 빈 맵(fresh factory의 첫
    // 연결)은 진입하지 않아 getLimits()를 조회하지 않는다. 이 무조회 보장은 "빈 맵의 첫 연결"에만
    // 한정된다 — 맵이 비어있지 않으면 부재 계정 생성도 sweep 게이트를 통과해 getLimits()를 조회한다
    // (lazy sweep가 상한 없이는 돌 수 없으므로 불가피하다). throwing-thunk 관례가 지키는 것은 fresh
    // factory의 첫 연결이 던지지 않는다는 것뿐이며, 이는 게이트로 충족된다. 런타임에는 env가 시작 시
    // Zod fail-fast로 파싱돼 getLimits()가 던지지 않으므로(테스트 전용 방어 계약), 조회 자체는 무해하다.
    //
    // 재연결 대상 accountId와 live(refCount>0) 엔트리는 sweep·축출 후보에서 모두 제외한다. 이 순서를
    // 의도적으로 택했다(sweep-first + 대상 제외): (1) 대상을 sweep보다 먼저 리필·재사용하는 대안은 대상을
    // 만지는 순간 size>0이 돼 fresh factory의 첫 연결에서 getLimits()가 던져 게이트를 깨므로 불가하다.
    // (2) 대상이 refill-horizon을 넘겨 완전 회복 상태면 sweep가 이를 삭제해 아래 reuse 경로가 fresh로
    // 빠지는데, 그러면 depleted→fresh churn 우회가 열리고 reuse 관측(peek)이 깨진다. 따라서 대상은 sweep·
    // 축출에서 제외하고 아래 reuse-refill 경로가 in-place로 리필·재사용한다. live 엔트리는 참조 중이라
    // 절대 삭제 불가다.
    if (accounts.size > 0) {
      const limits = getLimits()
      // 축출 불가 조건(load-bearing 불변식) — 재연결 대상 accountId와 live(refCount>0) 엔트리는 sweep·캡
      // 축출 어느 후보에서도 제외한다. 두 루프가 같은 조건을 쓰므로 한 곳에 정의해 사본 drift를 막는다.
      const isProtected = (id: string, candidateEntry: AccountEntry): boolean =>
        id === accountId || candidateEntry.refCount > 0
      // T3.1 lazy sweep — zero-refcount(대상·live 제외) 엔트리를 now로 리필하고, 완전 회복
      // (tokens >= accountCapacity)이면 삭제한다(완전 회복 = 부재와 동치이므로 재연결해도 fresh full과
      // 무차별). 매 createConnection마다 레지스트리를 한 번 순회하는 O(n) 비용이다(정렬은 아래 캡 초과
      // 드문 경로에서만). Map 순회 중 삭제는 아직 방문 안 한 키만 건너뛰므로 안전하다.
      for (const [id, candidateEntry] of accounts) {
        if (isProtected(id, candidateEntry)) {
          continue
        }
        candidateEntry.bucket.refill(now, limits.accountCapacity, limits.accountRefillPerSec)
        if (candidateEntry.bucket.peek() >= limits.accountCapacity) {
          accounts.delete(id)
        }
      }
      // T3.2 하드 캡 backstop — sweep 후에도 size가 캡 이상이면 zero-refcount(대상·live 제외) 엔트리를
      // 가장 가득 찬 것부터(most-refilled-first) 축출해 캡 아래로 되돌린다. depleted 엔트리는 가장 덜 찬
      // 축이라 마지막에 축출되므로, 대상 제외와 무관하게도 고갈 재연결 버킷이 자연 보호된다. 정렬은 캡
      // 초과라는 드문 경로에서만 실행된다.
      //
      // 축출 임계는 이 호출이 엔트리를 추가하는지(willAdd)에 따라 갈린다. 신규(부재) 계정은 아래에서
      // 엔트리 1개가 추가되므로 캡 미만(size < cap)까지 축출해 최종 size <= cap을 보장한다. 반면 기존
      // 계정 재연결은 reuse 경로라 엔트리를 추가하지 않으므로 size <= cap이면 이미 규정 준수다 — 이때
      // size == cap에서 축출하면 무관한 고갈 계정을 불필요하게 제거해 그 계정의 churn 우회(fresh full
      // 재시드)를 재개방한다. 따라서 재연결은 size > cap일 때만 축출한다. 대상은 sweep에서 protected라
      // willAdd는 sweep 전후로 불변이다.
      const willAdd = !accounts.has(accountId)
      const evictBelow = willAdd ? limits.accountMaxEntries : limits.accountMaxEntries + 1
      if (accounts.size >= evictBelow) {
        const candidates: Array<{ id: string; tokens: number }> = []
        for (const [id, candidateEntry] of accounts) {
          if (isProtected(id, candidateEntry)) {
            continue
          }
          // 위 sweep에서 이미 now로 리필됐으므로 peek가 최신 회복 수준이다.
          candidates.push({ id, tokens: candidateEntry.bucket.peek() })
        }
        candidates.sort((left, right) => right.tokens - left.tokens)
        for (const candidate of candidates) {
          if (accounts.size < evictBelow) {
            break
          }
          accounts.delete(candidate.id)
        }
      }
    }

    let entry = accounts.get(accountId)
    if (entry !== undefined) {
      // 생존 계정(refCount>0 또는 zero-refcount 생존) — 기존 공유 버킷을 now로 리필-후-재사용한다.
      // 즉시 재연결은 경과 0이라 고갈 유지, refill-horizon 경과 후면 회복. 상한 조회는 이 경로에서만
      // 발생한다(부재 계정은 조회 없이 fresh 시드). refCount 증가는 refill 성공 뒤로 두어, 상한 조회가
      // 예외를 던져도 증가가 누수(감소 없이 잔존)하지 않게 한다.
      const limits = getLimits()
      entry.bucket.refill(now, limits.accountCapacity, limits.accountRefillPerSec)
      entry.refCount += 1
    } else {
      // 새(부재) 계정 — 공유 버킷을 만들어 첫 연결로 등록한다. 상한은 조회하지 않는다(thunk 관례).
      entry = { bucket: createTokenBucket(), refCount: 1 }
      accounts.set(accountId, entry)
    }
    // 이 연결이 공유하는 계정 버킷. keep-until-refilled라 releaseAccount 후에도 엔트리·버킷이 생존하고,
    // 재연결은 같은 버킷을 리필-후-재사용하므로 이 참조는 계정 버킷의 단일 정본으로 유지된다.
    const accountBucket = entry.bucket
    // 연결 전용 버킷·위반 카운터. 계정 차원과 달리 연결 단위로 이 핸들이 소유한다.
    const connectionBucket = createTokenBucket()
    let violations = 0

    function check(now: number): RateVerdict {
      // 매 호출 상한을 지연 조회한다(thunk 관례). 각 버킷을 자체 경과로 먼저 리필한다.
      const limits = getLimits()
      connectionBucket.refill(now, limits.capacity, limits.refillPerSec)
      accountBucket.refill(now, limits.accountCapacity, limits.accountRefillPerSec)

      // 원자적 AND — 둘 다 토큰이 있을 때만 각각 1개씩 소비한다(connectionQuota check-then-increment
      // 원자성 미러). 한쪽이라도 부족하면 어느 쪽도 소비하지 않아 부분 소비를 막는다.
      if (connectionBucket.hasToken() && accountBucket.hasToken()) {
        connectionBucket.consume()
        accountBucket.consume()
        violations = 0
        return 'accept'
      }

      // 고갈 — 두 버킷 모두 미소비. 위반은 연결 단위로만 누적한다(계정 버킷은 위반 카운터 없음).
      violations += 1
      return violations === 1 ? 'drop-warn' : 'drop'
    }

    function shouldTerminate(): boolean {
      return violations >= getLimits().maxViolations
    }

    return {
      check,
      shouldTerminate,
      peekConnectionTokens: () => connectionBucket.peek(),
      peekAccountTokens: () => accountBucket.peek(),
    }
  }

  function releaseAccount(accountId: string): void {
    // 생존하고 refCount가 아직 양수인 엔트리에서만 감소한다. 부재 계정·이미 0인 zero-refcount 엔트리
    // 이중 반납은 이 단일 가드로 완전 no-op이다(refCount를 음수로 만들지 않아 sibling-refcount 회계를
    // 지킨다 — Story 3 sweep의 전제).
    const entry = accounts.get(accountId)
    if (entry === undefined || entry.refCount <= 0) {
      return
    }
    entry.refCount -= 1
    // refCount 0에 도달해도 엔트리를 삭제하지 않는다(keep-until-refilled) — 즉시 재연결이 살아남은
    // 고갈 버킷을 재사용하게 해 churn 우회를 막는다. 실제 삭제는 Story 3의 lazy sweep이 담당한다.
  }

  function activeAccountCount(): number {
    return accounts.size
  }

  function liveAccountCount(): number {
    // refCount>0(살아 있는 연결이 참조 중) 엔트리만 센다. sweep·캡 축출이 zero-refcount만 제거하고
    // live는 절대 축출하지 않음을 activeAccountCount()와 대조해 관측하는 용도다.
    let count = 0
    for (const entry of accounts.values()) {
      if (entry.refCount > 0) {
        count += 1
      }
    }
    return count
  }

  return { createConnection, releaseAccount, activeAccountCount, liveAccountCount }
}
