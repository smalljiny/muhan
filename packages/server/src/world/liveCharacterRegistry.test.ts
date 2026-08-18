import { describe, it, expect } from 'vitest'
import { type Character } from 'shared'
import { createLiveCharacterRegistry, type LiveCharacter } from './liveCharacterRegistry.js'

/**
 * liveCharacterRegistry 라이프사이클 — character._id 키의 라이브 캐릭터 상태 레지스트리.
 *
 * combatRegistry와 동일한 팩토리 선례를 따른다(Map을 클로저 소유·전역 싱글턴 미조회). get은
 * register한 동일 참조를 반환해, 후속 콜사이트가 `character.currentRoom`을 in-place 갱신하면
 * 이후 조회에 반영된다(라이브 참조 계약). 방 위치의 단일 출처는 `character.currentRoom`이며
 * LiveCharacter에 별도 방 필드를 두지 않는다(D-A1).
 */
function makeCharacter(id: string): Character {
  return {
    _id: id,
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 12, 10, 14],
    gold: 100,
    currentRoom: 1,
    hpCurrent: 42,
    mpCurrent: 15,
    level: 7,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    alignment: 1,
  }
}

function makeLive(id: string): LiveCharacter {
  return { character: makeCharacter(id), inventory: [] }
}

describe('createLiveCharacterRegistry', () => {
  it('register 후 get이 동일 참조를 반환한다(character._id 키)', () => {
    const registry = createLiveCharacterRegistry()
    const live = makeLive('char-1')
    registry.register(live)
    expect(registry.get('char-1')).toBe(live)
  })

  it('remove 후 has=false, get=undefined', () => {
    const registry = createLiveCharacterRegistry()
    registry.register(makeLive('char-1'))
    registry.remove('char-1')
    expect(registry.has('char-1')).toBe(false)
    expect(registry.get('char-1')).toBeUndefined()
  })

  it('has는 등록 여부를 반영한다', () => {
    const registry = createLiveCharacterRegistry()
    expect(registry.has('char-1')).toBe(false)
    registry.register(makeLive('char-1'))
    expect(registry.has('char-1')).toBe(true)
  })

  it('미등록 characterId는 undefined를 반환한다', () => {
    const registry = createLiveCharacterRegistry()
    expect(registry.get('missing')).toBeUndefined()
  })

  it('두 팩토리 인스턴스는 상태를 공유하지 않는다(전역 싱글턴 미조회)', () => {
    const a = createLiveCharacterRegistry()
    const b = createLiveCharacterRegistry()
    a.register(makeLive('char-1'))
    expect(a.has('char-1')).toBe(true)
    expect(b.has('char-1')).toBe(false)
  })

  it('참조로 character.currentRoom을 갱신하면 이후 조회에 반영된다(라이브 참조 계약)', () => {
    const registry = createLiveCharacterRegistry()
    const live = makeLive('char-1')
    registry.register(live)
    const held = registry.get('char-1')
    held!.character.currentRoom = 42
    expect(registry.get('char-1')!.character.currentRoom).toBe(42)
    // 별도 방 필드가 아니라 character.currentRoom이 단일 출처다(D-A1).
    expect(live.character.currentRoom).toBe(42)
  })

  it('list()는 등록된 모든 엔트리를 반환한다', () => {
    const registry = createLiveCharacterRegistry()
    const a = makeLive('char-1')
    const b = makeLive('char-2')
    registry.register(a)
    registry.register(b)
    const all = registry.list()
    expect(all).toHaveLength(2)
    expect(all).toContain(a)
    expect(all).toContain(b)
  })

  it('list()는 빈 레지스트리에서 빈 배열을 반환한다', () => {
    const registry = createLiveCharacterRegistry()
    expect(registry.list()).toEqual([])
  })

  it('방 위치는 별도 필드가 아니라 character.currentRoom으로 읽힌다(D-A1 구조)', () => {
    const registry = createLiveCharacterRegistry()
    const live = makeLive('char-1')
    registry.register(live)
    const got = registry.get('char-1')!
    expect(got.character.currentRoom).toBe(1)
    // LiveCharacter에 중복 방 필드가 없음을 구조적으로 확인.
    expect('currentRoom' in got).toBe(false)
  })
})
