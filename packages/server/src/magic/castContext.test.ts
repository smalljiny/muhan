import { describe, it, expect, expectTypeOf } from 'vitest'
import type { RoomNode } from 'shared'
import type { ResolveContext } from '../combat/resolveAttack.js'
import type { CastContext } from './castContext.js'

/**
 * CastContext 타입 테스트 — ResolveContext를 확장(intersection)해 gated 플래그만 더한 시전 컨텍스트.
 *
 * gated가 how==CAST 게이트를 단일화한다: 개별 게이트 분기 대신 이 한 플래그로 CAST(gated=true) vs
 * 아이템(gated=false) 경로를 구분한다. 타입 중복 정의를 피하려 ResolveContext를 재사용한다.
 */
describe('CastContext', () => {
  it('ResolveContext의 전 필드 + gated를 갖는다(구조적 확장)', () => {
    // 컴파일 시 확인: CastContext는 ResolveContext에 gated:boolean을 더한 형태다.
    expectTypeOf<CastContext>().toMatchTypeOf<ResolveContext>()
    expectTypeOf<CastContext>().toHaveProperty('gated').toEqualTypeOf<boolean>()
  })

  it('gated=true/false 두 값을 담는 런타임 객체를 조립할 수 있다', () => {
    const base: Omit<CastContext, 'gated'> = {
      rng: (min: number, _max: number) => min,
      room: {} as RoomNode,
      now: 0,
      fireCreatureDeath: () => undefined,
      firePlayerDeath: () => undefined,
      ledger: new Map(),
    }
    const cast: CastContext = { ...base, gated: true }
    const item: CastContext = { ...base, gated: false }
    expect(cast.gated).toBe(true)
    expect(item.gated).toBe(false)
  })
})
