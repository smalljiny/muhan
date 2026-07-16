import { describe, it, expect } from 'vitest'
// 배럴을 통해 임포트 — 스키마 파일 + 배럴 전체를 커버리지에 태운다.
import { accountSchema, type Account } from './index.js'

// 유효한 계정 문서 하나를 만든 뒤 케이스별로 변형한다.
function validAccount(): Account {
  return {
    _id: 'firebase-uid-1',
    email: 'user@example.com',
    role: 'player',
    status: 'active',
    createdAt: new Date('2026-07-16T00:00:00Z'),
  }
}

describe('accountSchema', () => {
  it('유효한 문서를 통과시킨다', () => {
    const result = accountSchema.safeParse(validAccount())
    expect(result.success).toBe(true)
  })

  it('role을 생략하면 player로 기본값을 채운다', () => {
    const doc = validAccount() as Partial<Account>
    delete doc.role
    const result = accountSchema.safeParse(doc)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.role).toBe('player')
  })

  it('status를 생략하면 active로 기본값을 채운다', () => {
    const doc = validAccount() as Partial<Account>
    delete doc.status
    const result = accountSchema.safeParse(doc)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('active')
  })

  it('email은 선택 필드다 (생략 허용)', () => {
    const doc = validAccount() as Partial<Account>
    delete doc.email
    const result = accountSchema.safeParse(doc)
    expect(result.success).toBe(true)
  })

  it('email 형식이 올바르면 통과한다', () => {
    const result = accountSchema.safeParse({ ...validAccount(), email: 'a.b+tag@sub.domain.co' })
    expect(result.success).toBe(true)
  })

  it('email 형식이 올바르지 않으면 거부한다', () => {
    const result = accountSchema.safeParse({ ...validAccount(), email: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('_id가 빈 문자열이면 거부한다', () => {
    const result = accountSchema.safeParse({ ...validAccount(), _id: '' })
    expect(result.success).toBe(false)
  })

  it('role이 허용 목록 밖이면 거부한다', () => {
    const result = accountSchema.safeParse({ ...validAccount(), role: 'superuser' })
    expect(result.success).toBe(false)
  })

  it('createdAt은 date로 강제한다 (ISO 문자열 coerce)', () => {
    const result = accountSchema.safeParse({
      ...validAccount(),
      createdAt: '2026-07-16T00:00:00Z',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.createdAt).toBeInstanceOf(Date)
  })

  it('알 수 없는 필드를 담으면 거부한다 (strict)', () => {
    const result = accountSchema.safeParse({ ...validAccount(), passwordHash: 'x' })
    expect(result.success).toBe(false)
  })
})
