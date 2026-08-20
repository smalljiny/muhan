import { describe, it, expect } from 'vitest'
import {
  noArgsPayloadSchema,
  targetOrdinalPayloadSchema,
  targetSecondaryPayloadSchema,
  freeTextPayloadSchema,
  COMMAND_TARGET_MAX,
  COMMAND_ORDINAL_MAX,
} from './payloads.js'

describe('noArgsPayloadSchema (인자 없음)', () => {
  it('빈 객체를 통과시킨다', () => {
    expect(noArgsPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('알 수 없는 키를 거부한다 (strict)', () => {
    expect(noArgsPayloadSchema.safeParse({ target: 'x' }).success).toBe(false)
  })
})

describe('targetOrdinalPayloadSchema (대상 + 서수)', () => {
  it('target만 있으면 통과한다 (ordinal 생략)', () => {
    const parsed = targetOrdinalPayloadSchema.safeParse({ target: '검' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.ordinal).toBeUndefined()
  })

  it('target + ordinal(정수)이 있으면 통과한다', () => {
    const parsed = targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: 2 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.ordinal).toBe(2)
  })

  it('target이 빈 문자열이면 거부한다', () => {
    expect(targetOrdinalPayloadSchema.safeParse({ target: '' }).success).toBe(false)
  })

  it('target이 없으면 거부한다', () => {
    expect(targetOrdinalPayloadSchema.safeParse({ ordinal: 1 }).success).toBe(false)
  })

  it('ordinal이 정수가 아니면 거부한다', () => {
    expect(targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: 1.5 }).success).toBe(false)
  })

  // 상한·하한이 이 블록에 있으므로 경계값도 여기서 고정한다 — 이 블록을 spread하는 명령
  // (progress:study·combat:attack)은 자기 리터럴을 갖지 않아 검증 지점이 여기 하나다.
  it('target 상한 경계 — COMMAND_TARGET_MAX는 통과하고 1자 초과는 거부한다', () => {
    expect(
      targetOrdinalPayloadSchema.safeParse({ target: 'ㄱ'.repeat(COMMAND_TARGET_MAX) }).success,
    ).toBe(true)
    expect(
      targetOrdinalPayloadSchema.safeParse({ target: 'ㄱ'.repeat(COMMAND_TARGET_MAX + 1) }).success,
    ).toBe(false)
  })

  it('ordinal 하한 1 — 0과 음수를 거부한다', () => {
    expect(targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: 1 }).success).toBe(true)
    expect(targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: 0 }).success).toBe(false)
    expect(targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: -1 }).success).toBe(false)
  })

  it('ordinal 상한 경계 — COMMAND_ORDINAL_MAX는 통과하고 1 초과는 거부한다', () => {
    expect(
      targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: COMMAND_ORDINAL_MAX }).success,
    ).toBe(true)
    expect(
      targetOrdinalPayloadSchema.safeParse({ target: '검', ordinal: COMMAND_ORDINAL_MAX + 1 })
        .success,
    ).toBe(false)
  })
})

describe('targetSecondaryPayloadSchema (대상 + 보조 대상)', () => {
  it('target + secondary가 있으면 통과한다', () => {
    expect(
      targetSecondaryPayloadSchema.safeParse({ target: '열쇠', secondary: '상자' }).success,
    ).toBe(true)
  })

  it('secondary가 없으면 거부한다', () => {
    expect(targetSecondaryPayloadSchema.safeParse({ target: '열쇠' }).success).toBe(false)
  })

  it('secondary가 빈 문자열이면 거부한다', () => {
    expect(targetSecondaryPayloadSchema.safeParse({ target: '열쇠', secondary: '' }).success).toBe(
      false,
    )
  })
})

describe('freeTextPayloadSchema (자유 텍스트)', () => {
  it('text가 있으면 통과한다', () => {
    expect(freeTextPayloadSchema.safeParse({ text: '안녕하세요' }).success).toBe(true)
  })

  it('text가 빈 문자열이면 거부한다', () => {
    expect(freeTextPayloadSchema.safeParse({ text: '' }).success).toBe(false)
  })

  it('알 수 없는 키를 거부한다 (strict)', () => {
    expect(freeTextPayloadSchema.safeParse({ text: '안녕', extra: true }).success).toBe(false)
  })
})
