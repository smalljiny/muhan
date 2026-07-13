import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema, type GoldenFixture } from './types.js'

// 유효한 완전 fixture 팩토리 — 각 테스트가 여기서 필드를 덜어내거나 덮어쓴다.
function validFixture(): GoldenFixture {
  return {
    fn: 'computeThaco',
    oracle: {
      method: 'manual',
      source: 'combat.c:412',
      generatedAt: '2026-07-13T00:00:00.000Z',
      seed: null,
    },
    cases: [
      { input: { level: 1 }, expected: 20, note: 'clamp 하한 경계' },
      { input: { level: 20 }, expected: 1 },
    ],
  }
}

describe('goldenFixtureSchema', () => {
  it('유효한 완전 fixture를 통과시킨다', () => {
    expect(goldenFixtureSchema.safeParse(validFixture()).success).toBe(true)
  })

  it("method가 'manual'·'c-compile'이면 각각 통과한다", () => {
    const manual = validFixture()
    manual.oracle.method = 'manual'
    expect(goldenFixtureSchema.safeParse(manual).success).toBe(true)

    const cCompile = validFixture()
    cCompile.oracle.method = 'c-compile'
    expect(goldenFixtureSchema.safeParse(cCompile).success).toBe(true)
  })

  it("method가 두 유효 값 외이면 거부한다", () => {
    const doc = validFixture()
    ;(doc.oracle as { method: string }).method = 'auto'
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('seed가 number이면 통과한다 (nullable)', () => {
    const doc = validFixture()
    doc.oracle.seed = 42
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(true)
  })

  // 경험적 관찰(zod v4.4.3): z.unknown() 필드는 키 누락 시 거부된다(optional 아님).
  it('z.unknown() input·expected 키는 누락 시 거부된다 (경험적 확인)', () => {
    const missingInput = validFixture()
    delete (missingInput.cases[0] as { input?: unknown }).input
    expect(goldenFixtureSchema.safeParse(missingInput).success).toBe(false)

    const missingExpected = validFixture()
    delete (missingExpected.cases[0] as { expected?: unknown }).expected
    expect(goldenFixtureSchema.safeParse(missingExpected).success).toBe(false)
  })

  it('fn이 없으면 거부한다 (필수)', () => {
    const doc = validFixture() as Partial<GoldenFixture>
    delete doc.fn
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('oracle.method가 없으면 거부한다 (필수)', () => {
    const doc = validFixture()
    delete (doc.oracle as { method?: unknown }).method
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('oracle.source가 없으면 거부한다 (필수)', () => {
    const doc = validFixture()
    delete (doc.oracle as { source?: unknown }).source
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('oracle.generatedAt이 없으면 거부한다 (필수)', () => {
    const doc = validFixture()
    delete (doc.oracle as { generatedAt?: unknown }).generatedAt
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('oracle.seed 키가 없으면 거부한다 (nullable이되 non-optional)', () => {
    const doc = validFixture()
    delete (doc.oracle as { seed?: unknown }).seed
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('cases 키가 없으면 거부한다 (필수)', () => {
    const doc = validFixture() as Partial<GoldenFixture>
    delete doc.cases
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('cases가 빈 배열이면 거부한다 (.min(1) — vacuous-pass 차단)', () => {
    const doc = validFixture()
    doc.cases = []
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('case note가 있어도·없어도 통과한다 (optional)', () => {
    const withNote = validFixture()
    withNote.cases = [{ input: { level: 5 }, expected: 15, note: '중간값' }]
    expect(goldenFixtureSchema.safeParse(withNote).success).toBe(true)

    const withoutNote = validFixture()
    withoutNote.cases = [{ input: { level: 5 }, expected: 15 }]
    expect(goldenFixtureSchema.safeParse(withoutNote).success).toBe(true)
  })

  it('case note가 문자열이 아니면 거부한다', () => {
    const doc = validFixture()
    ;(doc.cases[0] as { note?: unknown }).note = 123
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('parse는 잘못된 입력에 throw한다', () => {
    expect(() => goldenFixtureSchema.parse({ fn: 'x' })).toThrow()
  })

  it('알 수 없는 최상위 키를 거부한다 (strict)', () => {
    const doc = { ...validFixture(), extra: 1 }
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('case의 오타 키(notee 등)를 거부한다 (strict)', () => {
    const doc = validFixture()
    ;(doc.cases[0] as { notee?: unknown }).notee = '오타'
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('fn이 빈 문자열이면 거부한다 (.min(1))', () => {
    const doc = validFixture()
    doc.fn = ''
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })

  it('generatedAt이 ISO datetime 형식이 아니면 거부한다', () => {
    const doc = validFixture()
    doc.oracle.generatedAt = '2026-07-13'
    expect(goldenFixtureSchema.safeParse(doc).success).toBe(false)
  })
})

// 컴파일 타임 가드 — GoldenFixture 제네릭이 input·expected 타입을 파라미터화한다.
type _Narrowed = GoldenFixture<{ level: number }, number>
const _narrowed: _Narrowed = {
  fn: 'computeThaco',
  oracle: {
    method: 'manual',
    source: 'combat.c:412',
    generatedAt: '2026-07-13T00:00:00.000Z',
    seed: null,
  },
  cases: [{ input: { level: 1 }, expected: 20 }],
}
void _narrowed
