import { describe, it, expect } from 'vitest'
import { objectSchema, type ObjectInstance } from './index.js'

// 유효한 오브젝트 인스턴스 문서 (캐릭터 소유).
function validObject(): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 42,
    type: 5,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 1200,
    shotscur: 3,
    schemaVersion: 1,
  }
}

describe('objectSchema', () => {
  it('유효한 문서를 통과시킨다', () => {
    expect(objectSchema.safeParse(validObject()).success).toBe(true)
  })

  it('owner가 character 판별자면 통과한다', () => {
    const doc = { ...validObject(), owner: { type: 'character' as const, id: 'char-9' } }
    expect(objectSchema.safeParse(doc).success).toBe(true)
  })

  it('owner가 bank 판별자면 통과한다', () => {
    const doc = { ...validObject(), owner: { type: 'bank' as const, id: 'bank-9' } }
    expect(objectSchema.safeParse(doc).success).toBe(true)
  })

  it('owner.type이 알 수 없는 값이면 거부한다', () => {
    const doc = { ...validObject(), owner: { type: 'guild', id: 'g-1' } }
    expect(objectSchema.safeParse(doc).success).toBe(false)
  })

  it('owner.id가 없으면 거부한다', () => {
    const doc = { ...validObject(), owner: { type: 'character' } }
    expect(objectSchema.safeParse(doc).success).toBe(false)
  })

  it('type이 0..14 범위를 벗어나면 거부한다', () => {
    expect(objectSchema.safeParse({ ...validObject(), type: -1 }).success).toBe(false)
    expect(objectSchema.safeParse({ ...validObject(), type: 15 }).success).toBe(false)
  })

  it('type 경계값 0·14는 통과한다', () => {
    expect(objectSchema.safeParse({ ...validObject(), type: 0 }).success).toBe(true)
    expect(objectSchema.safeParse({ ...validObject(), type: 14 }).success).toBe(true)
  })

  it('value가 음수이면 거부한다', () => {
    expect(objectSchema.safeParse({ ...validObject(), value: -1 }).success).toBe(false)
  })

  it('slot은 정수 또는 null을 허용한다', () => {
    expect(objectSchema.safeParse({ ...validObject(), slot: 2 }).success).toBe(true)
    expect(objectSchema.safeParse({ ...validObject(), slot: null }).success).toBe(true)
    expect(objectSchema.safeParse({ ...validObject(), slot: 1.5 }).success).toBe(false)
  })

  it('shotscur가 정수가 아니면 거부한다', () => {
    expect(objectSchema.safeParse({ ...validObject(), shotscur: 'full' }).success).toBe(false)
  })

  it('schemaVersion이 없으면 거부한다 (필수)', () => {
    const doc = validObject() as Partial<ObjectInstance>
    delete doc.schemaVersion
    expect(objectSchema.safeParse(doc).success).toBe(false)
  })

  it('_id가 없으면 거부한다 (필수)', () => {
    const doc = validObject() as Partial<ObjectInstance>
    delete doc._id
    expect(objectSchema.safeParse(doc).success).toBe(false)
  })
})
