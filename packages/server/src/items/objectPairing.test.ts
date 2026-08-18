import { describe, it, expect } from 'vitest'
import { pairObject, pairObjects } from './objectPairing.js'
import { projectEquipStats, type EquippedPair } from './equipStats.js'
import {
  makeObjectInstance as makeInstance,
  makeObjectTemplate as makeTemplate,
  makeTemplateIndex as makeIndex,
} from './objectFixtures.testutil.js'

describe('pairObject', () => {
  it('objnum으로 템플릿이 해소되면 {instance, template} 쌍을 반환한다', () => {
    const template = makeTemplate({ objnum: 7, name: '비법서' })
    const instance = makeInstance({ _id: 'obj-a', objnum: 7 })

    const result = pairObject(instance, makeIndex([template]))

    expect(result).toEqual({ instance, template })
  })

  it('반환한 쌍은 입력 인스턴스·인덱스 템플릿의 동일 참조를 싣는다(값 복사 없음)', () => {
    const template = makeTemplate({ objnum: 7 })
    const instance = makeInstance({ objnum: 7 })

    const result = pairObject(instance, makeIndex([template]))

    expect(result?.instance).toBe(instance)
    expect(result?.template).toBe(template)
  })

  it('objnum이 인덱스에 없으면 undefined를 반환한다(호출자가 판단)', () => {
    const instance = makeInstance({ objnum: 999 })

    const result = pairObject(instance, makeIndex([makeTemplate({ objnum: 7 })]))

    expect(result).toBeUndefined()
  })

  it('빈 인덱스에서는 항상 undefined를 반환한다', () => {
    expect(pairObject(makeInstance({ objnum: 1 }), makeIndex([]))).toBeUndefined()
  })

  it('입력 인스턴스를 변형하지 않는다(immutability)', () => {
    const instance = makeInstance({ objnum: 7 })
    const snapshot = structuredClone(instance)

    pairObject(instance, makeIndex([makeTemplate({ objnum: 7 })]))

    expect(instance).toEqual(snapshot)
  })
})

describe('pairObjects', () => {
  it('입력 순서를 그대로 보존한다', () => {
    const index = makeIndex([
      makeTemplate({ objnum: 1, name: '단도' }),
      makeTemplate({ objnum: 2, name: '비법서' }),
      makeTemplate({ objnum: 3, name: '방패' }),
    ])
    const instances = [
      makeInstance({ _id: 'c', objnum: 3 }),
      makeInstance({ _id: 'a', objnum: 1 }),
      makeInstance({ _id: 'b', objnum: 2 }),
    ]

    const result = pairObjects(instances, index)

    expect(result.map((p) => p.instance._id)).toEqual(['c', 'a', 'b'])
    expect(result.map((p) => p.template.name)).toEqual(['방패', '단도', '비법서'])
    // 참조 소유권이 이 모듈의 핵심 불변식이다 — _id 비교는 얕은 복사본이 끼어도 통과하므로
    // 인스턴스 참조 자체를 못박는다(단수 경로 pairObject 테스트와 같은 강도).
    expect(result[0]?.instance).toBe(instances[0])
    expect(result[1]?.instance).toBe(instances[1])
    expect(result[2]?.instance).toBe(instances[2])
  })

  it('템플릿 미해소 인스턴스만 제외하고 나머지 순서는 유지한다', () => {
    const index = makeIndex([makeTemplate({ objnum: 1 }), makeTemplate({ objnum: 3 })])
    const instances = [
      makeInstance({ _id: 'a', objnum: 1 }),
      makeInstance({ _id: 'orphan', objnum: 2 }),
      makeInstance({ _id: 'c', objnum: 3 }),
    ]

    const result = pairObjects(instances, index)

    expect(result.map((p) => p.instance._id)).toEqual(['a', 'c'])
  })

  it('모든 인스턴스가 미해소면 빈 배열을 반환한다', () => {
    const instances = [
      makeInstance({ _id: 'orphan-8', objnum: 8 }),
      makeInstance({ _id: 'orphan-9', objnum: 9 }),
    ]

    expect(pairObjects(instances, makeIndex([]))).toEqual([])
  })

  it('빈 입력이면 빈 배열을 반환한다', () => {
    expect(pairObjects([], makeIndex([makeTemplate({ objnum: 1 })]))).toEqual([])
  })

  it('같은 objnum 인스턴스가 여럿이면 각각 같은 템플릿과 짝지어 모두 남긴다', () => {
    const template = makeTemplate({ objnum: 4 })
    const instances = [
      makeInstance({ _id: 'x', objnum: 4 }),
      makeInstance({ _id: 'y', objnum: 4 }),
    ]

    const result = pairObjects(instances, makeIndex([template]))

    expect(result).toHaveLength(2)
    expect(result[0]?.template).toBe(template)
    expect(result[1]?.template).toBe(template)
  })

  it('입력 배열과 원소를 변형하지 않는다(immutability)', () => {
    const index = makeIndex([makeTemplate({ objnum: 1 })])
    const instances = [makeInstance({ _id: 'a', objnum: 1 }), makeInstance({ _id: 'b', objnum: 2 })]
    const snapshot = structuredClone(instances)

    const result = pairObjects(instances, index)

    expect(instances).toEqual(snapshot)
    expect(instances).toHaveLength(2)
    expect(result).not.toBe(instances)
  })

  it('산출물이 EquippedPair 계약을 만족한다(캐스팅 없이 projectEquipStats 입력 타입에 대입 가능)', () => {
    // 컴파일 레벨 검증 — #121이 이 산출물을 그대로 소비한다는 계약을 tsc가 지킨다.
    // projectEquipStats를 호출하지는 않는다(장비 스탯 투영은 #121 범위).
    const index = makeIndex([makeTemplate({ objnum: 1, armor: 5 })])
    const paired = pairObjects([makeInstance({ objnum: 1, equipped: true, slot: 0 })], index)

    const equipStatsInput: Parameters<typeof projectEquipStats>[0] = paired
    const pairs: ReadonlyArray<EquippedPair> = paired

    expect(equipStatsInput).toHaveLength(1)
    expect(pairs).toHaveLength(1)
  })
})
