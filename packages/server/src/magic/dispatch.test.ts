import { describe, it, expect } from 'vitest'
import { SPELL_NO } from 'shared'
import { SpellDispatch, NOT_IMPLEMENTED } from './dispatch.js'

/**
 * 주문번호 → 핸들러 디스패치 테스트.
 *
 * 입력 키는 주문번호(spellNo)다 — 한글 주문명 해소는 command router 소관(본 토픽 밖).
 * 분기 판정은 SPELL_CATALOG(spellByNo.offensive)를 데이터 원천으로 소비한다:
 * offensive 20 → 등록 가능한 핸들러 슬롯, 비-offensive 36 → NOT_IMPLEMENTED(#85 유예).
 */

// 테스트용 핸들러 형태 — S5 offensiveSpell·S6 crtSpell이 실 형태를 결정한다(#84는 배선만).
type StubHandler = () => string

describe('SpellDispatch', () => {
  it('등록된 offensive 주문번호를 핸들러 슬롯으로 해소한다', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    const handler: StubHandler = () => 'cast'
    dispatch.register(SPELL_NO.SHURTS, handler)
    expect(dispatch.resolve(SPELL_NO.SHURTS)).toBe(handler)
  })

  it('미등록 offensive 주문번호는 undefined로 해소한다(등록 대기 슬롯)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(dispatch.resolve(SPELL_NO.SHURTS)).toBeUndefined()
  })

  it('비-offensive 주문번호는 NOT_IMPLEMENTED 마커로 해소한다(#85 유예)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    // SVIGOR(회복)은 비-offensive.
    expect(dispatch.resolve(SPELL_NO.SVIGOR)).toBe(NOT_IMPLEMENTED)
    // SFEARS(공포)도 비-offensive.
    expect(dispatch.resolve(SPELL_NO.SFEARS)).toBe(NOT_IMPLEMENTED)
  })

  it('비-offensive 주문 등록을 거부한다(offensive만 등록 가능한 슬롯)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(() => dispatch.register(SPELL_NO.SVIGOR, () => 'x')).toThrow()
  })

  it('카탈로그 밖 주문번호는 undefined로 해소한다', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(dispatch.resolve(999)).toBeUndefined()
  })

  it('카탈로그 밖 주문 등록을 거부한다', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(() => dispatch.register(999, () => 'x')).toThrow()
  })

  it('선형 탐색 대신 Map 조회로 등록 순서와 무관하게 해소한다', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    const a: StubHandler = () => 'a'
    const b: StubHandler = () => 'b'
    // 다른 tier의 offensive 두 주문 등록.
    dispatch.register(SPELL_NO.SICEBL, a)
    dispatch.register(SPELL_NO.SHURTS, b)
    expect(dispatch.resolve(SPELL_NO.SHURTS)).toBe(b)
    expect(dispatch.resolve(SPELL_NO.SICEBL)).toBe(a)
  })
})
