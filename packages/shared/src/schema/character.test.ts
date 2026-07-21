import { describe, it, expect } from 'vitest'
// 배럴을 통해 임포트 — 다섯 스키마 파일 + 배럴 전체를 커버리지에 태운다.
import { characterSchema, type Character } from './index.js'

// 유효한 캐릭터 문서 하나를 만든 뒤 케이스별로 변형한다.
function validCharacter(): Character {
  return {
    _id: 'char-1',
    accountId: 'acc-1',
    name: '타이',
    class: 3,
    race: 1,
    stats: [10, 12, 14, 8, 16],
    gold: 500,
    currentRoom: 1,
    hpCurrent: 54,
    mpCurrent: 50,
    level: 1,
    experience: 0,
    schemaVersion: 1,
    status: 'active',
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

  it('자격증명 필드를 담으면 거부한다 (strict)', () => {
    expect(
      characterSchema.safeParse({ ...validCharacter(), password: 'secret' }).success,
    ).toBe(false)
  })

  it('accountId가 없으면 거부한다 (필수 FK)', () => {
    const doc = validCharacter() as Partial<Character>
    delete doc.accountId
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('accountId·status를 담은 문서를 통과시킨다', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      accountId: 'acc-42',
      status: 'active',
    })
    expect(result.success).toBe(true)
  })

  it('status를 생략하면 active로 기본값을 채운다', () => {
    const doc = validCharacter() as Partial<Character>
    delete doc.status
    const result = characterSchema.safeParse(doc)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('active')
  })

  it('deletedAt은 선택 필드다 (soft-delete)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      status: 'deleted',
      deletedAt: new Date('2026-07-16T00:00:00Z'),
    })
    expect(result.success).toBe(true)
  })

  it('gender·weapon·alignment는 선택 필드다 (생략해도 통과 — 기존 픽스처 불변)', () => {
    const doc = validCharacter() as Partial<Character>
    expect('gender' in doc).toBe(false)
    const result = characterSchema.safeParse(doc)
    expect(result.success).toBe(true)
  })

  it('gender·weapon·alignment 정수를 담은 문서를 통과시킨다 (생성 선택 저장)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      gender: 1,
      weapon: 2,
      alignment: 2,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.gender).toBe(1)
      expect(result.data.weapon).toBe(2)
      expect(result.data.alignment).toBe(2)
    }
  })

  it('gender가 정수가 아니면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), gender: 1.5 }).success).toBe(false)
  })

  it('hpCurrent·mpCurrent·level이 없으면 거부한다 (전투 필수 영속 필드)', () => {
    // D3 발산: gender/weapon/alignment는 선택이지만 이 3필드는 전투가 값을 요구해 required다.
    const base = validCharacter() as Partial<Character>
    delete base.hpCurrent
    delete base.mpCurrent
    delete base.level
    expect(characterSchema.safeParse(base).success).toBe(false)
  })

  it('level이 1 미만이면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), level: 0 }).success).toBe(false)
  })

  it('hpCurrent가 음수이면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), hpCurrent: -1 }).success).toBe(false)
  })

  it('experience가 없으면 거부한다 (레벨링 필수 영속 필드)', () => {
    // level/hpCurrent/mpCurrent와 동렬 — v2 문서는 load 직전 backfillCharacterV3가 승격한다.
    const doc = validCharacter() as Partial<Character>
    delete doc.experience
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('experience가 음수이면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), experience: -1 }).success).toBe(false)
  })

  it('experience가 정수가 아니면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), experience: 1.5 }).success).toBe(false)
  })
})

// 컴파일 타임 가드 — Character 추론 타입에 accountId 키가 있고 inventory/자격증명 키가 없음을 tsc가 강제한다.
type _NoInventory = 'inventory' extends keyof Character ? never : true
type _HasAccountId = 'accountId' extends keyof Character ? true : never
type _NoPassword = 'password' extends keyof Character ? never : true
const _noInventory: _NoInventory = true
const _hasAccountId: _HasAccountId = true
const _noPassword: _NoPassword = true
void _noInventory
void _hasAccountId
void _noPassword
