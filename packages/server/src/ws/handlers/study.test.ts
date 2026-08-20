import { describe, it, expect, vi } from 'vitest'
import { isKnown, serverEventSchema, type Character, type ObjectInstance } from 'shared'
import { flagsHex } from '../../world/roomFixtures.testutil.js'
import { OCLSEL, OEVILO } from '../../world/hexFlags.js'
import { MISC, SCROLL } from '../../items/taxonomy.js'
import type { ObjectTemplate } from '../../items/objectTemplate.js'
import {
  makeObjectInstance,
  makeObjectTemplate,
  makeTemplateIndex as makeIndex,
} from '../../items/objectFixtures.testutil.js'
import { createLiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../../world/markCharacterDirty.js'
import type { MarkObjectDeleted } from '../../save/markObjectDeleted.js'
import type { ActorContext } from '../actorContext.js'
import { createStudyHandler, type StudyHandlerDeps } from './study.js'
import { dispatch, createCommandRegistry } from '../router.js'
import type { ChannelPort } from '../channelPort.js'
import type { PermissionPort } from '../permissionPort.js'

/**
 * progress:study 핸들러 스펙 — 소지품 이름 해소(#120)·study() 게이트·비법서 소멸·라이브 교체를
 * 하나의 명령 경로로 배선한다.
 *
 * 인스턴스·템플릿 팩토리는 `items/objectFixtures.testutil.ts`(단일 출처)에서 상속하고, 여기서는
 * study 도메인 기본값("연마 가능한 비법서")만 덮어쓴다. 게이트 임계는 magic/learning.test.ts와
 * 같은 값을 쓴다.
 */

// ── 픽스처 ───────────────────────────────────────────────────────────────────

/** 현재 틱(고정). 실명 만료 판정 기준이 이 값이다. */
const NOW = 50

/** 표준 비법서 objnum. */
const BOOK_OBJNUM = 2
/** 표준 비법서가 담은 주문번호(magicpower - 1) — 카탈로그 0번 `회복`. */
const BOOK_SPELL_NO = 0

function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 5,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    level: 10,
    hpCurrent: 55,
    mpCurrent: 40,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 6,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  }
}

/** 테스트용 ObjectInstance 팩토리 — 기본값이 곧 "소지 중인 비법서"다. */
function makeInstance(overrides: Partial<ObjectInstance> = {}): ObjectInstance {
  return makeObjectInstance({
    _id: 'book-1',
    objnum: BOOK_OBJNUM,
    type: SCROLL,
    ...overrides,
  })
}

/** 테스트용 ObjectTemplate 팩토리 — 기본값이 곧 "연마 가능한 비법서"다. */
function makeTemplate(overrides: Partial<ObjectTemplate> = {}): ObjectTemplate {
  return makeObjectTemplate({
    objnum: BOOK_OBJNUM,
    name: '비법서',
    type: SCROLL,
    // ndice는 레벨 제한이다(0이면 무제한) — 공용 기본값 0을 그대로 쓴다.
    // magicpower = 주문번호 + 1.
    magicpower: BOOK_SPELL_NO + 1,
    ...overrides,
  })
}

const actor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

/**
 * 핸들러 deps 조립기 — 라이브 엔트리·템플릿 인덱스를 주입하고 두 마킹 seam·now를 spy로 노출한다.
 *
 * 두 마킹은 `createMark*`를 거치지 않은 순수 spy다 — OQ1 순서 단언이 두 spy의
 * `mock.invocationCallOrder` 비교에 서기 때문이다(래퍼를 끼우면 호출 순서가 아니라 원시 seam의
 * 인자 형태를 보게 되어 순서가 흐려진다).
 */
function makeDeps(options: {
  character?: Character
  inventory?: readonly ObjectInstance[]
  templates?: readonly ObjectTemplate[]
  registry?: ReturnType<typeof createLiveCharacterRegistry>
}) {
  const registry = options.registry ?? createLiveCharacterRegistry()
  if (options.character !== undefined) {
    registry.register({ character: options.character, inventory: options.inventory ?? [] })
  }
  const markCharacterDirty = vi.fn<MarkCharacterDirty>()
  const markObjectDeleted = vi.fn<MarkObjectDeleted>()
  const now = vi.fn(() => NOW)
  const deps: StudyHandlerDeps = {
    liveRegistry: registry,
    objectTemplates: makeIndex(options.templates ?? [makeTemplate()]),
    now,
    markCharacterDirty,
    markObjectDeleted,
  }
  return { deps, registry, markCharacterDirty, markObjectDeleted, now }
}

/** 성공 경로 표준 하네스 — 인벤에 비법서 1권. */
function makeSuccessDeps() {
  return makeDeps({ character: makeChar(), inventory: [makeInstance()] })
}

describe('createStudyHandler', () => {
  describe('성공 경로', () => {
    it('인벤의 비법서를 이름으로 지목하면 progress:studied를 내고 spells 비트를 세팅한다', () => {
      const { deps } = makeSuccessDeps()

      const event = createStudyHandler(deps)({ type: 'progress:study', target: '비법' }, actor)

      expect(event).toMatchObject({
        type: 'progress:studied',
        spellNo: BOOK_SPELL_NO,
        spellName: '회복',
        consumedObjectId: 'book-1',
      })
      const spells = (event as { spells: number[] }).spells
      expect(isKnown(spells, BOOK_SPELL_NO)).toBe(true)
    })

    it('발화 이벤트가 와이어 계약(serverEventSchema)을 통과한다', () => {
      const { deps } = makeSuccessDeps()

      const event = createStudyHandler(deps)({ type: 'progress:study', target: '비법서' }, actor)

      const parsed = serverEventSchema.safeParse(event)
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.type === 'progress:studied') {
        expect(parsed.data.spells).toHaveLength(16)
      }
    })

    it('markCharacterDirty가 markObjectDeleted보다 먼저 호출된다 (OQ1 마킹 순서)', () => {
      const { deps, markCharacterDirty, markObjectDeleted } = makeSuccessDeps()

      createStudyHandler(deps)({ type: 'progress:study', target: '비법서' }, actor)

      expect(markCharacterDirty).toHaveBeenCalledTimes(1)
      expect(markObjectDeleted).toHaveBeenCalledTimes(1)
      // 코얼레싱은 각 키의 **최초 삽입 위치**를 보존하므로, 순서 보장은 최초 마킹이 올바른 순서로
      // 나갈 때만 성립한다 — 그래서 호출 순서 자체를 단언한다.
      const characterOrder = markCharacterDirty.mock.invocationCallOrder[0] ?? -1
      const objectOrder = markObjectDeleted.mock.invocationCallOrder[0] ?? -1
      expect(characterOrder).toBeLessThan(objectOrder)
    })

    it('마킹 인자는 actor.characterId·소모 인스턴스 _id다', () => {
      const { deps, markCharacterDirty, markObjectDeleted } = makeSuccessDeps()

      createStudyHandler(deps)({ type: 'progress:study', target: '비법서' }, actor)

      expect(markCharacterDirty).toHaveBeenCalledWith(
        'char-1',
        expect.objectContaining({ _id: 'char-1' }),
      )
      expect(markObjectDeleted).toHaveBeenCalledWith('book-1')
      // 스냅샷은 학습 후 spells를 실어야 한다(마킹이 갱신 전 객체를 보면 학습이 유실된다).
      const snapshot = markCharacterDirty.mock.calls[0]?.[1] as Character
      expect(isKnown(snapshot.spells, BOOK_SPELL_NO)).toBe(true)
    })

    it('라이브 엔트리에서 소모된 인스턴스만 빠지고 나머지는 순서대로 남는다', () => {
      const first = makeInstance({ _id: 'misc-1', objnum: 9 })
      const book = makeInstance({ _id: 'book-1' })
      const last = makeInstance({ _id: 'misc-2', objnum: 9 })
      const { deps, registry } = makeDeps({
        character: makeChar(),
        inventory: [first, book, last],
        templates: [makeTemplate(), makeTemplate({ objnum: 9, name: '단도', type: MISC })],
      })

      createStudyHandler(deps)({ type: 'progress:study', target: '비법서' }, actor)

      expect(registry.get('char-1')?.inventory).toEqual([first, last])
      expect(isKnown(registry.get('char-1')?.character.spells ?? [], BOOK_SPELL_NO)).toBe(true)
    })

    it('관찰자 flags를 1회만 합성한다 (now seam 1회 호출 — T7.2)', () => {
      const { deps, now } = makeSuccessDeps()

      createStudyHandler(deps)({ type: 'progress:study', target: '비법서' }, actor)

      expect(now).toHaveBeenCalledTimes(1)
    })

    it('ordinal로 두 번째 비법서를 지목한다', () => {
      const { deps, markObjectDeleted } = makeDeps({
        character: makeChar(),
        inventory: [makeInstance({ _id: 'book-a' }), makeInstance({ _id: 'book-b' })],
      })

      const event = createStudyHandler(deps)(
        { type: 'progress:study', target: '비법서', ordinal: 2 },
        actor,
      )

      expect(event).toMatchObject({ type: 'progress:studied', consumedObjectId: 'book-b' })
      expect(markObjectDeleted).toHaveBeenCalledWith('book-b')
    })

    it('이미 학습한 주문의 비법서를 다시 연마해도 성공하고 삭제가 다시 마킹된다 (OQ1 자가 치유)', () => {
      const registry = createLiveCharacterRegistry()
      const first = makeDeps({
        character: makeChar(),
        inventory: [makeInstance({ _id: 'book-a' }), makeInstance({ _id: 'book-b' })],
        registry,
      })
      createStudyHandler(first.deps)({ type: 'progress:study', target: '비법서' }, actor)

      // 같은 라이브 레지스트리 위에서 두 번째 비법서를 연마한다(주문은 이미 습득 상태).
      const second = makeDeps({ registry })
      const event = createStudyHandler(second.deps)(
        { type: 'progress:study', target: '비법서' },
        actor,
      )

      expect(event).toMatchObject({ type: 'progress:studied', consumedObjectId: 'book-b' })
      expect(second.markObjectDeleted).toHaveBeenCalledWith('book-b')
      expect(registry.get('char-1')?.inventory).toEqual([])
    })
  })

  describe('실패 7종 → rule_rejected + 고유 한국어 message', () => {
    /**
     * 사유별 픽스처 — 각 케이스는 검증 대상 게이트 이전의 모든 게이트를 통과하는 입력을 쓴다
     * (.harness/rules/testing.md 다층 guard 원칙).
     */
    const cases: {
      name: string
      character: Character
      template: ObjectTemplate
      target: string
    }[] = [
      {
        name: 'blind',
        character: makeChar({ statusEffects: { blind: { until: NOW + 10 } } }),
        template: makeTemplate(),
        target: '비법서',
      },
      {
        name: 'not-a-book',
        character: makeChar(),
        template: makeTemplate({ type: MISC }),
        target: '비법서',
      },
      {
        name: 'level',
        character: makeChar({ level: 1 }),
        template: makeTemplate({ ndice: 99 }),
        target: '비법서',
      },
      {
        // 값역 divergence(#123) 때문에 라이브 데이터에서는 발화하지 않지만, 스키마상 alignment는
        // 무제한 int라 게이트 자체는 여기서 정확히 재현된다.
        name: 'alignment',
        character: makeChar({ alignment: 200 }),
        template: makeTemplate({ flags: flagsHex(OEVILO) }),
        target: '비법서',
      },
      {
        // OCLSEL 세트 + (OCLSEL+class) 비트 없음 + class < CARETAKER.
        name: 'class',
        character: makeChar({ class: 1 }),
        template: makeTemplate({ flags: flagsHex(OCLSEL) }),
        target: '비법서',
      },
      {
        name: 'no-spell',
        character: makeChar(),
        template: makeTemplate({ magicpower: 0 }),
        target: '비법서',
      },
      {
        // 해소 실패 — 소지품 어디에도 그 이름이 없다.
        name: 'not-found',
        character: makeChar(),
        template: makeTemplate(),
        target: '방패',
      },
    ]

    it.each(cases)(
      '$name → rule_rejected + 한국어 message, 두 마킹 모두 미호출',
      ({ character, template, target }) => {
        const { deps, markCharacterDirty, markObjectDeleted, registry } = makeDeps({
          character,
          inventory: [makeInstance()],
          templates: [template],
        })

        const event = createStudyHandler(deps)({ type: 'progress:study', target }, actor)

        expect(event).toMatchObject({ type: 'error', code: 'rule_rejected' })
        const message = (event as { message: string }).message
        expect(message).toMatch(/[가-힣]/)
        expect(markCharacterDirty).not.toHaveBeenCalled()
        expect(markObjectDeleted).not.toHaveBeenCalled()
        // 거부 시 인벤은 그대로다 — alignment 거부가 아이템을 소모하지 않는다는 divergence(T7.5)도
        // 이 단언에 포함된다.
        expect(registry.get('char-1')?.inventory).toHaveLength(1)
      },
    )

    it('실패 7종이 서로 다른 message를 갖는다 (사유별 사상 누락 적발)', () => {
      const messages = cases.map(({ character, template, target }) => {
        const { deps } = makeDeps({
          character,
          inventory: [makeInstance()],
          templates: [template],
        })
        const event = createStudyHandler(deps)({ type: 'progress:study', target }, actor)
        return (event as { message: string }).message
      })
      expect(new Set(messages).size).toBe(cases.length)
    })

    it('id가 있으면 rule_rejected 이벤트에 correlationId를 반향한다', () => {
      const { deps } = makeDeps({ character: makeChar(), inventory: [] })

      const event = createStudyHandler(deps)(
        { type: 'progress:study', target: '비법서', id: 's9' },
        actor,
      )

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', correlationId: 's9' })
    })
  })

  describe('배선 격리 (internal)', () => {
    it('라이브 미등록 actor면 error{internal}, 두 마킹 모두 미호출', () => {
      const { deps, markCharacterDirty, markObjectDeleted } = makeDeps({})

      const event = createStudyHandler(deps)(
        { type: 'progress:study', target: '비법서', id: 's1' },
        actor,
      )

      expect(event).toMatchObject({ type: 'error', code: 'internal', correlationId: 's1' })
      expect(markCharacterDirty).not.toHaveBeenCalled()
      expect(markObjectDeleted).not.toHaveBeenCalled()
    })

    it('defensive narrow: progress:study가 아닌 명령은 undefined를 반환한다', () => {
      const { deps } = makeSuccessDeps()
      expect(createStudyHandler(deps)({ type: 'debug:echo', text: '핑' }, actor)).toBeUndefined()
    })
  })
})

// ── 조건부 등록 ──────────────────────────────────────────────────────────────

describe('createCommandRegistry — progress:study 조건부 등록', () => {
  const testChannelPort: ChannelPort = { deliver: () => {} }
  const testPermission: PermissionPort = { check: () => true }

  it('study deps 없이 만들면 progress:study는 미등록 → unknown_type', () => {
    const registry = createCommandRegistry(testChannelPort)

    const result = dispatch(
      registry,
      { type: 'progress:study', target: '비법서' },
      actor,
      testPermission,
    )

    expect(result.outcome).toBe('rejected')
    expect(result.events[0]).toMatchObject({ type: 'error', code: 'unknown_type' })
  })

  it('study deps를 주면 progress:study가 study 핸들러로 디스패치된다', () => {
    const { deps } = makeSuccessDeps()
    const registry = createCommandRegistry(testChannelPort, { study: deps })

    const result = dispatch(
      registry,
      { type: 'progress:study', target: '비법서' },
      actor,
      testPermission,
    )

    expect(result.outcome).toBe('handled')
    expect(result.events[0]).toMatchObject({
      type: 'progress:studied',
      spellNo: BOOK_SPELL_NO,
      consumedObjectId: 'book-1',
    })
  })
})
