import { describe, it, expect } from 'vitest'
import { buildActorContext } from './actorContext.js'
import { createConnectionContext, type ConnectionContext } from './connection.js'

// buildActorContext 배선 불변식 단위 스펙 — command 상태에서 account·boundCharacterId가 둘 다
// non-null이어야 한다는 불변식을 방어선으로 검증한다(정상 경로에선 도달 불가한 throw).
describe('buildActorContext', () => {
  it('account가 null이면 배선 불변식 위반으로 throw한다', () => {
    // account만 null(boundCharacterId는 non-null)이라 검증 대상이 account 가드임을 보장한다.
    const ctx: ConnectionContext = {
      ...createConnectionContext(),
      account: null,
      boundCharacterId: 'char-1',
    }
    expect(() => buildActorContext(ctx)).toThrow()
  })

  it('boundCharacterId가 null이면 배선 불변식 위반으로 throw한다', () => {
    // account는 non-null로 두어 선행 account 가드를 통과시킨다 — 실패 원인이 boundCharacterId 가드가 되게 한다.
    const ctx: ConnectionContext = {
      ...createConnectionContext(),
      account: { accountId: 'acc-1' },
      boundCharacterId: null,
    }
    expect(() => buildActorContext(ctx)).toThrow()
  })

  it('account·boundCharacterId가 모두 non-null이면 { accountId, characterId }를 반환한다', () => {
    const ctx: ConnectionContext = {
      ...createConnectionContext(),
      account: { accountId: 'acc-1' },
      boundCharacterId: 'char-1',
    }
    const actor = buildActorContext(ctx)
    expect(actor).toEqual({ accountId: 'acc-1', characterId: 'char-1' })
  })

  it('반환 객체는 class/level/flags 키를 포함하지 않는다 (E3엔 실 캐릭터 상태 조회원이 없다)', () => {
    const ctx: ConnectionContext = {
      ...createConnectionContext(),
      account: { accountId: 'acc-1' },
      boundCharacterId: 'char-1',
    }
    const actor = buildActorContext(ctx)
    expect(actor).not.toHaveProperty('class')
    expect(actor).not.toHaveProperty('level')
    expect(actor).not.toHaveProperty('flags')
  })
})
