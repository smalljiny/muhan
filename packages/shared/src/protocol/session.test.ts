import { describe, it, expect } from 'vitest'
import {
  characterSummarySchema,
  promptKindSchema,
  promptOptionSchema,
} from './session.js'

describe('promptKindSchema', () => {
  it.each(['selectCharacter', 'createField'])('%s 종류를 통과시킨다', (kind) => {
    expect(promptKindSchema.safeParse(kind).success).toBe(true)
  })

  it('알 수 없는 종류를 거부한다', () => {
    expect(promptKindSchema.safeParse('confirm').success).toBe(false)
  })
})

describe('promptOptionSchema', () => {
  it('value + label(비어있지 않은 문자열)이면 통과한다', () => {
    expect(promptOptionSchema.safeParse({ value: '1', label: '전사' }).success).toBe(true)
  })

  it('value가 빈 문자열이면 거부한다', () => {
    expect(promptOptionSchema.safeParse({ value: '', label: '전사' }).success).toBe(false)
  })

  it('label이 빈 문자열이면 거부한다', () => {
    expect(promptOptionSchema.safeParse({ value: '1', label: '' }).success).toBe(false)
  })

  it('알 수 없는 키를 거부한다 (strict)', () => {
    expect(
      promptOptionSchema.safeParse({ value: '1', label: '전사', extra: true }).success,
    ).toBe(false)
  })
})

describe('characterSummarySchema (와이어 전용 캐릭터 요약 DTO)', () => {
  const valid = { characterId: 'char-1', name: '테스토스', class: 1, race: 2, level: 5 }

  it('완전한 요약이면 통과한다', () => {
    const parsed = characterSummarySchema.safeParse(valid)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.characterId).toBe('char-1')
      expect(parsed.data.level).toBe(5)
      expect(parsed.data.class).toBe(1)
      expect(parsed.data.race).toBe(2)
    }
  })

  it('characterId가 빈 문자열이면 거부한다', () => {
    expect(characterSummarySchema.safeParse({ ...valid, characterId: '' }).success).toBe(false)
  })

  it('name이 빈 문자열이면 거부한다', () => {
    expect(characterSummarySchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('class가 정수가 아니면 거부한다', () => {
    expect(characterSummarySchema.safeParse({ ...valid, class: 1.5 }).success).toBe(false)
  })

  it('level이 없으면 거부한다', () => {
    const withoutLevel = { characterId: 'char-1', name: '테스토스', class: 1, race: 2 }
    expect(characterSummarySchema.safeParse(withoutLevel).success).toBe(false)
  })

  it('알 수 없는 키를 거부한다 (strict)', () => {
    expect(characterSummarySchema.safeParse({ ...valid, extra: true }).success).toBe(false)
  })

  it('persistence 전용 필드명(_id)을 와이어 필드로 받지 않는다', () => {
    const withIdKey = { _id: 'char-1', name: '테스토스', class: 1, race: 2, level: 5 }
    expect(characterSummarySchema.safeParse(withIdKey).success).toBe(false)
  })
})
