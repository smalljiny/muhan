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
    // 지식 비트마스크(uint8[16]=128비트)와 realm 누적경험치[4]. v5에서 required로 도입.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
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

  it('statusEffects를 생략해도 통과한다 (선택 필드 — 기존 픽스처 불변)', () => {
    const doc = validCharacter() as Partial<Character>
    expect('statusEffects' in doc).toBe(false)
    const result = characterSchema.safeParse(doc)
    expect(result.success).toBe(true)
    // .optional()이 .default({})가 아님을 런타임에서 고정한다 — default였다면 파싱 후 {}가 주입된다.
    if (result.success) expect(result.data.statusEffects).toBeUndefined()
  })

  it('poison·disease·blind를 담은 statusEffects 문서를 통과시킨다 (절대-틱 만료)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: {
        poison: { until: 120, interval: 6 },
        disease: { until: 300, interval: 12 },
        blind: { until: 50 },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.statusEffects?.poison).toEqual({ until: 120, interval: 6 })
      expect(result.data.statusEffects?.blind).toEqual({ until: 50 })
    }
  })

  it('statusEffects의 각 효과는 선택적이다 (poison만 담아도 통과)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: { poison: { until: 60, interval: 6 } },
    })
    expect(result.success).toBe(true)
  })

  it('blind만 담은 statusEffects를 통과시킨다 (until만 요구)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: { blind: { until: 5 } },
    })
    expect(result.success).toBe(true)
  })

  it('blind에 interval을 담으면 거부한다 (strictObject — until만 허용)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: { blind: { until: 5, interval: 3 } },
    })
    expect(result.success).toBe(false)
  })

  it('poison의 until이 음수이면 거부한다', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: { poison: { until: -1, interval: 6 } },
    })
    expect(result.success).toBe(false)
  })

  it('poison에 interval이 없으면 거부한다 (until+interval 요구)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      statusEffects: { poison: { until: 60 } },
    })
    expect(result.success).toBe(false)
  })

  it('spells가 없으면 거부한다 (지식 비트마스크 필수 영속 필드)', () => {
    // D1 발산: hpCurrent/experience와 동렬 — v4 문서는 load 직전 backfillCharacterV5가 승격한다.
    const doc = validCharacter() as Partial<Character>
    delete doc.spells
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('spells가 16-length 배열이 아니면 거부한다 (uint8[16]=128비트)', () => {
    expect(
      characterSchema.safeParse({ ...validCharacter(), spells: new Array(15).fill(0) }).success,
    ).toBe(false)
    expect(
      characterSchema.safeParse({ ...validCharacter(), spells: new Array(17).fill(0) }).success,
    ).toBe(false)
  })

  it('spells 원소가 정수가 아니면 거부한다', () => {
    const bad = new Array<number>(16).fill(0)
    bad[0] = 1.5
    expect(characterSchema.safeParse({ ...validCharacter(), spells: bad }).success).toBe(false)
  })

  it('spells 원소가 uint8 범위(0–255)를 벗어나면 거부한다 (부호확장 knows 우회 차단)', () => {
    const neg = new Array<number>(16).fill(0)
    neg[0] = -1
    expect(characterSchema.safeParse({ ...validCharacter(), spells: neg }).success).toBe(false)
    const over = new Array<number>(16).fill(0)
    over[0] = 256
    expect(characterSchema.safeParse({ ...validCharacter(), spells: over }).success).toBe(false)
  })

  it('realm이 없으면 거부한다 (realm 누적경험치 필수 영속 필드)', () => {
    const doc = validCharacter() as Partial<Character>
    delete doc.realm
    expect(characterSchema.safeParse(doc).success).toBe(false)
  })

  it('realm이 4-length 튜플이 아니면 거부한다', () => {
    expect(characterSchema.safeParse({ ...validCharacter(), realm: [0, 0, 0] }).success).toBe(false)
    expect(
      characterSchema.safeParse({ ...validCharacter(), realm: [0, 0, 0, 0, 0] }).success,
    ).toBe(false)
  })

  it('realm 원소가 정수가 아니면 거부한다', () => {
    expect(
      characterSchema.safeParse({ ...validCharacter(), realm: [0, 1.5, 0, 0] }).success,
    ).toBe(false)
  })

  it('realm 원소가 음수이면 거부한다 (누적경험치는 비음수)', () => {
    expect(
      characterSchema.safeParse({ ...validCharacter(), realm: [0, -1, 0, 0] }).success,
    ).toBe(false)
  })

  it('buffs를 생략해도 통과한다 (선택 필드 — 기존 픽스처 불변)', () => {
    const doc = validCharacter() as Partial<Character>
    expect('buffs' in doc).toBe(false)
    const result = characterSchema.safeParse(doc)
    expect(result.success).toBe(true)
    // .optional()이 .default({})가 아님을 런타임에서 고정한다.
    if (result.success) expect(result.data.buffs).toBeUndefined()
  })

  it('주문번호별 {until} 엔트리를 담은 buffs 문서를 통과시킨다 (절대-틱 만료)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      buffs: { '4': { until: 120 }, '22': { until: 300 } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.buffs?.['4']).toEqual({ until: 120 })
    }
  })

  it('buffs가 카탈로그 밖 주문번호 키를 담으면 거부한다 (strictObject — 드리프트를 에러로)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      buffs: { '999': { until: 5 } },
    })
    expect(result.success).toBe(false)
  })

  it('buffs 엔트리에 interval을 담으면 거부한다 (strictObject — until만 허용)', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      buffs: { '4': { until: 5, interval: 3 } },
    })
    expect(result.success).toBe(false)
  })

  it('buffs 엔트리의 until이 음수이면 거부한다', () => {
    const result = characterSchema.safeParse({
      ...validCharacter(),
      buffs: { '4': { until: -1 } },
    })
    expect(result.success).toBe(false)
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
