import { describe, it, expect } from 'vitest'
import { bankAccountSchema, type BankAccount } from './index.js'

function validBankAccount(): BankAccount {
  return {
    _id: 'bank-1',
    owner: 'char-1',
    gold: 10_000,
    schemaVersion: 1,
  }
}

describe('bankAccountSchema', () => {
  it('유효한 문서를 통과시킨다', () => {
    expect(bankAccountSchema.safeParse(validBankAccount()).success).toBe(true)
  })

  it('gold가 음수이면 거부한다', () => {
    expect(bankAccountSchema.safeParse({ ...validBankAccount(), gold: -1 }).success).toBe(false)
  })

  it('gold가 3억을 초과하면 거부한다', () => {
    expect(
      bankAccountSchema.safeParse({ ...validBankAccount(), gold: 300_000_001 }).success,
    ).toBe(false)
  })

  it('gold 경계값 0·3억은 통과한다', () => {
    expect(bankAccountSchema.safeParse({ ...validBankAccount(), gold: 0 }).success).toBe(true)
    expect(
      bankAccountSchema.safeParse({ ...validBankAccount(), gold: 300_000_000 }).success,
    ).toBe(true)
  })

  it('gold가 정수가 아니면 거부한다', () => {
    expect(bankAccountSchema.safeParse({ ...validBankAccount(), gold: 1.5 }).success).toBe(false)
  })

  it('owner가 문자열이 아니면 거부한다', () => {
    expect(bankAccountSchema.safeParse({ ...validBankAccount(), owner: 123 }).success).toBe(false)
  })

  it('schemaVersion이 없으면 거부한다 (필수)', () => {
    const doc = validBankAccount() as Partial<BankAccount>
    delete doc.schemaVersion
    expect(bankAccountSchema.safeParse(doc).success).toBe(false)
  })

  it('_id가 없으면 거부한다 (필수)', () => {
    const doc = validBankAccount() as Partial<BankAccount>
    delete doc._id
    expect(bankAccountSchema.safeParse(doc).success).toBe(false)
  })

  it('권한 holdings 배열 필드를 담으면 거부한다 (strict)', () => {
    const result = bankAccountSchema.safeParse({ ...validBankAccount(), holdings: ['obj-1'] })
    expect(result.success).toBe(false)
  })
})

// 컴파일 타임 가드 — BankAccount 추론 타입에 holdings 키가 없음을 tsc가 강제한다.
type _NoHoldings = 'holdings' extends keyof BankAccount ? never : true
const _noHoldings: _NoHoldings = true
void _noHoldings
