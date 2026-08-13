import type { ObjectInstance } from 'shared'
import { NO_FLAGS } from '../world/roomFixtures.testutil.js'
import type { ObjectTemplate, ObjectTemplateIndex } from './objectTemplate.js'

/**
 * 아이템 인스턴스·템플릿 테스트 픽스처의 단일 출처.
 *
 * 인스턴스(9필드)·템플릿(18필드) 팩토리가 items·ws/handlers 테스트에 5벌로 복제돼 있던 것을 모았다.
 * 복제 비용은 실제로 발생했다 — `ObjectTemplate.keys` 한 필드를 추가할 때 무관한 테스트 파일까지
 * 편집해야 했다. `world/roomFixtures.testutil.ts`·`progression/train.testutil.ts`와 같은 관례다.
 *
 * 기본값은 **도메인 중립**이다(`objnum: 100`, `name: 'test-item'`). 특정 도메인의 기본값이 필요한
 * 테스트는 여기서 상속하는 지역 래퍼를 두고 그 파일 안에서 의미를 고정한다 — 예컨대 study 핸들러
 * 테스트의 "기본값이 곧 연마 가능한 비법서", equipStats 테스트의 "기본값이 곧 착용 상태".
 *
 * flags는 `'0'` 리터럴 대신 `NO_FLAGS`(16자 zero hex)를 쓴다. 손으로 적은 리터럴은 0 개수를
 * 잘못 세도 테스트가 통과한다(roomFixtures.testutil.ts의 같은 판단).
 */

/** 테스트용 ObjectInstance 팩토리 — objectSchema shape를 정확히 만족한다. */
export function makeObjectInstance(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return {
    _id: 'obj-1',
    objnum: 100,
    type: 5,
    owner: { type: 'character', id: 'char-1' },
    slot: null,
    equipped: false,
    value: 50,
    shotscur: 0,
    schemaVersion: 1,
    ...overrides,
  }
}

/** 테스트용 ObjectTemplate 팩토리 — 필요한 스탯만 넘기고 나머지는 기본값. */
export function makeObjectTemplate(overrides: Partial<ObjectTemplate> = {}): ObjectTemplate {
  return {
    objnum: 100,
    name: 'test-item',
    keys: [],
    type: 5,
    value: 50,
    weight: 10,
    adjustment: 0,
    shotsmax: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    armor: 0,
    wearflag: 0,
    magicpower: 0,
    magicrealm: 0,
    special: 0,
    questnum: 0,
    flags: NO_FLAGS,
    ...overrides,
  }
}

/** 템플릿 배열로 objnum 인덱스를 만든다. */
export function makeTemplateIndex(templates: readonly ObjectTemplate[]): ObjectTemplateIndex {
  return new Map(templates.map((t) => [t.objnum, t]))
}
