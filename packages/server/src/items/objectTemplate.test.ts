import { describe, it, expect } from 'vitest'
import {
  buildObjectTemplateIndex,
  loadObjectTemplates,
  type ObjectTemplate,
  type RawObjectTemplate,
} from './objectTemplate.js'

/** 소규모 인메모리 raw 엔트리 팩토리 — 필드 복사·필터를 실파일 의존 없이 검증한다. */
function rawObject(over: Partial<RawObjectTemplate> = {}): RawObjectTemplate {
  return {
    id: 1,
    name: '롱소드     ',
    description: '날카로운 검',
    value: 100,
    weight: 30,
    type: 0,
    adjustment: 2,
    shotsmax: 25,
    shotscur: 25,
    ndice: 1,
    sdice: 6,
    pdice: 3,
    armor: 0,
    wearflag: 20,
    magicpower: 0,
    magicrealm: 0,
    special: 0,
    questnum: 0,
    flags: '0000000000000000',
    ...over,
  }
}

describe('buildObjectTemplateIndex — objnum → ObjectTemplate 인덱스', () => {
  it('objnum(=raw.id) 키의 ReadonlyMap을 반환한다', () => {
    const index = buildObjectTemplateIndex([rawObject({ id: 7 })])
    expect(index.get(7)).toBeDefined()
    expect(index.get(7)?.objnum).toBe(7)
    expect(index.size).toBe(1)
  })

  it('템플릿 스탯 필드를 raw 엔트리에서 정확히 복사한다', () => {
    const raw = rawObject({
      id: 42,
      name: '미스릴 갑옷 ',
      type: 5,
      value: 5000,
      weight: 120,
      adjustment: 3,
      shotsmax: 1,
      ndice: 2,
      sdice: 4,
      pdice: 1,
      armor: 45,
      wearflag: 1,
      magicpower: 7,
      magicrealm: 2,
      special: 9,
      questnum: 11,
      flags: '0800000000000000',
    })
    const t = buildObjectTemplateIndex([raw]).get(42)
    expect(t).toEqual({
      objnum: 42,
      name: '미스릴 갑옷 ',
      type: 5,
      value: 5000,
      weight: 120,
      adjustment: 3,
      shotsmax: 1,
      ndice: 2,
      sdice: 4,
      pdice: 1,
      armor: 45,
      wearflag: 1,
      magicpower: 7,
      magicrealm: 2,
      special: 9,
      questnum: 11,
      flags: '0800000000000000',
    })
  })

  it('flags를 hex 문자열 비트필드로 그대로 보존한다(파싱하지 않음)', () => {
    const t = buildObjectTemplateIndex([rawObject({ id: 3, flags: '0800000000000000' })]).get(3)
    expect(t?.flags).toBe('0800000000000000')
  })

  it('인스턴스 런타임값 shotscur를 템플릿에 포함하지 않는다', () => {
    const t = buildObjectTemplateIndex([rawObject({ id: 1, shotscur: 25 })]).get(1)
    expect(t).not.toHaveProperty('shotscur')
  })

  it('템플릿 스탯이 아닌 description을 포함하지 않는다', () => {
    const t = buildObjectTemplateIndex([rawObject({ id: 1 })]).get(1)
    expect(t).not.toHaveProperty('description')
  })

  it('type>14(게시판 엔트리)를 인덱스에서 제외한다', () => {
    const index = buildObjectTemplateIndex([
      rawObject({ id: 1, type: 0 }),
      rawObject({ id: 2, type: 14 }),
      rawObject({ id: 100, type: 100 }),
      rawObject({ id: 120, type: 120 }),
    ])
    expect(index.size).toBe(2)
    expect(index.get(1)).toBeDefined()
    expect(index.get(2)).toBeDefined()
    expect(index.get(100)).toBeUndefined()
    expect(index.get(120)).toBeUndefined()
    expect([...index.values()].every((t) => t.type >= 0 && t.type <= 14)).toBe(true)
  })
})

describe('loadObjectTemplates — data/world/objects.json', () => {
  it('objects.json을 objnum 인덱스로 로드하고 게시판(type>14) 엔트리를 제외한다', () => {
    const index = loadObjectTemplates()
    expect(index.size).toBe(691)
    expect([...index.values()].every((t) => t.type >= 0 && t.type <= 14)).toBe(true)
  })

  it('동전(id 0, type 10 MONEY) 템플릿 필드를 정확히 로드한다', () => {
    const money = loadObjectTemplates().get(0)
    expect(money).toBeDefined()
    expect(money?.type).toBe(10)
    expect(money?.flags).toBe('0800000000000000')
    expect(money).not.toHaveProperty('shotscur')
  })
})
