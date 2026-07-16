import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { goldenFixtureSchema } from '../oracle/types.js'
import type { GoldenFixture } from '../oracle/types.js'
import { approve } from '../oracle/runner.js'
import {
  bonus,
  bonusOf,
  StatIndex,
  class_stats,
  thaco_list,
  mod_profic,
  classStatOf,
  thacoOf,
  proficDivisorOf,
} from './tables.js'
import type { ClassStats, StatKey } from './tables.js'

// ---------------------------------------------------------------------------
// T1.1 — bonus 단일 물리 출처(tables.ts)
// ---------------------------------------------------------------------------
describe('bonus 상수 테이블 (tables.ts 이전)', () => {
  it('정확히 64개 원소를 가진다', () => {
    expect(bonus).toHaveLength(64)
  })

  it('앵커 인덱스 값이 원본 테이블과 일치한다', () => {
    expect(bonus[0]).toBe(-4)
    expect(bonus[10]).toBe(0)
    expect(bonus[20]).toBe(3)
    expect(bonus[63]).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// T1.2 — bonusOf clamp 접근자 + StatKey/StatIndex
// ---------------------------------------------------------------------------
describe('bonusOf — clamp 내장 접근자', () => {
  it('정상 범위 인덱스는 bonus[i]를 그대로 반환한다', () => {
    expect(bonusOf(0)).toBe(-4)
    expect(bonusOf(10)).toBe(0)
    expect(bonusOf(20)).toBe(3)
    expect(bonusOf(63)).toBe(7)
  })

  it('63 초과 입력을 63으로 clamp한다', () => {
    expect(bonusOf(64)).toBe(bonus[63])
    expect(bonusOf(1000)).toBe(7)
  })

  it('음수 입력을 0으로 clamp한다', () => {
    expect(bonusOf(-1)).toBe(bonus[0])
    expect(bonusOf(-1000)).toBe(-4)
  })
})

describe('StatKey/StatIndex — 5-tuple 고정 순서 (mstruct.h:177-181)', () => {
  it('인덱스 순서가 strength=0…piety=4다', () => {
    expect(StatIndex.strength).toBe(0)
    expect(StatIndex.dexterity).toBe(1)
    expect(StatIndex.constitution).toBe(2)
    expect(StatIndex.intelligence).toBe(3)
    expect(StatIndex.piety).toBe(4)
  })

  it('StatKey 리터럴 유니온이 5개 키를 포함한다', () => {
    const keys: StatKey[] = ['strength', 'dexterity', 'constitution', 'intelligence', 'piety']
    expect(new Set(keys).size).toBe(5)
    // 각 키가 StatIndex에 존재하는지 확인.
    for (const key of keys) {
      expect(typeof StatIndex[key]).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// T1.3 — class_stats / thaco_list / mod_profic 전사 + 접근자
// ---------------------------------------------------------------------------
describe('class_stats — global.c:37', () => {
  it('13개 행(placeholder 포함)을 가진다', () => {
    expect(class_stats).toHaveLength(13)
  })

  it('fighter(idx4) 행이 명세 필드값과 일치한다', () => {
    const fighter: ClassStats = {
      hpstart: 56,
      mpstart: 50,
      hp: 6,
      mp: 1,
      ndice: 1,
      sdice: 5,
      pdice: 0,
    }
    expect(class_stats[4]).toEqual(fighter)
  })

  it('classStatOf가 named 필드로 셀을 조회한다', () => {
    expect(classStatOf({ classIndex: 4, field: 'hpstart' })).toBe(56)
    expect(classStatOf({ classIndex: 5, field: 'mp' })).toBe(3)
    expect(classStatOf({ classIndex: 9, field: 'hpstart' })).toBe(400)
  })

  it('classStatOf가 범위 밖 classIndex에 RangeError를 던진다', () => {
    expect(() => classStatOf({ classIndex: 13, field: 'hp' })).toThrow(RangeError)
    expect(() => classStatOf({ classIndex: -1, field: 'hp' })).toThrow(RangeError)
  })
})

describe('thaco_list — global.c:105', () => {
  it('13개 행 × 각 20개 레벨을 가진다', () => {
    expect(thaco_list).toHaveLength(13)
    for (const row of thaco_list) {
      expect(row).toHaveLength(20)
    }
  })

  it('thacoOf가 [classIndex][levelIndex] 셀을 조회한다', () => {
    expect(thacoOf({ classIndex: 0, levelIndex: 0 })).toBe(20) // placeholder
    expect(thacoOf({ classIndex: 2, levelIndex: 0 })).toBe(20) // barbarian L1
    expect(thacoOf({ classIndex: 2, levelIndex: 19 })).toBe(2) // barbarian L20
    expect(thacoOf({ classIndex: 9, levelIndex: 5 })).toBe(1) // invincible
    expect(thacoOf({ classIndex: 12, levelIndex: 0 })).toBe(-5) // DM
  })

  it('thacoOf가 범위 밖 인덱스에 RangeError를 던진다', () => {
    expect(() => thacoOf({ classIndex: 99, levelIndex: 0 })).toThrow(RangeError)
    expect(() => thacoOf({ classIndex: 0, levelIndex: 20 })).toThrow(RangeError)
    expect(() => thacoOf({ classIndex: 0, levelIndex: -1 })).toThrow(RangeError)
  })
})

describe('mod_profic — player.c:1032', () => {
  it('13개 클래스 인덱스의 나눗수를 가진다', () => {
    expect(mod_profic).toHaveLength(13)
  })

  it('proficDivisorOf가 클래스별 나눗수를 반환한다', () => {
    expect(proficDivisorOf(4)).toBe(20) // fighter
    expect(proficDivisorOf(2)).toBe(20) // barbarian
    expect(proficDivisorOf(9)).toBe(20) // invincible
    expect(proficDivisorOf(10)).toBe(20) // caretaker
    expect(proficDivisorOf(7)).toBe(25) // ranger
    expect(proficDivisorOf(6)).toBe(25) // paladin
    expect(proficDivisorOf(8)).toBe(30) // thief
    expect(proficDivisorOf(1)).toBe(30) // assassin
    expect(proficDivisorOf(3)).toBe(30) // cleric
    expect(proficDivisorOf(5)).toBe(40) // mage (default)
    expect(proficDivisorOf(0)).toBe(40) // placeholder (default)
    expect(proficDivisorOf(11)).toBe(40) // sub_dm (default)
    expect(proficDivisorOf(12)).toBe(40) // DM (default)
  })

  it('범위 밖 인덱스는 default 40을 반환한다', () => {
    expect(proficDivisorOf(99)).toBe(40)
    expect(proficDivisorOf(-1)).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// 제약 2 — class_stats 교차검증 (A7 §2 폐형 HP/MP 재현)
// HP/MP resolver 자체는 Story 5 소관. 여기선 class_stats 값 검증용 인라인 계산.
// ---------------------------------------------------------------------------
describe('class_stats 교차검증 — A7 §2 폐형 HP/MP', () => {
  const hpmax = (hpstart: number, hp: number, level: number): number =>
    hpstart + Math.trunc((hp * (level - 1)) / 2)
  const mpmax = (mpstart: number, mp: number, level: number): number =>
    mpstart + Math.trunc((mp * (level - 1)) / 2)

  it('fighter(idx4) HP: L10=83, L50=203', () => {
    const s = class_stats[4]
    expect(s).toBeDefined()
    if (s) {
      expect(hpmax(s.hpstart, s.hp, 10)).toBe(83)
      expect(hpmax(s.hpstart, s.hp, 50)).toBe(203)
    }
  })

  it('fighter(idx4) MP: L50=74', () => {
    const s = class_stats[4]
    expect(s).toBeDefined()
    if (s) {
      expect(mpmax(s.mpstart, s.mp, 50)).toBe(74)
    }
  })

  it('mage(idx5) MP: L50=123', () => {
    const s = class_stats[5]
    expect(s).toBeDefined()
    if (s) {
      expect(mpmax(s.mpstart, s.mp, 50)).toBe(123)
    }
  })
})

// ---------------------------------------------------------------------------
// T1.4 — 골든 전사-diff fixture 대조 (approve)
// SUT(접근자)는 tables.ts를 읽고, fixture expected는 C oracle 리터럴이다.
// ---------------------------------------------------------------------------
function loadFixture<I, O>(name: string): GoldenFixture<I, O> {
  const url = new URL(`../oracle/fixtures/${name}.json`, import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
  return goldenFixtureSchema.parse(parsed) as GoldenFixture<I, O>
}

describe('골든 전사-diff — class_stats', () => {
  type Input = { classIndex: number; field: keyof ClassStats }
  it('approve(class_stats fixture, classStatOf)가 전 셀을 통과한다', () => {
    const fixture = loadFixture<Input, number>('class_stats')
    expect(fixture.cases.length).toBe(91) // 13행 × 7필드
    expect(() => approve(fixture, classStatOf)).not.toThrow()
  })

  it('negative control: 셀에 +1 오프셋을 주입한 SUT에는 approve가 throw한다', () => {
    const fixture = loadFixture<Input, number>('class_stats')
    const buggy = (input: Input): number => classStatOf(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('골든 전사-diff — thaco_list', () => {
  type Input = { classIndex: number; levelIndex: number }
  it('approve(thaco_list fixture, thacoOf)가 전 셀을 통과한다', () => {
    const fixture = loadFixture<Input, number>('thaco_list')
    expect(fixture.cases.length).toBe(260) // 13행 × 20레벨
    expect(() => approve(fixture, thacoOf)).not.toThrow()
  })

  it('negative control: 셀에 +1 오프셋을 주입한 SUT에는 approve가 throw한다', () => {
    const fixture = loadFixture<Input, number>('thaco_list')
    const buggy = (input: Input): number => thacoOf(input) + 1
    expect(() => approve(fixture, buggy)).toThrow()
  })
})

describe('골든 전사-diff — mod_profic', () => {
  it('approve(mod_profic fixture, proficDivisorOf)가 전 클래스를 통과한다', () => {
    const fixture = loadFixture<number, number>('mod_profic')
    expect(fixture.cases.length).toBe(13) // 클래스 0-12
    expect(() => approve(fixture, proficDivisorOf)).not.toThrow()
  })

  it('negative control: 나눗수에 +5를 주입한 SUT에는 approve가 throw한다', () => {
    const fixture = loadFixture<number, number>('mod_profic')
    const buggy = (input: number): number => proficDivisorOf(input) + 5
    expect(() => approve(fixture, buggy)).toThrow()
  })
})
