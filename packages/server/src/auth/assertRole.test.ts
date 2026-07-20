import { describe, it, expect } from 'vitest'
import type { Account } from 'shared'
import { assertRole, RoleError } from './assertRole.js'

/**
 * RBAC assertRole 인가 seam 단위 스펙 — 계정 role에 대한 계층적 권한 게이트.
 *
 * 정책: player < builder < dm < admin (계층적 >= 비교). role rank가 요구 rank 이상이면
 * 통과(void), 미만이면 RoleError. exact-equality가 아니라 계층 비교다 — dm은 builder 게이트를
 * 통과하고 admin은 모든 게이트를 통과한다. 실제 권한 게이트 명령은 A13으로 유예되며, 이 seam은
 * assertRole 함수와 role 필드만 제공한다(RBAC 어댑터 배선 없음).
 */
const roleOf = (role: Account['role']): Pick<Account, 'role'> => ({ role })

describe('assertRole 통과 (role rank >= 요구 rank)', () => {
  it('같은 role은 자기 게이트를 통과한다 (player→player, admin→admin)', () => {
    expect(() => assertRole(roleOf('player'), 'player')).not.toThrow()
    expect(() => assertRole(roleOf('admin'), 'admin')).not.toThrow()
  })

  it('상위 role은 하위 게이트를 통과한다 (dm→builder, admin→dm, builder→player)', () => {
    expect(() => assertRole(roleOf('dm'), 'builder')).not.toThrow()
    expect(() => assertRole(roleOf('admin'), 'dm')).not.toThrow()
    expect(() => assertRole(roleOf('builder'), 'player')).not.toThrow()
    expect(() => assertRole(roleOf('dm'), 'player')).not.toThrow()
    expect(() => assertRole(roleOf('admin'), 'player')).not.toThrow()
  })
})

describe('assertRole 실패 (role rank < 요구 rank → RoleError)', () => {
  it('하위 role은 상위 게이트에서 RoleError를 던진다', () => {
    expect(() => assertRole(roleOf('player'), 'builder')).toThrow(RoleError)
    expect(() => assertRole(roleOf('player'), 'dm')).toThrow(RoleError)
    expect(() => assertRole(roleOf('player'), 'admin')).toThrow(RoleError)
    expect(() => assertRole(roleOf('builder'), 'dm')).toThrow(RoleError)
    expect(() => assertRole(roleOf('builder'), 'admin')).toThrow(RoleError)
    expect(() => assertRole(roleOf('dm'), 'admin')).toThrow(RoleError)
  })
})

describe('계층 경계 잠금 (builder < dm, swap 회귀 방어)', () => {
  it('builder→dm은 던지고 dm→builder는 통과한다 (순서 방향 고정)', () => {
    expect(() => assertRole(roleOf('builder'), 'dm')).toThrow(RoleError)
    expect(() => assertRole(roleOf('dm'), 'builder')).not.toThrow()
  })
})

describe('assertRole 순수성 (전역 상태 없음)', () => {
  it('입력 계정 객체를 변형하지 않는다', () => {
    const account = roleOf('dm')
    assertRole(account, 'builder')
    expect(account).toEqual({ role: 'dm' })
  })

  it('반복 호출이 동일 결과를 낸다 (전역 상태 누적 없음)', () => {
    expect(() => assertRole(roleOf('builder'), 'dm')).toThrow(RoleError)
    expect(() => assertRole(roleOf('builder'), 'dm')).toThrow(RoleError)
    expect(() => assertRole(roleOf('dm'), 'builder')).not.toThrow()
    expect(() => assertRole(roleOf('dm'), 'builder')).not.toThrow()
  })
})
