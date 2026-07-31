import { describe, it, expect } from 'vitest'
import {
  clientCommandSchema,
  serverEventSchema,
  errorCodeSchema,
  freeTextPayloadSchema,
  noArgsPayloadSchema,
  targetOrdinalPayloadSchema,
  targetSecondaryPayloadSchema,
  characterSummarySchema,
  promptKindSchema,
  promptOptionSchema,
  PROTOCOL_VERSION,
} from '../index.js'

describe('shared 루트 배럴 re-export', () => {
  it('프로토콜 스키마·상수를 이름 충돌 없이 노출한다', () => {
    expect(clientCommandSchema).toBeDefined()
    expect(serverEventSchema).toBeDefined()
    expect(errorCodeSchema).toBeDefined()
    expect(freeTextPayloadSchema).toBeDefined()
    expect(noArgsPayloadSchema).toBeDefined()
    expect(targetOrdinalPayloadSchema).toBeDefined()
    expect(targetSecondaryPayloadSchema).toBeDefined()
    expect(characterSummarySchema).toBeDefined()
    expect(promptKindSchema).toBeDefined()
    expect(promptOptionSchema).toBeDefined()
    expect(PROTOCOL_VERSION).toBe(4)
  })

  it('세션 command·event variant를 루트 배럴로 파싱한다', () => {
    expect(
      clientCommandSchema.safeParse({
        type: 'session:selectCharacter',
        characterId: 'char-1',
      }).success,
    ).toBe(true)
    expect(
      serverEventSchema.safeParse({
        type: 'session:characterList',
        characters: [{ characterId: 'char-1', name: '테스토스', class: 1, race: 2, level: 5 }],
      }).success,
    ).toBe(true)
    expect(errorCodeSchema.safeParse('unauthorized').success).toBe(true)
  })

  it('핸드셰이크 왕복이 버전 상수로 정합한다', () => {
    expect(
      clientCommandSchema.safeParse({ type: 'system:ready', protocolVersion: PROTOCOL_VERSION })
        .success,
    ).toBe(true)
    expect(
      serverEventSchema.safeParse({ type: 'system:hello', protocolVersion: PROTOCOL_VERSION })
        .success,
    ).toBe(true)
  })
})
