/**
 * 동시 접속 정원(quota) 팩토리 — 전역 상한과 계정별 상한을 하나의 동기 회계로 관할한다.
 *
 * upgrade 게이트가 소켓을 승인하기 전 `reserve`로 슬롯 1개를 요청하고, 연결 종료 시 `release`로 반납한다.
 * 핵심은 check-then-increment가 같은 동기 스택 안에서 끝나는 것이다 — 검사와 증가 사이에 await/매크로태스크가
 * 끼면 동시에 대기 중인 여러 upgrade가 stale한 size를 읽어 상한을 넘겨 초과 점유(overshoot)한다. 그래서 외부
 * `connections.size`를 읽지 않고 카운터를 내부에서 소유한다. 상한은 thunk로 지연 조회해(graceMs/idleMs 관례
 * 미러) 미설정 env가 팩토리 생성을 막지 않게 하고, reserve 시점의 최신값을 반영한다.
 */

/** 정원 상한. 전역 동시 접속과 계정당 동시 접속을 각각 제한한다. */
export interface ConnectionQuotaLimits {
  readonly maxGlobal: number
  readonly maxPerAccount: number
}

/**
 * reserve 결과. 성공(`ok: true`) 또는 거부(`ok: false` + HTTP 상태 코드).
 * 503=전역 정원 초과(서버 전체 포화), 429=계정별 정원 초과(해당 계정 과다 접속).
 */
export type ReserveResult = { ok: true } | { ok: false; code: 503 | 429 }

/** 정원 핸들. `reserve`는 동기 점유 시도, `release`는 idempotent 반납이다. */
export interface ConnectionQuota {
  reserve(accountId: string): ReserveResult
  release(accountId: string): void
  /**
   * 테스트 전용 인스펙터 — 현재 살아 있는 계정 Map 엔트리 수를 반환한다. churn 계정의 엔트리가 0 도달 시
   * 삭제되는지(누적 방지)는 reserve/release 행동만으로는 `set(0)`과 구별되지 않으므로 이 인스펙터로 관측한다.
   * 프로덕션 회계에는 참여하지 않는다.
   */
  activeAccountCount(): number
}

/**
 * 정원 매니저를 만든다. 상태(전역 카운터·계정별 카운터 Map)는 클로저에 캡슐화한다.
 *
 * `reserve`는 상한을 초과하면 증가 없이 거부하고, 여유가 있으면 전역·계정 카운터를 함께 증가시킨다(전역 게이트
 * 우선). `release`는 계정 엔트리가 있을 때만 전역·계정 카운터를 함께 감소시켜 두 카운터를 원자적으로 유지하고,
 * 계정 카운터가 0이 되면 Map 엔트리를 삭제해 churn 계정의 무한 엔트리 누적을 막는다. 부재 계정 release나
 * 이중 반납(중복 release)은 어느 카운터도 건드리지 않는 완전 no-op이다(음수·desync 없음).
 */
export function createConnectionQuota(getLimits: () => ConnectionQuotaLimits): ConnectionQuota {
  let globalCount = 0
  const perAccount = new Map<string, number>()

  function reserve(accountId: string): ReserveResult {
    // 매 호출 상한을 지연 조회한다(thunk 관례) — 검사·증가를 같은 동기 스택에서 마쳐 overshoot를 막는다.
    const limits = getLimits()

    if (globalCount >= limits.maxGlobal) {
      return { ok: false, code: 503 }
    }

    const accountCount = perAccount.get(accountId) ?? 0
    if (accountCount >= limits.maxPerAccount) {
      return { ok: false, code: 429 }
    }

    globalCount += 1
    perAccount.set(accountId, accountCount + 1)
    return { ok: true }
  }

  function release(accountId: string): void {
    // 계정 엔트리를 먼저 조회한다 — 반납할 실제 슬롯이 있을 때만 두 카운터를 함께 감소시켜
    // 회계를 원자적으로 유지한다. 엔트리가 없으면(부재 계정 또는 이미 완전 반납된 계정의 중복 release)
    // 전역 카운터도 건드리지 않는다. 전역만 먼저 깎으면 다른 계정이 슬롯을 쥔 상황에서 중복 release가
    // 전역 카운터를 per-account 합과 desync시켜 전역 상한을 초과 점유하게 만든다.
    const accountCount = perAccount.get(accountId)
    if (accountCount === undefined) {
      return
    }
    // 전역 카운터는 0에서 clamp — 정상 회계에선 엔트리 존재 시 항상 양수지만 방어적으로 clamp한다.
    if (globalCount > 0) {
      globalCount -= 1
    }
    const next = accountCount - 1
    if (next <= 0) {
      // 0에 도달하면 엔트리를 삭제해 새 계정처럼 초기화하고 Map 누적을 막는다.
      perAccount.delete(accountId)
    } else {
      perAccount.set(accountId, next)
    }
  }

  function activeAccountCount(): number {
    return perAccount.size
  }

  return { reserve, release, activeAccountCount }
}
