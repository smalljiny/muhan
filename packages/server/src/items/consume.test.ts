import { describe, it, expect } from 'vitest'
import { SPELL_NO, spellByNo, type ObjectInstance } from 'shared'
import { SpellDispatch } from '../magic/dispatch.js'
import type { Caster } from '../magic/caster.js'
import { deliverConsumable } from './consume.js'
import { POTION, SCROLL, WAND, ARMOR, MISC } from './taxonomy.js'

/**
 * 소비 아이템 magic 배달 seam 테스트(magic1.c drink/readscroll/zap · #86).
 *
 * POTION/SCROLL/WAND는 splno=magicpower-1·how≠CAST로 magic dispatch에 배달한다.
 * gated=false라 마나·클래스·knowledge 게이트를 전부 우회(PASS)하고 마나를 소비하지 않는다.
 * magic effect 본체는 재구현하지 않는다 — 분류(resolve)만, 실행 안 함.
 */

// offensive/비-offensive 판별은 spellByNo 카탈로그로 확인한다(하드코딩 회피).
const OFFENSIVE_SPELL = SPELL_NO.SHURTS // 삭풍
const NON_OFFENSIVE_SPELL = SPELL_NO.SVIGOR // 회복

// magicpower는 splno+1로 배달된다(splno=magicpower-1).
const magicpowerFor = (spellNo: number) => spellNo + 1

// 라이브 mpCurrent를 관찰 가능한 최소 Caster 스텁 — 마나 불변 검증에 mpCurrent를 읽는다.
function makeCaster(mp = 30): Caster {
  let current = mp
  return {
    get mpCurrent() {
      return current
    },
    set mpCurrent(v: number) {
      current = v
    },
    level: 5,
    realm: [0, 0, 0, 0],
    class: 0,
    intBonus: 0,
    knows: () => false,
  }
}

function makeInstance(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: POTION,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 0,
    shotscur: 3,
    schemaVersion: 1,
    ...overrides,
  }
}

describe('deliverConsumable — 카탈로그 판별 전제', () => {
  it('테스트 픽스처의 offensive/비-offensive 성질이 카탈로그와 일치한다', () => {
    // 이 전제가 깨지면 unresolved 테스트가 의미를 잃는다(하드코딩 회피 가드).
    expect(spellByNo(OFFENSIVE_SPELL)?.offensive).toBe(true)
    expect(spellByNo(NON_OFFENSIVE_SPELL)?.offensive).toBe(false)
  })
})

describe('deliverConsumable — context 라우팅 + noop', () => {
  it('POTION(6)/SCROLL(7)/WAND(8)를 각 context로 라우팅한다', () => {
    const dispatch = new SpellDispatch<unknown>()
    const magicpower = magicpowerFor(NON_OFFENSIVE_SPELL) // 비-offensive 미등록 → unresolved(context 관찰)
    const caster = makeCaster()

    const potion = deliverConsumable({
      type: POTION,
      magicpower,
      instance: makeInstance({ type: POTION }),
      caster,
      dispatch,
    })
    const scroll = deliverConsumable({
      type: SCROLL,
      magicpower,
      instance: makeInstance({ type: SCROLL }),
      caster,
      dispatch,
    })
    const wand = deliverConsumable({
      type: WAND,
      magicpower,
      instance: makeInstance({ type: WAND }),
      caster,
      dispatch,
    })

    expect(potion).toEqual({ kind: 'unresolved', spellNo: NON_OFFENSIVE_SPELL, context: 'potion' })
    expect(scroll).toEqual({ kind: 'unresolved', spellNo: NON_OFFENSIVE_SPELL, context: 'scroll' })
    expect(wand).toEqual({ kind: 'unresolved', spellNo: NON_OFFENSIVE_SPELL, context: 'wand' })
  })

  it('POTION/SCROLL/WAND 외 타입은 noop이다(ARMOR·MISC)', () => {
    const dispatch = new SpellDispatch<unknown>()
    const caster = makeCaster()
    for (const type of [ARMOR, MISC]) {
      const outcome = deliverConsumable({
        type,
        magicpower: magicpowerFor(OFFENSIVE_SPELL),
        instance: makeInstance({ type }),
        caster,
        dispatch,
      })
      expect(outcome).toEqual({ kind: 'noop' })
    }
  })
})

describe('deliverConsumable — shotscur 가드(depleted)', () => {
  it('shotscur < 1이면 depleted(배달 전 차단, 오라클 drink shotscur<1 pre-guard)', () => {
    const dispatch = new SpellDispatch<unknown>()
    const instance = makeInstance({ shotscur: 0 })
    const outcome = deliverConsumable({
      type: POTION,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance,
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome).toEqual({ kind: 'depleted' })
    // 입력 무변경(음수로 흐르지 않음).
    expect(instance.shotscur).toBe(0)
  })
})

describe('deliverConsumable — magicpower 특수처리(no-spell, resolve 이전)', () => {
  it('magicpower == 0이면 no-spell(throw 아님)', () => {
    const dispatch = new SpellDispatch<unknown>()
    const outcome = deliverConsumable({
      type: POTION,
      magicpower: 0,
      instance: makeInstance(),
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome).toEqual({ kind: 'no-spell' })
  })

  it('magicpower == 0(no-spell)과 offensive-미등록(unresolved)을 구분한다', () => {
    // 판별 가드: magicpower 특수처리가 resolve *이전*이어야 두 케이스가 갈린다.
    // spellNo=-1을 resolve에 넘기면 undefined가 되어 offensive-미등록과 뒤섞인다.
    const dispatch = new SpellDispatch<unknown>()
    const caster = makeCaster()

    const noSpell = deliverConsumable({
      type: POTION,
      magicpower: 0,
      instance: makeInstance(),
      caster,
      dispatch,
    })
    const unresolved = deliverConsumable({
      type: POTION,
      magicpower: magicpowerFor(OFFENSIVE_SPELL), // 핸들러 미등록
      instance: makeInstance(),
      caster,
      dispatch,
    })

    expect(noSpell.kind).toBe('no-spell')
    expect(unresolved.kind).toBe('unresolved')
  })
})

describe('deliverConsumable — resolve 분기(unresolved/delivered)', () => {
  it('비-offensive 미등록 spellNo → undefined → unresolved(shotscur 불변)', () => {
    const dispatch = new SpellDispatch<unknown>()
    const instance = makeInstance({ shotscur: 2 })
    const outcome = deliverConsumable({
      type: SCROLL,
      magicpower: magicpowerFor(NON_OFFENSIVE_SPELL),
      instance,
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome).toEqual({
      kind: 'unresolved',
      spellNo: NON_OFFENSIVE_SPELL,
      context: 'scroll',
    })
    // unresolved는 charge를 소모하지 않는다.
    expect(instance.shotscur).toBe(2)
  })

  it('offensive 미등록 spellNo → undefined → unresolved(shotscur 불변)', () => {
    const dispatch = new SpellDispatch<unknown>()
    const instance = makeInstance({ type: WAND, shotscur: 5 })
    const outcome = deliverConsumable({
      type: WAND,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance,
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome).toEqual({
      kind: 'unresolved',
      spellNo: OFFENSIVE_SPELL,
      context: 'wand',
    })
    expect(instance.shotscur).toBe(5)
  })

  it('offensive 등록 spellNo → 핸들러 → delivered(spellNo·context, shotscur 미변경)', () => {
    const dispatch = new SpellDispatch<unknown>()
    dispatch.register(OFFENSIVE_SPELL, () => 'handler') // 핸들러 형태는 무관(호출 안 함)
    const instance = makeInstance({ type: POTION, shotscur: 3 })
    const outcome = deliverConsumable({
      type: POTION,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance,
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome.kind).toBe('delivered')
    if (outcome.kind === 'delivered') {
      expect(outcome.spellNo).toBe(OFFENSIVE_SPELL)
      expect(outcome.context).toBe('potion')
    }
    // seam은 감소하지 않는다 — shotscur 감소는 effect 성공(오라클 `if(n)`) 시 배선 계층 소관.
    expect(instance.shotscur).toBe(3)
  })
})

describe('deliverConsumable — shotscur 불변(seam은 감소하지 않음)', () => {
  it('delivered여도 seam은 입력 인스턴스를 변형하지 않는다 — 감소는 배선 유예(오라클 성공 결합)', () => {
    const dispatch = new SpellDispatch<unknown>()
    dispatch.register(OFFENSIVE_SPELL, () => 'handler')
    const instance = makeInstance({ shotscur: 1 })
    const outcome = deliverConsumable({
      type: POTION,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance,
      caster: makeCaster(),
      dispatch,
    })
    expect(outcome.kind).toBe('delivered')
    // delivered는 object를 담지 않는다(감소 유예). 입력 인스턴스 shotscur 무변경.
    expect(instance.shotscur).toBe(1)
  })
})

describe('deliverConsumable — 마나 미소비(gated=false positive)', () => {
  it('delivered 경로 후 caster.mpCurrent가 호출 전후 동일(evaluateGate gated=false, 미판정)', () => {
    const dispatch = new SpellDispatch<unknown>()
    dispatch.register(OFFENSIVE_SPELL, () => 'handler')
    const caster = makeCaster(30)
    const before = caster.mpCurrent
    deliverConsumable({
      type: POTION,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance: makeInstance(),
      caster,
      dispatch,
    })
    expect(caster.mpCurrent).toBe(before)
    expect(caster.mpCurrent).toBe(30)
  })

  it('unresolved 경로 후에도 마나 불변', () => {
    const dispatch = new SpellDispatch<unknown>()
    const caster = makeCaster(25)
    deliverConsumable({
      type: SCROLL,
      magicpower: magicpowerFor(OFFENSIVE_SPELL),
      instance: makeInstance({ type: SCROLL }),
      caster,
      dispatch,
    })
    expect(caster.mpCurrent).toBe(25)
  })
})
