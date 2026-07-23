import { describe, it, expect } from 'vitest'
import { SPELL_NO } from './catalog.js'
import { BUFF_DUR_META, DEBUFF_DUR_META, NON_CAST_BUFF_DUR } from './buffCatalog.js'

/**
 * buffCatalog 데이터 테이블 검증 — A6 §6·§7 dur 메타(magic2-8.c) 전사 정합.
 * 산술은 server computeBuffDur/computeDebuffDur가 fixture로 approve하므로, 여기선 테이블 셰이프·경계만.
 */

describe('BUFF_DUR_META — A6 §6 표준 버프 11종', () => {
  it('정확히 11개 표준 버프만 담는다', () => {
    expect(BUFF_DUR_META.size).toBe(11)
  })

  it('invis/levit/light는 미등록(표준 공식 아님 — Story 9)', () => {
    expect(BUFF_DUR_META.has(SPELL_NO.SINVIS)).toBe(false)
    expect(BUFF_DUR_META.has(SPELL_NO.SLEVIT)).toBe(false)
    expect(BUFF_DUR_META.has(SPELL_NO.SLIGHT)).toBe(false)
  })

  it('protection/bless: CLERIC(3)/PALADIN(6) 클래스 보너스 + RPMEXT 800', () => {
    for (const no of [SPELL_NO.SPROTE, SPELL_NO.SBLESS]) {
      const meta = BUFF_DUR_META.get(no)
      expect(meta?.classBonusClasses).toEqual([3, 6])
      expect(meta?.rpmext).toBe(800)
    }
  })

  it('detectinvis/detectmagic: MAGE(5) 클래스 보너스 + RPMEXT 600', () => {
    for (const no of [SPELL_NO.SDINVI, SPELL_NO.SDMAGI]) {
      const meta = BUFF_DUR_META.get(no)
      expect(meta?.classBonusClasses).toEqual([5])
      expect(meta?.rpmext).toBe(600)
    }
  })

  it('fly: 클래스 보너스 없음 + RPMEXT 600', () => {
    const meta = BUFF_DUR_META.get(SPELL_NO.SFLYSP)
    expect(meta?.classBonusClasses).toEqual([])
    expect(meta?.rpmext).toBe(600)
  })

  it('resist/breathe_water/earth_shield/know_alignment: 클래스 보너스 없음 + RPMEXT 800', () => {
    for (const no of [SPELL_NO.SRFIRE, SPELL_NO.SRCOLD, SPELL_NO.SRMAGI, SPELL_NO.SBRWAT, SPELL_NO.SSSHLD, SPELL_NO.SKNOWA]) {
      const meta = BUFF_DUR_META.get(no)
      expect(meta?.classBonusClasses).toEqual([])
      expect(meta?.rpmext).toBe(800)
    }
  })

  it('비-CAST 고정 지속은 1200', () => {
    expect(NON_CAST_BUFF_DUR).toBe(1200)
  })
})

describe('DEBUFF_DUR_META — A6 §7 PRMAGI→dur/2 모델 3종', () => {
  it('fear/silence/charm 3종만 담는다(befuddle 제외 — Story 8)', () => {
    expect(DEBUFF_DUR_META.size).toBe(3)
    expect(DEBUFF_DUR_META.has(SPELL_NO.SBEFUD)).toBe(false)
  })

  it('fear: 600 + mrand(1,30)*10 + B*150', () => {
    expect(DEBUFF_DUR_META.get(SPELL_NO.SFEARS)).toEqual({ constant: 600, rollDie: 30, rollMult: 10, intMult: 150 })
  })

  it('silence: 3600 고정(굴림·int 없음)', () => {
    expect(DEBUFF_DUR_META.get(SPELL_NO.SSILNC)).toEqual({ constant: 3600, rollDie: 0, rollMult: 0, intMult: 0 })
  })

  it('charm: 300 + mrand(1,30)*10 + B*30', () => {
    expect(DEBUFF_DUR_META.get(SPELL_NO.SCHARM)).toEqual({ constant: 300, rollDie: 30, rollMult: 10, intMult: 30 })
  })
})
