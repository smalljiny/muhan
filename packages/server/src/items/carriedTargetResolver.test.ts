import { describe, it, expect } from 'vitest'
import { OINVIS, PDINVI } from '../world/hexFlags.js'
import { flagsHex, NO_FLAGS } from '../world/roomFixtures.testutil.js'
import { resolveCarriedObject } from './carriedTargetResolver.js'
import {
  makeObjectInstance as makeInstance,
  makeObjectTemplate as makeTemplate,
  makeTemplateIndex as makeIndex,
} from './objectFixtures.testutil.js'
import { MAXWEAR } from './taxonomy.js'

/** OINVIS(비트 2)만 세팅된 object flags. */
const INVIS_FLAGS = flagsHex(OINVIS)
/** PDINVI(비트 21, 투명 감지)만 세팅된 관찰자 P-flags. */
const DETECT_INVIS = flagsHex(PDINVI)

/**
 * 대부분의 케이스가 공유하는 기본 인덱스 — objnum 2 = `비법서` 하나.
 * 어느 테스트도 인덱스를 변형하지 않으므로 모듈 상수로 둔다. 지역 `index`를 따로 만드는 테스트는
 * **인덱스 자체가 케이스의 변수**(별칭·투명·다중 템플릿)라는 신호다.
 */
const BOOK_INDEX = makeIndex([makeTemplate({ objnum: 2, name: '비법서' })])

describe('resolveCarriedObject — 1단 인벤 탐색(find_obj)', () => {
  it('미착용 인벤 아이템을 이름 접두로 해소한다', () => {
    const index = makeIndex([
      makeTemplate({ objnum: 1, name: '단도' }),
      makeTemplate({ objnum: 2, name: '비법서' }),
    ])
    const inventory = [makeInstance({ _id: 'a', objnum: 1 }), makeInstance({ _id: 'b', objnum: 2 })]

    const result = resolveCarriedObject(inventory, index, '비법', NO_FLAGS)

    expect(result?.instance._id).toBe('b')
    expect(result?.template.name).toBe('비법서')
  })

  it('서수 2를 주면 두 번째 매치를 고른다', () => {
    const inventory = [
      makeInstance({ _id: 'first', objnum: 2 }),
      makeInstance({ _id: 'second', objnum: 2 }),
    ]

    const result = resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)

    expect(result?.instance._id).toBe('second')
  })

  it('서수가 매치 수를 넘으면 undefined를 반환한다', () => {
    const inventory = [makeInstance({ _id: 'only', objnum: 2 })]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)).toBeUndefined()
  })

  it('질의가 어느 후보에도 안 맞으면 undefined를 반환한다', () => {
    const result = resolveCarriedObject([makeInstance({ objnum: 2 })], BOOK_INDEX, '방패', NO_FLAGS)

    expect(result).toBeUndefined()
  })

  it('빈 인벤이면 undefined를 반환한다', () => {
    expect(resolveCarriedObject([], makeIndex([]), '비법서', NO_FLAGS)).toBeUndefined()
  })

  it('별칭(keys)으로도 매치한다 — `단도`를 `도`로 지목', () => {
    const index = makeIndex([makeTemplate({ objnum: 1, name: '단도', keys: ['도', '칼'] })])
    const inventory = [makeInstance({ _id: 'dagger', objnum: 1 })]

    expect(resolveCarriedObject(inventory, index, '도', NO_FLAGS)?.instance._id).toBe('dagger')
    expect(resolveCarriedObject(inventory, index, '칼', NO_FLAGS)?.instance._id).toBe('dagger')
  })
})

describe('resolveCarriedObject — 1단 OINVIS 가시성 게이트', () => {
  it('투명(OINVIS) 후보를 1단에서 제외하고 서수 슬롯도 소모하지 않는다', () => {
    // 투명 후보가 배열 **앞**에 있다 — 매칭 후에 걸렀다면 서수 1이 두 번째 가시 후보를 골랐을 배치다.
    const index = makeIndex([
      makeTemplate({ objnum: 9, name: '비법서', flags: INVIS_FLAGS }),
      makeTemplate({ objnum: 2, name: '비법서' }),
    ])
    const inventory = [
      makeInstance({ _id: 'invis', objnum: 9 }),
      makeInstance({ _id: 'visible-1', objnum: 2 }),
      makeInstance({ _id: 'visible-2', objnum: 2 }),
    ]

    expect(resolveCarriedObject(inventory, index, '비법서', NO_FLAGS)?.instance._id).toBe(
      'visible-1',
    )
    expect(resolveCarriedObject(inventory, index, '비법서', NO_FLAGS, 2)?.instance._id).toBe(
      'visible-2',
    )
    // 투명 후보만 있는 질의는 미해소다.
    expect(resolveCarriedObject([inventory[0]!], index, '비법서', NO_FLAGS)).toBeUndefined()
  })

  it('관찰자가 PDINVI(투명 감지)를 들면 OINVIS 후보가 후보로 복귀한다', () => {
    const index = makeIndex([
      makeTemplate({ objnum: 9, name: '비법서', flags: INVIS_FLAGS }),
      makeTemplate({ objnum: 2, name: '비법서' }),
    ])
    const inventory = [
      makeInstance({ _id: 'invis', objnum: 9 }),
      makeInstance({ _id: 'visible-1', objnum: 2 }),
    ]

    expect(resolveCarriedObject(inventory, index, '비법서', DETECT_INVIS)?.instance._id).toBe(
      'invis',
    )
    expect(resolveCarriedObject(inventory, index, '비법서', DETECT_INVIS, 2)?.instance._id).toBe(
      'visible-1',
    )
  })
})

describe('resolveCarriedObject — 2단 착용 슬롯 스캔(ready[])', () => {
  it('1단이 미해소면 착용 슬롯을 slot 오름차순으로 스캔해 첫 매치를 돌려준다', () => {
    // 배열 순서를 슬롯 순서와 어긋나게 둔다 — 정렬이 실제로 일어나는지 본다.
    const inventory = [
      makeInstance({ _id: 'slot-7', objnum: 2, equipped: true, slot: 7 }),
      makeInstance({ _id: 'slot-2', objnum: 2, equipped: true, slot: 2 }),
      makeInstance({ _id: 'slot-5', objnum: 2, equipped: true, slot: 5 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)?.instance._id).toBe(
      'slot-2',
    )
  })

  it('2단 서수는 0부터 다시 세어 착용 후보 안에서만 계산된다', () => {
    const inventory = [
      makeInstance({ _id: 'slot-1', objnum: 2, equipped: true, slot: 1 }),
      makeInstance({ _id: 'slot-3', objnum: 2, equipped: true, slot: 3 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)?.instance._id).toBe(
      'slot-3',
    )
  })

  it('1단이 해소되면 착용 슬롯을 스캔하지 않는다', () => {
    const inventory = [
      makeInstance({ _id: 'worn', objnum: 2, equipped: true, slot: 0 }),
      makeInstance({ _id: 'carried', objnum: 2 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)?.instance._id).toBe(
      'carried',
    )
  })

  it('착용 스캔은 OINVIS를 거르지 않는다(오라클 ready[] 루프에 가시성 판정이 없다)', () => {
    const index = makeIndex([makeTemplate({ objnum: 9, name: '비법서', flags: INVIS_FLAGS })])
    const inventory = [makeInstance({ _id: 'invis-worn', objnum: 9, equipped: true, slot: 4 })]

    expect(resolveCarriedObject(inventory, index, '비법서', NO_FLAGS)?.instance._id).toBe(
      'invis-worn',
    )
  })

  // `ready[]`에 자리가 없는 슬롯값 3종 — 오라클 루프 `for(n=0; n<MAXWEAR; n++)`가 도달할 수 없다.
  it.each([
    ['null', null],
    ['음수', -1],
    ['MAXWEAR 이상', MAXWEAR],
  ])('slot이 %s인 착용 인스턴스는 2단 후보에서 빠진다', (_label, badSlot) => {
    const invalid = makeInstance({ _id: 'invalid', objnum: 2, equipped: true, slot: badSlot })
    // 무효 슬롯을 배열 앞에 둔다 — 걸러지지 않으면 정렬 첫 자리를 차지해 이 케이스가 깨진다.
    const inventory = [invalid, makeInstance({ _id: 'valid', objnum: 2, equipped: true, slot: 6 })]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)?.instance._id).toBe(
      'valid',
    )
    expect(resolveCarriedObject([invalid], BOOK_INDEX, '비법서', NO_FLAGS)).toBeUndefined()
  })

  it('착용 후보도 없으면 undefined를 반환한다', () => {
    const inventory = [makeInstance({ _id: 'worn', objnum: 2, equipped: true, slot: 1 })]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '방패', NO_FLAGS)).toBeUndefined()
  })

  it('2단 서수가 착용 매치 수를 넘으면 undefined다(1단 결과가 남지 않는다)', () => {
    const inventory = [makeInstance({ _id: 'worn', objnum: 2, equipped: true, slot: 1 })]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)).toBeUndefined()
  })

  it('1단 서수는 착용품을 세지 않는다(서수 2가 두 번째 미착용 후보를 고른다)', () => {
    // 착용품이 배열 앞에 있다 — 1단이 착용품을 세면 서수 2가 'carried-1'을 골랐을 배치다.
    const inventory = [
      makeInstance({ _id: 'worn', objnum: 2, equipped: true, slot: 0 }),
      makeInstance({ _id: 'carried-1', objnum: 2 }),
      makeInstance({ _id: 'carried-2', objnum: 2 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)?.instance._id).toBe(
      'carried-2',
    )
  })
})

describe('resolveCarriedObject — ordinal 0 갈래(와이어 도달 불가, 오라클 고정용)', () => {
  it('ordinal 0이면 1단이 구조적으로 미해소라 착용 슬롯 결과가 반환된다', () => {
    const inventory = [
      makeInstance({ _id: 'carried', objnum: 2 }),
      makeInstance({ _id: 'worn', objnum: 2, equipped: true, slot: 3 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 0)?.instance._id).toBe(
      'worn',
    )
  })

  it('ordinal 0에서 착용 후보가 없으면 undefined다(1단 결과가 남지 않는다)', () => {
    const inventory = [makeInstance({ _id: 'carried', objnum: 2 })]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 0)).toBeUndefined()
  })
})

describe('resolveCarriedObject — 템플릿 미해소·순수성', () => {
  it('템플릿 미해소 인스턴스는 후보에서 빠지고 서수도 소모하지 않는다', () => {
    const inventory = [
      makeInstance({ _id: 'orphan', objnum: 999 }),
      makeInstance({ _id: 'real-1', objnum: 2 }),
      makeInstance({ _id: 'real-2', objnum: 2 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)?.instance._id).toBe(
      'real-1',
    )
    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS, 2)?.instance._id).toBe(
      'real-2',
    )
  })

  it('템플릿 미해소 착용 인스턴스도 2단 후보에서 빠진다', () => {
    const inventory = [
      makeInstance({ _id: 'orphan-worn', objnum: 999, equipped: true, slot: 0 }),
      makeInstance({ _id: 'real-worn', objnum: 2, equipped: true, slot: 1 }),
    ]

    expect(resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)?.instance._id).toBe(
      'real-worn',
    )
  })

  it('반환한 쌍은 입력 인스턴스·인덱스 템플릿의 동일 참조를 싣는다', () => {
    const template = makeTemplate({ objnum: 2, name: '비법서' })
    const instance = makeInstance({ objnum: 2 })

    const result = resolveCarriedObject([instance], makeIndex([template]), '비법서', NO_FLAGS)

    expect(result?.instance).toBe(instance)
    expect(result?.template).toBe(template)
  })

  it('입력 배열·원소를 변형하지 않는다(immutability)', () => {
    const inventory = [
      makeInstance({ _id: 'slot-7', objnum: 2, equipped: true, slot: 7 }),
      makeInstance({ _id: 'slot-2', objnum: 2, equipped: true, slot: 2 }),
    ]
    const snapshot = structuredClone(inventory)

    resolveCarriedObject(inventory, BOOK_INDEX, '비법서', NO_FLAGS)

    // 2단 정렬이 입력 배열을 in-place로 뒤집지 않는지까지 본다.
    expect(inventory).toEqual(snapshot)
    expect(inventory.map((i) => i._id)).toEqual(['slot-7', 'slot-2'])
  })
})
