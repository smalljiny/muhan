import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { approve, goldenFixtureSchema } from 'shared'
import {
  ASSASSIN,
  BARBARIAN,
  CLERIC,
  FIGHTER,
  MAGE,
  PALADIN,
  RANGER,
  THIEF,
  INVINCIBLE,
  CARETAKER,
} from '../combat/constants.js'
import { spellFail, spellFailChance, rollsSpellFail } from './spellFail.js'

/**
 * spell_fail 굴림·호출조건·chance 공식 테스트(magic8.c:791-897).
 *
 * 두 개념을 분리 검증한다:
 *   - spellFail/spellFailChance = 8클래스 chance 테이블(MAGE·CLERIC 포함) + 무cap 굴림.
 *   - rollsSpellFail = 호출 조건 predicate(전사계 6클래스 한정, MAGE·CLERIC 제외).
 * MAGE/CLERIC이 chance 테이블에는 있지만 predicate에서 빠지는 것이 A6 §3의 핵심 구분이다.
 */

// 결정적 rng — 굴림 n을 강제한다(fixture·경계 테스트가 특정 n을 주입).
const fixedRng = (n: number) => () => n

describe('spellFailChance — 8클래스 chance 공식(magic8.c)', () => {
  // level=5, intBonus=2 → base = trunc((5+3)/4)+2 = 2+2 = 4. 각 클래스 add항만 다르다.
  const base4 = { level: 5, intBonus: 2 } // base=4

  it('ASSASSIN = (L4+B)*5+30', () => {
    expect(spellFailChance(ASSASSIN, base4.level, base4.intBonus)).toBe(4 * 5 + 30) // 50
  })
  it('BARBARIAN = (L4+B)*5+0', () => {
    expect(spellFailChance(BARBARIAN, base4.level, base4.intBonus)).toBe(4 * 5 + 0) // 20
  })
  it('CLERIC = (L4+B)*5+65', () => {
    expect(spellFailChance(CLERIC, base4.level, base4.intBonus)).toBe(4 * 5 + 65) // 85
  })
  it('FIGHTER = (L4+B)*5+10', () => {
    expect(spellFailChance(FIGHTER, base4.level, base4.intBonus)).toBe(4 * 5 + 10) // 30
  })
  it('MAGE = (L4+B)*5+75', () => {
    expect(spellFailChance(MAGE, base4.level, base4.intBonus)).toBe(4 * 5 + 75) // 95
  })
  it('PALADIN = (L4+B)*5+50', () => {
    expect(spellFailChance(PALADIN, base4.level, base4.intBonus)).toBe(4 * 5 + 50) // 70
  })
  it('RANGER = (L4+B)*4+56 (유일한 *4)', () => {
    expect(spellFailChance(RANGER, base4.level, base4.intBonus)).toBe(4 * 4 + 56) // 72
  })
  it('THIEF = (L4+B)*6+22 (유일한 *6)', () => {
    expect(spellFailChance(THIEF, base4.level, base4.intBonus)).toBe(4 * 6 + 22) // 46
  })

  it('default 클래스(0/9/11/12)는 null을 반환한다(굴림 없이 무조건 성공 경로)', () => {
    expect(spellFailChance(0, 5, 2)).toBeNull()
    expect(spellFailChance(INVINCIBLE, 5, 2)).toBeNull()
    expect(spellFailChance(11, 5, 2)).toBeNull()
    expect(spellFailChance(12, 5, 2)).toBeNull()
  })

  it('L4는 C 정수 나눗셈 = Math.trunc((level+3)/4)', () => {
    // level=1 → trunc(4/4)=1, level=2 → trunc(5/4)=1, level=6 → trunc(9/4)=2.
    expect(spellFailChance(BARBARIAN, 1, 0)).toBe(1 * 5 + 0) // 5
    expect(spellFailChance(BARBARIAN, 2, 0)).toBe(1 * 5 + 0) // 5 (trunc)
    expect(spellFailChance(BARBARIAN, 6, 0)).toBe(2 * 5 + 0) // 10
  })
})

describe('spellFail — 굴림(true=실패)', () => {
  it('저레벨 전사는 실패한다(BARBARIAN L1 int0 → chance=5, n=50 > 5 → 실패)', () => {
    expect(spellFail(BARBARIAN, 1, 0, fixedRng(50))).toBe(true)
  })

  it('무cap: 고레벨·고지능 chance>100이면 어떤 n(1~100)에서도 실패하지 않는다', () => {
    // MAGE L100 int5 → base = trunc(103/4)+5 = 25+5 = 30, chance = 30*5+75 = 225. cap 없음.
    expect(spellFail(MAGE, 100, 5, fixedRng(1))).toBe(false)
    expect(spellFail(MAGE, 100, 5, fixedRng(50))).toBe(false)
    expect(spellFail(MAGE, 100, 5, fixedRng(100))).toBe(false)
  })

  it('default 클래스는 굴림 없이 무조건 성공한다(magic8.c default: return 0)', () => {
    // n=100(실패할 법한 굴림)이어도 default는 굴리지 않으므로 성공(false).
    expect(spellFail(INVINCIBLE, 50, 3, fixedRng(100))).toBe(false)
    expect(spellFail(CARETAKER, 50, 3, fixedRng(100))).toBe(false)
    expect(spellFail(0, 1, 0, fixedRng(100))).toBe(false)
  })

  it('경계: n==chance는 성공, n==chance+1은 실패(n>chance만 실패)', () => {
    // BARBARIAN L1 int0 → chance=5.
    expect(spellFail(BARBARIAN, 1, 0, fixedRng(5))).toBe(false) // 5>5 거짓 → 성공
    expect(spellFail(BARBARIAN, 1, 0, fixedRng(6))).toBe(true) // 6>5 참 → 실패
  })
})

describe('rollsSpellFail — 호출 조건 predicate(전사계 6클래스 한정, A6 §3)', () => {
  it('전사계 6클래스는 spell_fail을 굴린다', () => {
    for (const cls of [FIGHTER, BARBARIAN, RANGER, PALADIN, ASSASSIN, THIEF]) {
      expect(rollsSpellFail(cls)).toBe(true)
    }
  })

  it('정규 캐스터(MAGE·CLERIC)는 chance 테이블엔 있어도 spell_fail을 굴리지 않는다', () => {
    expect(rollsSpellFail(MAGE)).toBe(false)
    expect(rollsSpellFail(CLERIC)).toBe(false)
  })

  it('그 외 클래스(INVINCIBLE·CARETAKER·0)는 굴리지 않는다', () => {
    expect(rollsSpellFail(INVINCIBLE)).toBe(false)
    expect(rollsSpellFail(CARETAKER)).toBe(false)
    expect(rollsSpellFail(0)).toBe(false)
  })
})

describe('체크인된 spell_fail.json 골든 fixture', () => {
  // 크로스 패키지 읽기: fixture는 shared 소유, SUT spellFail은 server 소유(shared는 server를
  // import 못 함). readFileSync로 디스크 데이터를 읽어 approve의 SUT만 server에서 소비한다.
  const loadFixture = () => {
    const url = new URL('../../../shared/src/oracle/fixtures/spell_fail.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    const result = goldenFixtureSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('spell_fail.json 스키마 실패')
    return result.data as Parameters<typeof approve>[0]
  }

  it('goldenFixtureSchema를 통과하고 manual oracle이다', () => {
    const fixture = loadFixture()
    expect(fixture.oracle.method).toBe('manual')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it('approve가 spellFail SUT로 전 케이스를 throw 없이 통과한다(무cap·클래스별 chance)', () => {
    // anti-tautology: fixture expected는 spellFailFixture.ts의 magic8.c 독립 전사,
    // SUT spellFail은 spellFail.ts 구현. 두 전사가 diff되면 approve가 throw한다.
    const fixture = loadFixture()
    const sut = (input: unknown): unknown => {
      const c = input as { class: number; level: number; intBonus: number; n: number }
      return spellFail(c.class, c.level, c.intBonus, () => c.n)
    }
    expect(() => approve(fixture, sut)).not.toThrow()
  })
})
