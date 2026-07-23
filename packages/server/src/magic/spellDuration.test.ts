import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { approve, goldenFixtureSchema, SPELL_NO, type Character } from 'shared'
import {
  computeBuffDur,
  computeDebuffDur,
  grantBuff,
  isExpired,
  isBuffActive,
} from './spellDuration.js'

/**
 * spellDuration 단위 테스트 — G4 버프/디버프 dur 순수식 + 만료 판정(A6 §6·§7, magic2-8.c).
 *   버프(표준): MAX(300, 1200+B*600) + 클래스(+60*L4)/RPMEXT(+800|+600), 비-CAST 고정 1200.
 *   디버프(fear/silence/charm): 주문별 dur + PRMAGI 대상 → trunc(dur/2).
 *   만료: isExpired(until, tick) = tick > until (statusEffects isActive와 동일 절대-틱 관례).
 */

/** 최소 유효 Character — buffs 없음(optional). over로 필드 오버라이드. */
function makeCharacter(over: Partial<Character> = {}): Character {
  return {
    _id: 'c-1',
    name: '테스토스',
    class: 5,
    race: 1,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    hpCurrent: 20,
    mpCurrent: 20,
    level: 10,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 5,
    accountId: 'a-1',
    status: 'active',
    ...over,
  }
}

// ── computeBuffDur (A6 §6) ──────────────────────────────────────────────────
describe('computeBuffDur — 표준 버프 지속(A6 §6)', () => {
  it('기본 CAST: MAX(300, 1200+B*600), 클래스/RPMEXT 없음', () => {
    // protection, B=0 → MAX(300, 1200)=1200. 클래스 미해당(FIGHTER=4), rpmext=false.
    const dur = computeBuffDur(SPELL_NO.SPROTE, {
      intBonus: 0,
      level: 10,
      casterClass: 4,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(1200)
  })

  it('B>0: 1200+B*600', () => {
    // resist_fire, B=2 → 1200+1200=2400. resistBuff는 클래스 보너스 없음.
    const dur = computeBuffDur(SPELL_NO.SRFIRE, {
      intBonus: 2,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(2400)
  })

  it('음수 B: MAX(300) 하한이 발동한다', () => {
    // B=-2 → 1200-1200=0 → MAX(300,0)=300. 저지능 지속 하한.
    const dur = computeBuffDur(SPELL_NO.SRFIRE, {
      intBonus: -2,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(300)
  })

  it('CLERIC/PALADIN protection: +60*L4 (하한 뒤 가산)', () => {
    // protection CLERIC=3, level=10 → L4=trunc(13/4)=3, +60*3=180. base 1200 → 1380.
    const dur = computeBuffDur(SPELL_NO.SPROTE, {
      intBonus: 0,
      level: 10,
      casterClass: 3,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(1380)
  })

  it('MAGE detectinvis: +60*L4', () => {
    // detectinvis MAGE=5, level=10 → L4=3, +180. base 1200 → 1380.
    const dur = computeBuffDur(SPELL_NO.SDINVI, {
      intBonus: 0,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(1380)
  })

  it('비-MAGE detectinvis: 클래스 보너스 없음', () => {
    // detectinvis CLERIC=3 → 클래스 미해당(detect는 MAGE만). base 1200.
    const dur = computeBuffDur(SPELL_NO.SDINVI, {
      intBonus: 0,
      level: 10,
      casterClass: 3,
      gated: true,
      rpmext: false,
    })
    expect(dur).toBe(1200)
  })

  it('RPMEXT 800(표준) 가산', () => {
    // resist_fire rpmext=true → +800. 1200+800=2000.
    const dur = computeBuffDur(SPELL_NO.SRFIRE, {
      intBonus: 0,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: true,
    })
    expect(dur).toBe(2000)
  })

  it('RPMEXT 600(detect/fly) 가산', () => {
    // fly rpmext=true → +600. 1200+600=1800.
    const dur = computeBuffDur(SPELL_NO.SFLYSP, {
      intBonus: 0,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: true,
    })
    expect(dur).toBe(1800)
  })

  it('클래스 보너스 + RPMEXT 동시 가산', () => {
    // bless CLERIC=3, level=10, rpmext=true → 1200 + 180(L4=3) + 800 = 2180.
    const dur = computeBuffDur(SPELL_NO.SBLESS, {
      intBonus: 0,
      level: 10,
      casterClass: 3,
      gated: true,
      rpmext: true,
    })
    expect(dur).toBe(2180)
  })

  it('비-CAST(gated=false): 고정 1200(클래스/RPMEXT 무시)', () => {
    const dur = computeBuffDur(SPELL_NO.SPROTE, {
      intBonus: 5,
      level: 60,
      casterClass: 3,
      gated: false,
      rpmext: true,
    })
    expect(dur).toBe(1200)
  })

  it('표준 버프가 아닌 주문번호는 throw', () => {
    // invisibility(SINVIS)는 표준 공식이 아니다(MAX 없음, Story 9). 카탈로그 미등록 → throw.
    expect(() => computeBuffDur(SPELL_NO.SINVIS, {
      intBonus: 0,
      level: 10,
      casterClass: 5,
      gated: true,
      rpmext: false,
    })).toThrow()
  })
})

// ── computeDebuffDur (A6 §7) ────────────────────────────────────────────────
describe('computeDebuffDur — 디버프 지속(A6 §7)', () => {
  const roll = (v: number) => () => v

  it('fear: 600 + roll*10 + B*150', () => {
    // roll=5, B=2 → 600 + 50 + 300 = 950.
    expect(computeDebuffDur(SPELL_NO.SFEARS, { intBonus: 2, targetHasPrmagi: false }, roll(5))).toBe(950)
  })

  it('silence: 3600 고정(굴림 없음)', () => {
    expect(computeDebuffDur(SPELL_NO.SSILNC, { intBonus: 5, targetHasPrmagi: false }, roll(30))).toBe(3600)
  })

  it('charm: 300 + roll*10 + B*30', () => {
    // roll=10, B=1 → 300 + 100 + 30 = 430.
    expect(computeDebuffDur(SPELL_NO.SCHARM, { intBonus: 1, targetHasPrmagi: false }, roll(10))).toBe(430)
  })

  it('PRMAGI 대상: trunc(dur/2)', () => {
    // silence 3600 → PRMAGI → 1800. 결정적 anti-tautology 케이스.
    expect(computeDebuffDur(SPELL_NO.SSILNC, { intBonus: 0, targetHasPrmagi: true }, roll(1))).toBe(1800)
  })

  it('PRMAGI 홀수 dur: trunc(내림)', () => {
    // fear roll=1, B=0 → 610 → PRMAGI → trunc(305)=305.
    expect(computeDebuffDur(SPELL_NO.SFEARS, { intBonus: 0, targetHasPrmagi: true }, roll(1))).toBe(305)
  })

  it('befuddle(SBEFUD)는 이 함수 대상이 아니다(Story 8) → throw', () => {
    // befuddle은 dur=3/MAX(5) 저항 모델(비-/2)이라 Story 8 소관. 카탈로그 미등록 → throw.
    expect(() => computeDebuffDur(SPELL_NO.SBEFUD, { intBonus: 0, targetHasPrmagi: false }, roll(1))).toThrow()
  })

  it('blind(SBLIND)·drain_exp(SDREXP)도 이 함수 대상이 아니다(Story 8) → throw', () => {
    // blind는 타이머 부여 결정(OpenQ #3-b), drain_exp는 즉발(타이머 없음). 둘 다 미등록 → throw.
    expect(() => computeDebuffDur(SPELL_NO.SBLIND, { intBonus: 0, targetHasPrmagi: false }, roll(1))).toThrow()
    expect(() => computeDebuffDur(SPELL_NO.SDREXP, { intBonus: 0, targetHasPrmagi: false }, roll(1))).toThrow()
  })
})

// ── grant / isExpired (G4 buffs 필드 소비) ──────────────────────────────────
describe('grantBuff — buffs 필드 grant(immutable)', () => {
  it('until을 세팅한 새 Character를 반환한다', () => {
    const c = makeCharacter()
    const next = grantBuff(c, SPELL_NO.SPROTE, 5000)
    expect(next.buffs?.[String(SPELL_NO.SPROTE)]).toEqual({ until: 5000 })
  })

  it('입력 Character·buffs를 변형하지 않는다', () => {
    const c = makeCharacter({ buffs: { [String(SPELL_NO.SBLESS)]: { until: 100 } } })
    const next = grantBuff(c, SPELL_NO.SPROTE, 5000)
    // 원본 불변: 기존 bless만, 신규 protection 없음.
    expect(c.buffs).toEqual({ [String(SPELL_NO.SBLESS)]: { until: 100 } })
    // 신규 객체: 기존 bless 보존 + protection 추가.
    expect(next.buffs?.[String(SPELL_NO.SBLESS)]).toEqual({ until: 100 })
    expect(next.buffs?.[String(SPELL_NO.SPROTE)]).toEqual({ until: 5000 })
    expect(next).not.toBe(c)
  })

  it('같은 주문 재grant는 until을 덮어쓴다', () => {
    const c = makeCharacter({ buffs: { [String(SPELL_NO.SPROTE)]: { until: 100 } } })
    const next = grantBuff(c, SPELL_NO.SPROTE, 9000)
    expect(next.buffs?.[String(SPELL_NO.SPROTE)]).toEqual({ until: 9000 })
  })
})

describe('isExpired — 절대-틱 만료 판정(statusEffects isActive 관례)', () => {
  it('tick > until 이면 만료', () => {
    expect(isExpired(100, 101)).toBe(true)
  })

  it('tick == until 이면 아직 활성(만료 아님)', () => {
    // isActive는 until >= now = 활성. 경계 tick==until은 활성 → 만료 false.
    expect(isExpired(100, 100)).toBe(false)
  })

  it('tick < until 이면 활성(만료 아님)', () => {
    expect(isExpired(100, 50)).toBe(false)
  })
})

describe('isBuffActive — Character+spellNo 활성 래퍼', () => {
  it('buff 없으면 비활성', () => {
    expect(isBuffActive(makeCharacter(), SPELL_NO.SPROTE, 10)).toBe(false)
  })

  it('until >= tick 이면 활성', () => {
    const c = grantBuff(makeCharacter(), SPELL_NO.SPROTE, 100)
    expect(isBuffActive(c, SPELL_NO.SPROTE, 100)).toBe(true)
    expect(isBuffActive(c, SPELL_NO.SPROTE, 99)).toBe(true)
  })

  it('tick > until 이면 비활성(만료)', () => {
    const c = grantBuff(makeCharacter(), SPELL_NO.SPROTE, 100)
    expect(isBuffActive(c, SPELL_NO.SPROTE, 101)).toBe(false)
  })
})

// ── T5.4 골든 fixture 소비(approve) ─────────────────────────────────────────
describe('체크인된 buff_duration.json 골든 fixture', () => {
  const loadFixture = (name: string) => {
    const url = new URL(`../../../shared/src/oracle/fixtures/${name}`, import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(`${name} 스키마 실패`)
    return result.data as Parameters<typeof approve>[0]
  }

  interface BuffCaseInput {
    spellNo: number
    intBonus: number
    level: number
    casterClass: number
    gated: boolean
    rpmext: boolean
  }

  interface DebuffCaseInput {
    spellNo: number
    intBonus: number
    prmagi: boolean
    roll: number
  }

  it('buff_duration.json: approve가 computeBuffDur SUT로 전 케이스 통과', () => {
    const fixture = loadFixture('buff_duration.json')
    const sut = (input: unknown): unknown => {
      const i = input as BuffCaseInput
      return computeBuffDur(i.spellNo, {
        intBonus: i.intBonus,
        level: i.level,
        casterClass: i.casterClass,
        gated: i.gated,
        rpmext: i.rpmext,
      })
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })

  it('debuff_duration.json: approve가 computeDebuffDur SUT로 전 케이스 통과', () => {
    const fixture = loadFixture('debuff_duration.json')
    const sut = (input: unknown): unknown => {
      const i = input as DebuffCaseInput
      return computeDebuffDur(i.spellNo, { intBonus: i.intBonus, targetHasPrmagi: i.prmagi }, () => i.roll)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
