import { describe, it, expect } from 'vitest'
import { clientCommandSchema } from './commands.js'

describe('clientCommandSchema (client→server 봉투)', () => {
  describe('system:ready', () => {
    it('protocolVersion(정수)이 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'system:ready', protocolVersion: 1 })
      expect(parsed.success).toBe(true)
    })

    it('protocolVersion이 정수가 아니면 거부한다', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'system:ready', protocolVersion: 1.5 }).success,
      ).toBe(false)
    })

    it('protocolVersion이 없으면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'system:ready' }).success).toBe(false)
    })
  })

  describe('debug:echo', () => {
    it('text만 있으면 통과한다 (id 생략)', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo') {
        expect(parsed.data.id).toBeUndefined()
      }
    })

    it('text + id가 있으면 통과한다', () => {
      const parsed = clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑', id: 'c1' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'debug:echo') {
        expect(parsed.data.id).toBe('c1')
      }
    })

    it('text가 빈 문자열이면 거부한다', () => {
      expect(clientCommandSchema.safeParse({ type: 'debug:echo', text: '' }).success).toBe(false)
    })

    it('알 수 없는 키를 거부한다 (재사용 후에도 strict 유지)', () => {
      expect(
        clientCommandSchema.safeParse({ type: 'debug:echo', text: '핑', extra: true }).success,
      ).toBe(false)
    })
  })

  it('event 전용 type(system:hello)을 거부한다', () => {
    expect(
      clientCommandSchema.safeParse({ type: 'system:hello', protocolVersion: 1 }).success,
    ).toBe(false)
  })

  it('알 수 없는 discriminator를 거부한다', () => {
    expect(clientCommandSchema.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
