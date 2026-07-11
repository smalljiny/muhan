import { describe, it, expect } from 'vitest'

import { createConnectionQuota } from './connectionQuota.js'
import type { ConnectionQuotaLimits } from './connectionQuota.js'

/** 고정 상한으로 quota를 만든다. thunk 관례를 미러하되 테스트는 결정적 상수를 넘긴다. */
function makeQuota(maxGlobal: number, maxPerAccount: number) {
  const limits: ConnectionQuotaLimits = { maxGlobal, maxPerAccount }
  return createConnectionQuota(() => limits)
}

describe('createConnectionQuota', () => {
  it('전역 상한 도달 시 초과 reserve는 증가 없이 503을 반환한다', () => {
    // maxGlobal=2, per-account는 넉넉 → 서로 다른 계정 2개가 성공하고 3번째가 503.
    const quota = makeQuota(2, 100)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('b')).toEqual({ ok: true })
    expect(quota.reserve('c')).toEqual({ ok: false, code: 503 })
  })

  it('계정별 상한 도달 시 초과 reserve는 증가 없이 429를 반환한다', () => {
    // maxPerAccount=2, global은 넉넉 → 한 계정 2개 성공, 3번째가 429.
    const quota = makeQuota(100, 2)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })
  })

  it('다른 계정이 슬롯을 쥔 상태의 중복 release는 전역 카운터를 desync시키지 않는다', () => {
    // 회귀 방어: release가 전역 카운터를 계정 엔트리 확인보다 먼저 깎으면, 이미 완전 반납된
    // 계정의 중복 release(abort-close + ws-close)가 다른 계정의 살아 있는 슬롯을 무시하고
    // 전역 카운터를 내려 전역 상한을 초과 점유하게 만든다. maxGlobal=2로 상한을 타이트하게 두고
    // 검증한다(단일 계정 idempotent 테스트는 전역이 0에 도달해 이 desync를 잡지 못한다).
    const quota = makeQuota(2, 100)

    expect(quota.reserve('a')).toEqual({ ok: true }) // global=1
    expect(quota.reserve('b')).toEqual({ ok: true }) // global=2 (포화)

    quota.release('a') // a 슬롯 반납 → global=1, b는 여전히 1슬롯 점유
    quota.release('a') // 중복 release: 반납할 슬롯 없음 → 전역·계정 모두 no-op이어야 한다

    // b가 실제 슬롯 1개를 쥐고 있으므로 전역 여유는 1뿐. c 1개만 성공하고 d는 503.
    expect(quota.reserve('c')).toEqual({ ok: true })            // global=2 (상한)
    expect(quota.reserve('d')).toEqual({ ok: false, code: 503 }) // desync면 global<2로 잘못 통과
  })

  it('전역 게이트가 계정 게이트보다 먼저 판정된다', () => {
    // 둘 다 상한이면 503(전역)이 우선.
    const quota = makeQuota(1, 1)
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 503 })
  })

  it('거부된 reserve는 전역 카운터를 증가시키지 않는다', () => {
    // maxGlobal=1: a가 슬롯을 잡고 b는 503으로 거부된다. 거부가 카운터를 오염시켰다면
    // a를 release한 뒤 b가 실패하겠지만, 거부는 no-op이므로 release 후 b가 성공해야 한다.
    const quota = makeQuota(1, 100)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('b')).toEqual({ ok: false, code: 503 })

    quota.release('a')
    expect(quota.reserve('b')).toEqual({ ok: true })
  })

  it('거부된 reserve는 계정 카운터를 증가시키지 않는다', () => {
    // maxPerAccount=1: 두 번째 a는 429. 거부가 계정 카운터를 올렸다면 release 한 번으로
    // 슬롯이 안 열리겠지만, 거부는 no-op이므로 release 후 재점유가 성공한다.
    const quota = makeQuota(100, 1)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })

    quota.release('a')
    expect(quota.reserve('a')).toEqual({ ok: true })
  })

  it('release는 idempotent하다 — 중복 release가 카운터를 음수로 만들지 않는다', () => {
    // reserve 1회 후 같은 계정을 두 번 release. 카운터가 음수로 새면 정원이 과대 복원돼
    // 상한을 초과해 reserve가 성공한다. 정확 복원이면 상한까지만 성공한다.
    // global은 넉넉히 두어 per-account 게이트(429)가 상한을 검증하게 한다.
    const quota = makeQuota(100, 2)

    expect(quota.reserve('a')).toEqual({ ok: true })
    quota.release('a')
    quota.release('a') // 이중 배선(abort-close + ws-close) 중복 release 시뮬레이션

    // 정확 복원이면 per-account 여유=2. a 2개까지만 성공하고 3번째는 429.
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })
  })

  it('계정이 여러 슬롯을 점유할 때 부분 release는 나머지 슬롯을 남긴다', () => {
    // a가 2슬롯 점유 후 1회 release → 계정 카운터는 1로 남고 엔트리는 유지된다.
    const quota = makeQuota(100, 3)

    expect(quota.reserve('a')).toEqual({ ok: true }) // a=1
    expect(quota.reserve('a')).toEqual({ ok: true }) // a=2
    quota.release('a') // a=1 (엔트리 유지)

    // 여유는 3-1=2. 2개 더 성공하고 3개째(총 3)에서 429.
    expect(quota.reserve('a')).toEqual({ ok: true }) // a=2
    expect(quota.reserve('a')).toEqual({ ok: true }) // a=3
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })
  })

  it('한 번도 reserve하지 않은 계정의 release는 no-op이다', () => {
    // 부재 계정 release가 음수로 새면 후속 정원 회계가 틀어진다.
    const quota = makeQuota(1, 1)

    quota.release('ghost') // 존재한 적 없는 계정
    quota.release('ghost')

    // 전역 슬롯 1개가 온전히 남아 있어야 한다.
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('b')).toEqual({ ok: false, code: 503 })
  })

  it('계정 카운터가 0이 되면 Map 엔트리를 삭제한다(누적 방지)', () => {
    // 행동만으로는 delete와 set(0)이 구별되지 않으므로 인스펙터로 엔트리 수를 직접 관측한다.
    const quota = makeQuota(100, 1)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.activeAccountCount()).toBe(1)

    quota.release('a')
    expect(quota.activeAccountCount()).toBe(0) // set(0) 잔존이면 1로 남아 실패한다

    // 완전 release 후에는 새 계정과 동일: 다시 1개 성공, 2개째 429.
    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })
  })

  it('여러 계정이 churn해도 완전 release된 계정은 Map에 누적되지 않는다', () => {
    const quota = makeQuota(100, 1)

    quota.reserve('a')
    quota.reserve('b')
    expect(quota.activeAccountCount()).toBe(2)

    quota.release('a')
    quota.release('b')
    expect(quota.activeAccountCount()).toBe(0) // churn 후 엔트리 0 — 무한 누적 없음
  })

  it('서로 다른 계정은 독립적이다 — 한 계정의 상한이 다른 계정을 막지 않는다', () => {
    // maxPerAccount=1, global은 넉넉. a가 자기 상한에 걸려도 b는 전역 여유 하에서 성공.
    const quota = makeQuota(100, 1)

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('a')).toEqual({ ok: false, code: 429 })
    expect(quota.reserve('b')).toEqual({ ok: true })
    expect(quota.reserve('b')).toEqual({ ok: false, code: 429 })
  })

  it('limits thunk를 지연 조회한다 — 호출 사이 상한 변경을 반영한다', () => {
    let maxGlobal = 1
    const quota = createConnectionQuota(() => ({ maxGlobal, maxPerAccount: 100 }))

    expect(quota.reserve('a')).toEqual({ ok: true })
    expect(quota.reserve('b')).toEqual({ ok: false, code: 503 })

    maxGlobal = 2 // 상한을 늘리면 다음 reserve가 이를 반영한다.
    expect(quota.reserve('b')).toEqual({ ok: true })
  })
})
