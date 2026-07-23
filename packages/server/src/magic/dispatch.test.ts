import { describe, it, expect } from 'vitest'
import { SPELL_NO } from 'shared'
import { SpellDispatch } from './dispatch.js'

/**
 * 주문번호 → 핸들러 디스패치 테스트.
 *
 * 입력 키는 주문번호(spellNo)다 — 한글 주문명 해소는 command router 소관(본 토픽 밖).
 * S6(#85 G7 enabler)부터 register/resolve는 family-agnostic다: offensive·비-offensive를 가리지
 * 않고 카탈로그 주문이면 등록·해소하고, 카탈로그 밖 주문만 register가 throw한다. 미등록은 undefined.
 * 각 effect 모듈(S7~S10)은 자체 SpellDispatch<H> 인스턴스를 소유한다(핸들러 타입 이질성).
 */

// 테스트용 핸들러 형태 — 소비자(offensiveSpell·effect 모듈)가 실 형태를 결정한다.
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

  it('등록된 비-offensive 주문번호를 핸들러 슬롯으로 해소한다(family-agnostic)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    const handler: StubHandler = () => 'heal'
    // SVIGOR(회복)은 비-offensive지만 S6부터 등록 가능하다.
    dispatch.register(SPELL_NO.SVIGOR, handler)
    expect(dispatch.resolve(SPELL_NO.SVIGOR)).toBe(handler)
  })

  it('미등록 비-offensive 주문번호는 undefined로 해소한다(미등록이면 offensive와 동일)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    // SVIGOR(회복)·SFEARS(공포) 모두 비-offensive지만 미등록이면 undefined.
    expect(dispatch.resolve(SPELL_NO.SVIGOR)).toBeUndefined()
    expect(dispatch.resolve(SPELL_NO.SFEARS)).toBeUndefined()
  })

  it('비-offensive 주문 등록을 허용한다(offensive-only 제약 완화)', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(() => dispatch.register(SPELL_NO.SVIGOR, () => 'x')).not.toThrow()
  })

  it('카탈로그 밖 주문번호는 undefined로 해소한다', () => {
    const dispatch = new SpellDispatch<StubHandler>()
    expect(dispatch.resolve(999)).toBeUndefined()
  })

  it('카탈로그 밖 주문 등록을 거부한다(카탈로그 밖만 throw)', () => {
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

  it('서로 다른 핸들러 타입의 인스턴스를 독립 생성한다(제네릭 이질성 보존)', () => {
    // 이질 effect 핸들러 타입(S7 resistBuff, S8 debuff 등)이 각자 SpellDispatch<H>를 갖는다.
    type HealHandler = (hp: number) => number
    type BuffHandler = (until: number) => { until: number }

    const healDispatch = new SpellDispatch<HealHandler>()
    const buffDispatch = new SpellDispatch<BuffHandler>()

    const heal: HealHandler = (hp) => hp + 10
    const buff: BuffHandler = (until) => ({ until })
    healDispatch.register(SPELL_NO.SVIGOR, heal)
    buffDispatch.register(SPELL_NO.SBLESS, buff)

    const resolvedHeal = healDispatch.resolve(SPELL_NO.SVIGOR)
    const resolvedBuff = buffDispatch.resolve(SPELL_NO.SBLESS)
    // 각 인스턴스는 자기 타입의 핸들러만 담고 서로 격리된다.
    expect(resolvedHeal?.(5)).toBe(15)
    expect(resolvedBuff?.(300)).toEqual({ until: 300 })
    expect(buffDispatch.resolve(SPELL_NO.SVIGOR)).toBeUndefined()
  })
})
