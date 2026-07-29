import { describe, it, expect } from 'vitest'
import { PROTOCOL_VERSION } from './version.js'

describe('PROTOCOL_VERSION', () => {
  it('현재 와이어 프로토콜 버전은 3이다', () => {
    expect(PROTOCOL_VERSION).toBe(3)
  })

  it('단조 증가 정수 상수다', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1)
  })
})
