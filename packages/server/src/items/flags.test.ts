import { describe, it, expect } from 'vitest'
import { F_SET, OCURSE } from '../world/hexFlags.js'
import { MAGE, CLERIC, INVINCIBLE } from '../combat/constants.js'
import {
  // 플래그 비트 상수
  ONOMAG,
  OGOODO,
  OEVILO,
  OENCHA,
  OSIZE1,
  OSIZE2,
  ORENCH,
  OWEARS,
  ONOMAL,
  ONOFEM,
  OCLSEL,
  OMARRI,
  OEVENT,
  OWHELD,
  ONEWEV,
  // 종족 상수
  DWARF,
  ELF,
  HALFELF,
  HOBBIT,
  HUMAN,
  ORC,
  HALFGIANT,
  GNOME,
  // 성별 상수
  MALE,
  FEMALE,
  // predicate
  genderAllowed,
  alignmentAllowed,
  classAllowed,
  oclselBlocks,
  sizeAllowed,
  isCursed,
  isPersonalBound,
  isMarriageGated,
  needsRandEnchant,
} from './flags.js'

/**
 * object 플래그 게이트 predicate 검증 — 오라클 mtype.h 비트 값·command3.c 게이트 로직 이식.
 * flags는 8바이트 hex string, F_SET으로 테스트 입력을 구성한다(빈 문자열 '' 시작).
 */

const EMPTY = ''

describe('플래그 비트 상수 — mtype.h 검증 값', () => {
  it('오라클 mtype.h 비트 인덱스와 일치한다', () => {
    expect(ONOMAG).toBe(10)
    expect(OGOODO).toBe(12)
    expect(OEVILO).toBe(13)
    expect(OENCHA).toBe(14)
    expect(OSIZE1).toBe(19)
    expect(OSIZE2).toBe(20)
    expect(ORENCH).toBe(21)
    expect(OWEARS).toBe(23)
    expect(ONOMAL).toBe(26)
    expect(ONOFEM).toBe(27)
    expect(OCLSEL).toBe(31)
    expect(OMARRI).toBe(45)
    expect(OEVENT).toBe(46)
    expect(OWHELD).toBe(49)
    expect(ONEWEV).toBe(50)
  })
})

describe('종족·성별 상수', () => {
  it('RACE 상수가 mtype.h 값과 일치한다', () => {
    expect(DWARF).toBe(1)
    expect(ELF).toBe(2)
    expect(HALFELF).toBe(3)
    expect(HOBBIT).toBe(4)
    expect(HUMAN).toBe(5)
    expect(ORC).toBe(6)
    expect(HALFGIANT).toBe(7)
    expect(GNOME).toBe(8)
  })

  it('성별 인코딩 MALE=1·FEMALE=2', () => {
    expect(MALE).toBe(1)
    expect(FEMALE).toBe(2)
  })
})

describe('genderAllowed — ONOFEM=여성 거부·ONOMAL=남성 거부(명명 역전)', () => {
  it('ONOFEM 세트면 여성 거부', () => {
    const flags = F_SET(EMPTY, ONOFEM)
    expect(genderAllowed(flags, FEMALE)).toBe(false)
  })
  it('ONOFEM 세트여도 남성 허용', () => {
    const flags = F_SET(EMPTY, ONOFEM)
    expect(genderAllowed(flags, MALE)).toBe(true)
  })
  it('ONOMAL 세트면 남성 거부', () => {
    const flags = F_SET(EMPTY, ONOMAL)
    expect(genderAllowed(flags, MALE)).toBe(false)
  })
  it('ONOMAL 세트여도 여성 허용', () => {
    const flags = F_SET(EMPTY, ONOMAL)
    expect(genderAllowed(flags, FEMALE)).toBe(true)
  })
  it('플래그 없으면 모두 허용', () => {
    expect(genderAllowed(EMPTY, MALE)).toBe(true)
    expect(genderAllowed(EMPTY, FEMALE)).toBe(true)
  })
})

describe('alignmentAllowed — OGOODO/OEVILO 정렬 경계', () => {
  it('OGOODO 세트: alignment=-50 통과, -51 거부', () => {
    const flags = F_SET(EMPTY, OGOODO)
    expect(alignmentAllowed(flags, -50)).toBe(true)
    expect(alignmentAllowed(flags, -51)).toBe(false)
  })
  it('OEVILO 세트: alignment=50 통과, 51 거부', () => {
    const flags = F_SET(EMPTY, OEVILO)
    expect(alignmentAllowed(flags, 50)).toBe(true)
    expect(alignmentAllowed(flags, 51)).toBe(false)
  })
  it('플래그 없으면 극단 정렬도 허용', () => {
    expect(alignmentAllowed(EMPTY, -1000)).toBe(true)
    expect(alignmentAllowed(EMPTY, 1000)).toBe(true)
  })
})

describe('classAllowed — ONOMAG·OCLSEL 게이트', () => {
  it('ONOMAG 세트면 MAGE·CLERIC 거부', () => {
    const flags = F_SET(EMPTY, ONOMAG)
    expect(classAllowed(flags, MAGE)).toBe(false)
    expect(classAllowed(flags, CLERIC)).toBe(false)
  })
  it('ONOMAG 세트여도 비마법 클래스 허용', () => {
    const flags = F_SET(EMPTY, ONOMAG)
    expect(classAllowed(flags, 4)).toBe(true) // FIGHTER
  })
  it('OCLSEL 세트: (OCLSEL+class) 비트 없으면 거부', () => {
    const flags = F_SET(EMPTY, OCLSEL)
    expect(classAllowed(flags, MAGE)).toBe(false)
  })
  it('OCLSEL 세트: (OCLSEL+class) 비트 있으면 허용', () => {
    let flags = F_SET(EMPTY, OCLSEL)
    flags = F_SET(flags, OCLSEL + MAGE)
    expect(classAllowed(flags, MAGE)).toBe(true)
  })
  it('OCLSEL 세트여도 INVINCIBLE 이상은 우회 허용', () => {
    const flags = F_SET(EMPTY, OCLSEL)
    expect(classAllowed(flags, INVINCIBLE)).toBe(true)
  })
  it('플래그 없으면 모든 클래스 허용', () => {
    expect(classAllowed(EMPTY, MAGE)).toBe(true)
    expect(classAllowed(EMPTY, CLERIC)).toBe(true)
  })
})

describe('oclselBlocks — OCLSEL 직업선택 게이트 단독 판정', () => {
  it('OCLSEL 세트 + (OCLSEL+class) 비트 없으면 거부(true)', () => {
    const flags = F_SET(EMPTY, OCLSEL)
    expect(oclselBlocks(flags, MAGE)).toBe(true)
  })
  it('OCLSEL 세트 + (OCLSEL+class) 비트 있으면 허용(false)', () => {
    let flags = F_SET(EMPTY, OCLSEL)
    flags = F_SET(flags, OCLSEL + MAGE)
    expect(oclselBlocks(flags, MAGE)).toBe(false)
  })
  it('OCLSEL 세트여도 INVINCIBLE 이상은 우회(false)', () => {
    const flags = F_SET(EMPTY, OCLSEL)
    expect(oclselBlocks(flags, INVINCIBLE)).toBe(false)
  })
  it('OCLSEL 미세트면 거부하지 않음(false) — ONOMAG 융합 없음', () => {
    expect(oclselBlocks(F_SET(EMPTY, ONOMAG), MAGE)).toBe(false)
    expect(oclselBlocks(EMPTY, MAGE)).toBe(false)
  })
})

describe('sizeAllowed — OSIZE1/OSIZE2 조합(0~3)별 종족 게이트', () => {
  it('i=0(무제한): 모든 종족 허용', () => {
    expect(sizeAllowed(EMPTY, HUMAN)).toBe(true)
    expect(sizeAllowed(EMPTY, HALFGIANT)).toBe(true)
    expect(sizeAllowed(EMPTY, GNOME)).toBe(true)
  })
  it('i=1(소형, OSIZE2만): GNOME·HOBBIT·DWARF 허용, 그 외 거부', () => {
    const flags = F_SET(EMPTY, OSIZE2)
    expect(sizeAllowed(flags, GNOME)).toBe(true)
    expect(sizeAllowed(flags, HOBBIT)).toBe(true)
    expect(sizeAllowed(flags, DWARF)).toBe(true)
    expect(sizeAllowed(flags, HUMAN)).toBe(false)
    expect(sizeAllowed(flags, HALFGIANT)).toBe(false)
  })
  it('i=2(중형, OSIZE1만): HUMAN·ELF·HALFELF·ORC 허용, 그 외 거부', () => {
    const flags = F_SET(EMPTY, OSIZE1)
    expect(sizeAllowed(flags, HUMAN)).toBe(true)
    expect(sizeAllowed(flags, ELF)).toBe(true)
    expect(sizeAllowed(flags, HALFELF)).toBe(true)
    expect(sizeAllowed(flags, ORC)).toBe(true)
    expect(sizeAllowed(flags, DWARF)).toBe(false)
    expect(sizeAllowed(flags, HALFGIANT)).toBe(false)
  })
  it('i=3(대형, OSIZE1+OSIZE2): HALFGIANT만 허용', () => {
    let flags = F_SET(EMPTY, OSIZE1)
    flags = F_SET(flags, OSIZE2)
    expect(sizeAllowed(flags, HALFGIANT)).toBe(true)
    expect(sizeAllowed(flags, HUMAN)).toBe(false)
    expect(sizeAllowed(flags, GNOME)).toBe(false)
  })
})

describe('단순 플래그 substrate predicate', () => {
  it('isCursed = F_ISSET(OCURSE)', () => {
    expect(isCursed(F_SET(EMPTY, OCURSE))).toBe(true)
    expect(isCursed(EMPTY)).toBe(false)
  })
  it('isPersonalBound = F_ISSET(ONEWEV)', () => {
    expect(isPersonalBound(F_SET(EMPTY, ONEWEV))).toBe(true)
    expect(isPersonalBound(EMPTY)).toBe(false)
  })
  it('isMarriageGated = F_ISSET(OMARRI)', () => {
    expect(isMarriageGated(F_SET(EMPTY, OMARRI))).toBe(true)
    expect(isMarriageGated(EMPTY)).toBe(false)
  })
  it('needsRandEnchant = F_ISSET(ORENCH)', () => {
    expect(needsRandEnchant(F_SET(EMPTY, ORENCH))).toBe(true)
    expect(needsRandEnchant(EMPTY)).toBe(false)
  })
})

describe('입력 불변 — predicate는 flags를 변형하지 않는다', () => {
  it('genderAllowed 호출 후 입력 hex 불변', () => {
    const flags = F_SET(EMPTY, ONOFEM)
    const snapshot = flags
    genderAllowed(flags, FEMALE)
    expect(flags).toBe(snapshot)
  })
})
