import { describe, it, expect } from 'vitest'
// 배럴을 통해 임포트 — 네 스키마 파일 + 배럴 전체를 커버리지에 태운다.
import { characterSchema, type Character } from './index.js'

// 유효한 캐릭터 문서 하나를 만든 뒤 케이스별로 변형한다.
function validCharacter(): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 3,
    race: 1,
    stats: [10, 12, 14, 8, 16],
    gold: 500,
    currentRoom: 1,
    schemaVersion: 1,
  }
}

describe('characterSchema', () => {
  it('유효한 문서를 통과시킨다', () => {
    const result = characterSchema.safeParse(validCharacter())
    expect(result.success).toBe(true)
  })

  it('name이 빈 문자열이면 거부한다', () => {
    const result = characterSchema.safeParse({ ...validCharacter(), name: '' })
    expect(result.success).toBe(false)
  })

  it('stats가 5-length 튜플이 아니면 거부한다', () => {
    const four = characterSchema.safeParse({ ...validCharacter(), stats: [1, 2, 3, 4] })
    expect(four.success).toBe(false)
    const six = characterSchema.safeParse({ ...validCharacter(), stats: [1, 2, 3, 4, 5, 6] })
    expect(six.success).toBe(false)
  })

  it('stats 원소가 정수가 아니면 거부한다', () => {
    const result = characterSchema.safeParse({ ...validCharacter(), stats: [1, 2, 3, 4, 1.5] })
    expect(result.success).toBe(false)
  })

  it('gold가 음수이면 거부한다', () => {
    const result = characterSchema.safeParse({ ...validCharacter(), gold: -1 })
    expect(result.success).toBe(false)
  })

  it('class·race가 정수가 아니면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), class: 1.2 }).success).toBe(false)
    expect(characterSchema.safeParse({ ...validCharacter(), race: 'human' }).success).toBe(false)
  })

  it('schemaVersion이 없으면 거부한다 (필수)', () => {
    const doc = validCharacter() as Partial<Character>
    delete doc.schemaVersion
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('_id가 없으면 거부한다 (필수)', () => {
    const doc = validCharacter() as Partial<Character>
    delete doc._id
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('권한 인벤토리 배열 필드를 담으면 거부한다 (strict — 조용한 strip 없이 드리프트를 에러로)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      inventory: ['obj-1', 'obj-2'],
    })
    expect(result.success).toBe(false)
  })

  it('자격증명·accountId 필드를 담으면 거부한다 (strict)', () => {
    expect(
      characterSchema.safeParse({ ...validCharacter(), password: 'secret' }).success,
    ).toBe(false)
    expect(
      characterSchema.safeParse({ ...validCharacter(), accountId: 'acc-1' }).success,
    ).toBe(false)
  })
})

// 컴파일 타임 가드 — Character 추론 타입에 inventory/accountId/자격증명 키가 없음을 tsc가 강제한다.
type _NoInventory = 'inventory' extends keyof Character ? never : true
type _NoAccountId = 'accountId' extends keyof Character ? never : true
type _NoPassword = 'password' extends keyof Character ? never : true
const _noInventory: _NoInventory = true
const _noAccountId: _NoAccountId = true
const _noPassword: _NoPassword = true
void _noInventory
void _noAccountId
void _noPassword
