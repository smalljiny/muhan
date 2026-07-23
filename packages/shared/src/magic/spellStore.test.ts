import { describe, it, expect } from 'vitest'
import { emptySpellStore, isKnown, setKnown, SPELL_STORE_BYTES } from './spellStore.js'

/**
 * spellStore 비트마스크 헬퍼 단위 테스트 — mtype.h:570-571 S_ISSET/S_SET 이식.
 *
 * 플레이어 spell store는 uint8[16]=128비트다(A6 §8 spells[16]). 비트 f = 주문번호 f의
 * 습득 여부. read(isKnown)는 boolean, write(setKnown)는 입력 불변으로 새 store를 반환한다.
 */
describe('emptySpellStore', () => {
  it('16바이트 0으로 채운 빈 store를 반환한다', () => {
    const store = emptySpellStore()
    expect(store).toHaveLength(SPELL_STORE_BYTES)
    expect(store.every((b) => b === 0)).toBe(true)
  })

  it('호출마다 새 배열을 반환한다(공유 참조 없음)', () => {
    expect(emptySpellStore()).not.toBe(emptySpellStore())
  })
})

describe('isKnown', () => {
  it('빈 store는 어느 비트든 false다', () => {
    const store = emptySpellStore()
    expect(isKnown(store, 0)).toBe(false)
    expect(isKnown(store, 55)).toBe(false)
    expect(isKnown(store, 127)).toBe(false)
  })

  it('세팅된 비트는 true, 인접 비트는 false다(F_ISSET 정확성)', () => {
    const store = setKnown(emptySpellStore(), 6)
    expect(isKnown(store, 6)).toBe(true)
    expect(isKnown(store, 5)).toBe(false)
    expect(isKnown(store, 7)).toBe(false)
  })

  it('바이트 경계를 정확히 가른다(비트 7 vs 비트 8)', () => {
    const store = setKnown(emptySpellStore(), 8)
    expect(isKnown(store, 8)).toBe(true)
    expect(isKnown(store, 0)).toBe(false)
    expect(isKnown(store, 7)).toBe(false)
    expect(isKnown(store, 16)).toBe(false)
  })

  it('범위 밖 바이트(짧은 store)는 미세팅으로 취급한다(?? 0 방어)', () => {
    expect(isKnown([], 0)).toBe(false)
    expect(isKnown([0xff], 8)).toBe(false)
  })
})

describe('setKnown', () => {
  it('세팅한 비트가 isKnown 왕복으로 true다(전 폭 0·55·127)', () => {
    for (const n of [0, 7, 8, 55, 63, 64, 127]) {
      expect(isKnown(setKnown(emptySpellStore(), n), n)).toBe(true)
    }
  })

  it('입력 store를 변형하지 않고 새 store를 반환한다(immutability)', () => {
    const original = emptySpellStore()
    const snapshot = original.slice()
    const next = setKnown(original, 6)
    expect(next).not.toBe(original)
    expect(original).toEqual(snapshot)
    expect(isKnown(original, 6)).toBe(false)
  })

  it('여러 비트를 누적 세팅해도 각 비트가 독립적으로 유지된다', () => {
    let store = emptySpellStore()
    const bits = [0, 6, 13, 55, 127]
    for (const b of bits) store = setKnown(store, b)
    for (const b of bits) expect(isKnown(store, b)).toBe(true)
    expect(isKnown(store, 1)).toBe(false)
    expect(isKnown(store, 54)).toBe(false)
  })

  it('이미 세팅된 비트를 재세팅해도 idempotent다', () => {
    const once = setKnown(emptySpellStore(), 6)
    const twice = setKnown(once, 6)
    expect(twice).toEqual(once)
  })

  it('대상 바이트가 없는 짧은 store에 세팅하면 해당 슬롯을 채운다(?? 0 방어)', () => {
    const grown = setKnown([], 8)
    expect(isKnown(grown, 8)).toBe(true)
  })
})
