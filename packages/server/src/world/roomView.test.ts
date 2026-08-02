import { describe, it, expect } from 'vitest'
import { XSECRT, XINVIS, XNOSEE, XLOCKD } from './door.js'
import { OHIDDN, OSCENE, OINVIS, MHIDDN, MINVIS, MPERMT } from './hexFlags.js'
import { projectRoomView } from './roomView.js'
import { NO_FLAGS, exitFlags, flagsHex, makeExit, makeItem, makeCreature, makeRoom } from './roomFixtures.testutil.js'

/**
 * projectRoomView — 오라클 방 표시 규칙(room.c) 투영 단위 스펙.
 *
 * 두 flags 표현이 섞인다: 출구는 바이트당 한 원소인 number[](door.ts hasFlag), 아이템·크리처는
 * 16자 hex string(hexFlags.ts F_ISSET). 픽스처는 손으로 비트를 계산하지 않고 setFlag·F_SET
 * 헬퍼로 만든다(roomFixtures.testutil.ts) — 바이트 오프셋 실수를 원천 차단한다.
 */

/** 모든 characterId를 `이름:<id>`로 해소하는 기본 해소자. */
const resolveAll = (characterId: string): string => `이름:${characterId}`

describe('projectRoomView — 비필터 방 전량 투영', () => {
  it('필터 대상이 없으면 출구·점유자·아이템·크리처를 전부 싣는다', () => {
    const room = makeRoom({
      roomId: 42,
      exits: [makeExit('동'), makeExit('북')],
      items: [makeItem('42:0', '동전'), makeItem('42:1', '단검')],
      occupants: new Set(['c1', 'c2']),
      creatures: [makeCreature('42:m0', '좀도둑'), makeCreature('42:m1', '들쥐')],
    })

    const view = projectRoomView(room, resolveAll)

    expect(view).toEqual({
      roomId: 42,
      name: '작은 방',
      longDesc: '먼지 쌓인 작은 방이다.',
      exits: ['동', '북'],
      occupants: [
        { characterId: 'c1', name: '이름:c1' },
        { characterId: 'c2', name: '이름:c2' },
      ],
      items: [
        { instanceId: '42:0', name: '동전' },
        { instanceId: '42:1', name: '단검' },
      ],
      creatures: [
        { instanceId: '42:m0', name: '좀도둑', level: 3 },
        { instanceId: '42:m1', name: '들쥐', level: 3 },
      ],
    })
  })

  it('shortDesc를 싣지 않는다(2341방 중 2327방이 빈 문자열 — 스펙 §3.1)', () => {
    const room = makeRoom({ shortDesc: '싣지 않을 값' })

    const view = projectRoomView(room, resolveAll)

    expect(view).not.toHaveProperty('shortDesc')
  })

  it('필터에 걸리지 않는 출구 플래그(XLOCKD)는 제외하지 않는다', () => {
    const room = makeRoom({ exits: [makeExit('문', exitFlags(XLOCKD))] })

    expect(projectRoomView(room, resolveAll).exits).toEqual(['문'])
  })

  it('필터에 걸리지 않는 크리처 플래그(MPERMT)는 제외하지 않는다', () => {
    const room = makeRoom({
      creatures: [makeCreature('1:m0', '고정몹', { flags: flagsHex(MPERMT) })],
    })

    expect(projectRoomView(room, resolveAll).creatures).toEqual([
      { instanceId: '1:m0', name: '고정몹', level: 3 },
    ])
  })
})

describe('projectRoomView — 출구 가시성 필터', () => {
  it.each([
    ['XSECRT', XSECRT],
    ['XINVIS', XINVIS],
    ['XNOSEE', XNOSEE],
  ])('%s 출구를 제외한다', (_label, bit) => {
    const room = makeRoom({
      exits: [makeExit('동'), makeExit('비밀문', exitFlags(bit))],
    })

    expect(projectRoomView(room, resolveAll).exits).toEqual(['동'])
  })

  it('여러 가시성 비트가 겹친 출구를 제외한다', () => {
    const room = makeRoom({
      exits: [makeExit('비밀문', exitFlags(XSECRT, XINVIS, XNOSEE)), makeExit('서')],
    })

    expect(projectRoomView(room, resolveAll).exits).toEqual(['서'])
  })
})

describe('projectRoomView — 아이템 가시성 필터', () => {
  it.each([
    ['OHIDDN', OHIDDN],
    ['OSCENE', OSCENE],
    ['OINVIS', OINVIS],
  ])('%s 아이템을 제외한다', (_label, bit) => {
    const room = makeRoom({
      items: [makeItem('1:0', '동전'), makeItem('1:1', '숨긴 열쇠', flagsHex(bit))],
    })

    expect(projectRoomView(room, resolveAll).items).toEqual([{ instanceId: '1:0', name: '동전' }])
  })

  it('컨테이너 중첩 아이템(contains)으로 재귀하지 않는다 — 바닥 오브젝트만 나열', () => {
    const room = makeRoom({
      items: [makeItem('1:0', '상자', NO_FLAGS, [makeItem('1:0.0', '보석')])],
    })

    expect(projectRoomView(room, resolveAll).items).toEqual([{ instanceId: '1:0', name: '상자' }])
  })
})

describe('projectRoomView — 크리처 가시성·생존 필터', () => {
  it.each([
    ['MHIDDN', MHIDDN],
    ['MINVIS', MINVIS],
  ])('%s 크리처를 제외한다', (_label, bit) => {
    const room = makeRoom({
      creatures: [
        makeCreature('1:m0', '들쥐'),
        makeCreature('1:m1', '숨은 자객', { flags: flagsHex(bit) }),
      ],
    })

    expect(projectRoomView(room, resolveAll).creatures).toEqual([
      { instanceId: '1:m0', name: '들쥐', level: 3 },
    ])
  })

  it.each([
    ['hpcur = 0', 0],
    ['hpcur < 0', -5],
  ])('%s 크리처를 제외한다', (_label, hpcur) => {
    const room = makeRoom({
      creatures: [makeCreature('1:m0', '들쥐'), makeCreature('1:m1', '시체', { hpcur })],
    })

    expect(projectRoomView(room, resolveAll).creatures).toEqual([
      { instanceId: '1:m0', name: '들쥐', level: 3 },
    ])
  })

  it('hpcur = 1 크리처는 그대로 싣는다(경계값)', () => {
    const room = makeRoom({ creatures: [makeCreature('1:m0', '빈사 들쥐', { hpcur: 1 })] })

    expect(projectRoomView(room, resolveAll).creatures).toEqual([
      { instanceId: '1:m0', name: '빈사 들쥐', level: 3 },
    ])
  })
})

describe('projectRoomView — 점유자 이름 해소', () => {
  it('이름 해소에 실패한(undefined) 점유자를 제외한다', () => {
    const room = makeRoom({ occupants: new Set(['c1', 'ghost', 'c2']) })
    const resolve = (id: string): string | undefined => (id === 'ghost' ? undefined : `이름:${id}`)

    expect(projectRoomView(room, resolve).occupants).toEqual([
      { characterId: 'c1', name: '이름:c1' },
      { characterId: 'c2', name: '이름:c2' },
    ])
  })

  it('빈 문자열로 해소된 점유자를 제외한다(와이어 계약 name.min(1))', () => {
    const room = makeRoom({ occupants: new Set(['c1', 'nameless']) })
    const resolve = (id: string): string | undefined => (id === 'nameless' ? '' : `이름:${id}`)

    expect(projectRoomView(room, resolve).occupants).toEqual([
      { characterId: 'c1', name: '이름:c1' },
    ])
  })

  it('본인 characterId도 제외하지 않는다 — 제외는 클라이언트 책임(스펙 §4)', () => {
    const room = makeRoom({ occupants: new Set(['self', 'other']) })

    expect(projectRoomView(room, resolveAll).occupants).toEqual([
      { characterId: 'self', name: '이름:self' },
      { characterId: 'other', name: '이름:other' },
    ])
  })

  it('점유자가 없으면 빈 배열을 싣는다', () => {
    expect(projectRoomView(makeRoom(), resolveAll).occupants).toEqual([])
  })
})

describe('projectRoomView — 원본 값 보존', () => {
  it('빈 name·빈 longDesc를 그대로 통과시킨다(표시 fallback은 클라 책임)', () => {
    const room = makeRoom({ name: '', longDesc: '' })

    const view = projectRoomView(room, resolveAll)

    expect(view.name).toBe('')
    expect(view.longDesc).toBe('')
  })

  it('입력 room과 그 하위 배열·객체를 변형하지 않는다', () => {
    const room = makeRoom({
      exits: [makeExit('동'), makeExit('비밀문', exitFlags(XSECRT))],
      items: [makeItem('1:0', '동전'), makeItem('1:1', '소품', flagsHex(OSCENE))],
      occupants: new Set(['c1', 'ghost']),
      creatures: [makeCreature('1:m0', '들쥐'), makeCreature('1:m1', '시체', { hpcur: 0 })],
    })
    const before = structuredClone(room)

    projectRoomView(room, (id) => (id === 'ghost' ? undefined : `이름:${id}`))

    expect(room).toEqual(before)
  })

  it('산출 배열이 입력 배열과 동일 참조가 아니다', () => {
    const room = makeRoom({ exits: [makeExit('동')] })

    const view = projectRoomView(room, resolveAll)

    expect(view.exits).not.toBe(room.exits)
    expect(view.items).not.toBe(room.items)
    expect(view.creatures).not.toBe(room.creatures)
  })
})
