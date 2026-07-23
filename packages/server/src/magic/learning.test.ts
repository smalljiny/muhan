import { describe, it, expect } from 'vitest'
import { emptySpellStore, isKnown, setKnown } from 'shared'
import {
  canTeachSpllv,
  study,
  teach,
  type SpellBook,
  type StudyChar,
  type TeachCaster,
} from './learning.js'
import { F_SET, PBLIND, PSILNC, OGOODO, OEVILO, OCLSEL } from '../world/hexFlags.js'
import { SCROLL, ARMOR } from '../items/taxonomy.js'
import { CLERIC, MAGE, FIGHTER, INVINCIBLE, CARETAKER, SUB_DM } from '../combat/constants.js'

// spellNo(카탈로그 spllv): SVIGOR=0(spllv1)·SBLESS=4(spllv2)·SRECAL=16(spllv3)·STELEP=11(spllv4)·SBLIND=53(spllv5)
const SVIGOR = 0
const SBLESS = 4
const SRECAL = 16
const STELEP = 11
const SBLIND = 53

/** 정상 통과하는 study 기본 char(MAGE·레벨10·중립·미학습·플래그 없음). */
function baseChar(overrides: Partial<StudyChar> = {}): StudyChar {
  return { level: 10, class: MAGE, alignment: 0, spells: emptySpellStore(), flags: '', ...overrides }
}

/** 정상 통과하는 비법서(SCROLL·ndice5·magicpower5=SBLESS·플래그 없음). */
function baseBook(overrides: Partial<SpellBook> = {}): SpellBook {
  return { type: SCROLL, ndice: 5, magicpower: SBLESS + 1, flags: '', ...overrides }
}

/** 정상 통과하는 teach 시전자(MAGE·SBLESS 보유·플래그 없음). */
function baseCaster(overrides: Partial<TeachCaster> = {}): TeachCaster {
  return { class: MAGE, spells: setKnown(emptySpellStore(), SBLESS), flags: '', ...overrides }
}

describe('canTeachSpllv — spllv 전수등급(T3.1)', () => {
  it('spllv1은 CLERIC 또는 INVINCIBLE↑만 허용한다', () => {
    expect(canTeachSpllv(CLERIC, 1)).toBe(true)
    expect(canTeachSpllv(MAGE, 1)).toBe(false)
    expect(canTeachSpllv(INVINCIBLE, 1)).toBe(true)
  })

  it('spllv2는 MAGE 또는 INVINCIBLE↑만 허용한다', () => {
    expect(canTeachSpllv(MAGE, 2)).toBe(true)
    expect(canTeachSpllv(CLERIC, 2)).toBe(false)
  })

  it('spllv3은 INVINCIBLE↑만, spllv4는 CARETAKER↑만, spllv5는 SUB_DM↑만 허용한다', () => {
    expect(canTeachSpllv(INVINCIBLE, 3)).toBe(true)
    expect(canTeachSpllv(MAGE, 3)).toBe(false)
    expect(canTeachSpllv(CARETAKER, 4)).toBe(true)
    expect(canTeachSpllv(INVINCIBLE, 4)).toBe(false)
    expect(canTeachSpllv(SUB_DM, 5)).toBe(true)
    expect(canTeachSpllv(CARETAKER, 5)).toBe(false)
  })
})

describe('study — 비법서 연마(T3.2)', () => {
  it('게이트 전부 통과 시 magicpower-1 비트를 set한 새 store를 반환한다', () => {
    const char = baseChar()
    const result = study(char, baseBook())
    expect(result.ok).toBe(true)
    expect(result.failure).toBeNull()
    expect(isKnown(result.spells, SBLESS)).toBe(true)
  })

  it('입력 char.spells를 변형하지 않는다(immutability)', () => {
    const spells = emptySpellStore()
    const char = baseChar({ spells })
    const result = study(char, baseBook())
    // 원본 store에는 비트가 서지 않았다(참조 독립 새 store 반환).
    expect(isKnown(spells, SBLESS)).toBe(false)
    expect(result.spells).not.toBe(spells)
  })

  it('PBLIND면 blind 실패, store 불변', () => {
    const char = baseChar({ flags: F_SET('', PBLIND) })
    const result = study(char, baseBook())
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('blind')
    expect(isKnown(result.spells, SBLESS)).toBe(false)
  })

  it('SCROLL이 아니면 not-a-book 실패, store 불변', () => {
    const result = study(baseChar(), baseBook({ type: ARMOR }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('not-a-book')
    expect(isKnown(result.spells, SBLESS)).toBe(false)
  })

  it('ndice > level이면 level 실패, store 불변', () => {
    const result = study(baseChar({ level: 4 }), baseBook({ ndice: 20 }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('level')
    expect(isKnown(result.spells, SBLESS)).toBe(false)
  })

  it('ndice == level은 통과한다(엄격 > 경계)', () => {
    const result = study(baseChar({ level: 5 }), baseBook({ ndice: 5 }))
    expect(result.ok).toBe(true)
  })

  it('OGOODO 비법서 + alignment<-100이면 alignment 실패', () => {
    const char = baseChar({ alignment: -200 })
    const result = study(char, baseBook({ flags: F_SET('', OGOODO) }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('alignment')
    expect(isKnown(result.spells, SBLESS)).toBe(false)
  })

  it('OEVILO 비법서 + alignment>100이면 alignment 실패', () => {
    const char = baseChar({ alignment: 200 })
    const result = study(char, baseBook({ flags: F_SET('', OEVILO) }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('alignment')
  })

  it('OGOODO 비법서라도 alignment>=-100이면 통과한다', () => {
    const char = baseChar({ alignment: 0 })
    const result = study(char, baseBook({ flags: F_SET('', OGOODO) }))
    expect(result.ok).toBe(true)
  })

  it('OCLSEL 비법서 + 직업 비트 없음 + class<CARETAKER면 class 실패', () => {
    const char = baseChar({ class: FIGHTER })
    const result = study(char, baseBook({ flags: F_SET('', OCLSEL) }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('class')
  })

  it('OCLSEL 비법서라도 OCLSEL+class 비트가 켜져 있으면 통과한다', () => {
    const char = baseChar({ class: FIGHTER })
    const flags = F_SET(F_SET('', OCLSEL), OCLSEL + FIGHTER)
    const result = study(char, baseBook({ flags }))
    expect(result.ok).toBe(true)
  })

  it('OCLSEL 비법서라도 CARETAKER↑는 클래스 게이트를 우회한다', () => {
    const char = baseChar({ class: CARETAKER })
    const result = study(char, baseBook({ flags: F_SET('', OCLSEL) }))
    expect(result.ok).toBe(true)
  })

  it('magicpower<1이면 no-spell 실패(음수 인덱스 write 차단)', () => {
    const result = study(baseChar(), baseBook({ magicpower: 0 }))
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('no-spell')
  })
})

describe('teach — 주문 전수(T3.3)', () => {
  it('base-class·spllv·지식 통과 시 target store에 spellNo 비트를 set한다', () => {
    const target = { spells: emptySpellStore() }
    const result = teach(baseCaster(), target, SBLESS)
    expect(result.ok).toBe(true)
    expect(result.failure).toBeNull()
    expect(isKnown(result.spells, SBLESS)).toBe(true)
  })

  it('입력 target.spells를 변형하지 않는다(immutability)', () => {
    const spells = emptySpellStore()
    const result = teach(baseCaster(), { spells }, SBLESS)
    expect(isKnown(spells, SBLESS)).toBe(false)
    expect(result.spells).not.toBe(spells)
  })

  it('PBLIND 시전자는 blind 실패', () => {
    const caster = baseCaster({ flags: F_SET('', PBLIND) })
    const result = teach(caster, { spells: emptySpellStore() }, SBLESS)
    expect(result.failure).toBe('blind')
    expect(isKnown(result.spells, SBLESS)).toBe(false)
  })

  it('PSILNC 시전자는 silence 실패', () => {
    const caster = baseCaster({ flags: F_SET('', PSILNC) })
    const result = teach(caster, { spells: emptySpellStore() }, SBLESS)
    expect(result.failure).toBe('silence')
  })

  it('base-class(CARETAKER/MAGE/CLERIC) 아니면 class 실패', () => {
    const caster = baseCaster({ class: FIGHTER, spells: setKnown(emptySpellStore(), SBLESS) })
    const result = teach(caster, { spells: emptySpellStore() }, SBLESS)
    expect(result.failure).toBe('class')
  })

  it('카탈로그에 없는 주문번호는 unknown-spell 실패', () => {
    const result = teach(baseCaster(), { spells: emptySpellStore() }, 999)
    expect(result.failure).toBe('unknown-spell')
  })

  it('시전자가 주문을 모르면 knowledge 실패', () => {
    // MAGE지만 SBLESS 미보유(빈 store).
    const caster = baseCaster({ spells: emptySpellStore() })
    const result = teach(caster, { spells: emptySpellStore() }, SBLESS)
    expect(result.failure).toBe('knowledge')
  })

  it('spllv 권한 미충족이면 spllv 실패(MAGE가 spllv1 SVIGOR 전수 시도)', () => {
    // MAGE는 SVIGOR(spllv1)를 알아도 spllv1 전수 권한이 없다(canTeachSpllv(MAGE,1)=false).
    const caster = baseCaster({ spells: setKnown(emptySpellStore(), SVIGOR) })
    const result = teach(caster, { spells: emptySpellStore() }, SVIGOR)
    expect(result.failure).toBe('spllv')
  })

  it('CLERIC은 spllv1 SVIGOR를 전수한다', () => {
    const caster = baseCaster({ class: CLERIC, spells: setKnown(emptySpellStore(), SVIGOR) })
    const result = teach(caster, { spells: emptySpellStore() }, SVIGOR)
    expect(result.ok).toBe(true)
    expect(isKnown(result.spells, SVIGOR)).toBe(true)
  })

  it('CARETAKER는 spllv4 STELEP를 전수하지만 spllv5 SBLIND는 spllv 실패(전수불가 quirk)', () => {
    const casterKnowsTelep = baseCaster({
      class: CARETAKER,
      spells: setKnown(emptySpellStore(), STELEP),
    })
    expect(teach(casterKnowsTelep, { spells: emptySpellStore() }, STELEP).ok).toBe(true)

    const casterKnowsBlind = baseCaster({
      class: CARETAKER,
      spells: setKnown(emptySpellStore(), SBLIND),
    })
    const blindResult = teach(casterKnowsBlind, { spells: emptySpellStore() }, SBLIND)
    expect(blindResult.ok).toBe(false)
    expect(blindResult.failure).toBe('spllv')
  })

  it('SUB_DM·DM은 base-class 게이트에서 막힌다(원작 충실 quirk)', () => {
    // SUB_DM(11)은 CARETAKER/MAGE/CLERIC이 아니라 base 게이트에서 class 실패한다.
    const caster = baseCaster({ class: SUB_DM, spells: setKnown(emptySpellStore(), SRECAL) })
    const result = teach(caster, { spells: emptySpellStore() }, SRECAL)
    expect(result.failure).toBe('class')
  })
})
