import { describe, it, expect, vi } from 'vitest'
import type { Character, RoomNode } from 'shared'
import type { LiveCharacter } from '../world/liveCharacterRegistry.js'
import type { LiveCharacterEntry } from '../world/liveCharacterEntry.js'
import { XSECRT } from '../world/door.js'
import { OHIDDN, MHIDDN } from '../world/hexFlags.js'
import { exitFlags, flagsHex, makeExitTo, makeItem, makeCreature, makeRoom as makeRoomBase } from '../world/roomFixtures.testutil.js'
import { buildRoomSummary, buildSessionLiveWorld } from './liveWorldBinding.js'

/**
 * buildRoomSummary — world:room emit용 방 뷰 파생 단위 스펙.
 *
 * exits는 반드시 exit **이름**(ExitEdge.name)이어야 한다(인덱스 아님 — tryMove selector 계약).
 * 미해소 방은 undefined를 반환해 enterCommand가 world:room을 건너뛴다. 가시성 필터·점유자 이름 해소
 * 규칙 자체는 `projectRoomView`(roomView.test.ts)가 소유하나, 이 파생기가 실제로 그 투영을 경유하는지는
 * 여기서 확인한다 — 위임이 끊기면 진입 경로만 조용히 숨김 개체를 노출한다.
 */

/**
 * 방 픽스처. 출구는 이름 문자열(플래그 없음) 또는 `{name, flags}` 쌍으로 준다 — 비밀 출구 케이스가
 * 플래그를 실을 수 있어야 한다. 나머지 필드는 overrides로 덮어쓴다.
 */
function makeRoom(
  roomId: number,
  exits: (string | { name: string; flags: number[] })[],
  overrides: Partial<RoomNode> = {},
): RoomNode {
  return makeRoomBase({
    roomId,
    name: `방-${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits: exits.map((exit) => {
      const { name, flags } = typeof exit === 'string' ? { name: exit, flags: exitFlags() } : exit
      return makeExitTo(name, roomId + 1, flags)
    }),
    ...overrides,
  })
}

/** 이름을 해소하지 못하는 기본 해소자 — 점유자를 다루지 않는 케이스의 잡음을 없앤다. */
const noNames = (): undefined => undefined

describe('buildRoomSummary', () => {
  it('해소된 방을 world:room 전 필드(이름·설명·출구·점유자·아이템·크리처)로 투영한다', () => {
    const rooms = new Map<number, RoomNode>([
      [
        50,
        makeRoom(50, ['북', '남'], {
          name: '광장',
          longDesc: '넓은 광장이다.',
          items: [makeItem('obj-1', '단검')],
          creatures: [makeCreature('crt-1', '쥐')],
        }),
      ],
    ])
    const summary = buildRoomSummary((id) => rooms.get(id), noNames)

    expect(summary(50)).toEqual({
      roomId: 50,
      name: '광장',
      longDesc: '넓은 광장이다.',
      exits: ['북', '남'],
      occupants: [],
      items: [{ instanceId: 'obj-1', name: '단검' }],
      creatures: [{ instanceId: 'crt-1', name: '쥐', level: 3 }],
    })
  })

  it('출구가 없는 방은 빈 exits 배열을 준다', () => {
    const rooms = new Map<number, RoomNode>([[7, makeRoom(7, [])]])
    const summary = buildRoomSummary((id) => rooms.get(id), noNames)

    expect(summary(7)).toEqual({
      roomId: 7,
      name: '방-7',
      longDesc: '',
      exits: [],
      occupants: [],
      items: [],
      creatures: [],
    })
  })

  it('미해소 방(resolveRoom undefined)은 undefined를 반환한다', () => {
    const summary = buildRoomSummary(() => undefined, noNames)

    expect(summary(9999)).toBeUndefined()
  })

  it('숨김 아이템·숨김 크리처·비밀 출구를 걸러 낸다 (projectRoomView 위임 확인)', () => {
    const rooms = new Map<number, RoomNode>([
      [
        3,
        makeRoom(3, ['북', { name: '숨은문', flags: exitFlags(XSECRT) }], {
          items: [
            makeItem('obj-1', '보이는 단검'),
            makeItem('obj-2', '숨은 열쇠', flagsHex(OHIDDN)),
          ],
          creatures: [
            makeCreature('crt-1', '보이는 쥐'),
            makeCreature('crt-2', '숨은 도적', { flags: flagsHex(MHIDDN) }),
          ],
        }),
      ],
    ])
    const summary = buildRoomSummary((id) => rooms.get(id), noNames)
    const view = summary(3)

    expect(view?.exits).toEqual(['북'])
    expect(view?.items).toEqual([{ instanceId: 'obj-1', name: '보이는 단검' }])
    expect(view?.creatures).toEqual([{ instanceId: 'crt-1', name: '보이는 쥐', level: 3 }])
  })

  it('점유자 이름을 resolveCharacterName으로 해소하고 미해소 id는 제외한다', () => {
    const rooms = new Map<number, RoomNode>([
      [4, makeRoom(4, [], { occupants: new Set(['char-1', 'char-ghost']) })],
    ])
    const names = new Map<string, string>([['char-1', '타이']])
    const summary = buildRoomSummary(
      (id) => rooms.get(id),
      (id) => names.get(id),
    )

    expect(summary(4)?.occupants).toEqual([{ characterId: 'char-1', name: '타이' }])
  })
})

describe('buildSessionLiveWorld', () => {
  it('hydrate/place는 진입 코어에 위임하고 roomSummary는 월드 그래프에서 파생한다', async () => {
    const character = { _id: 'char-1', currentRoom: 12 } as unknown as Character
    const live: LiveCharacter = { character }
    const hydrate = vi.fn(() => Promise.resolve(live))
    const place = vi.fn()
    const entry: LiveCharacterEntry = { hydrate, place, release: vi.fn() }
    const rooms = new Map<number, RoomNode>([
      [12, makeRoom(12, ['위'], { occupants: new Set(['char-1']) })],
    ])

    const liveWorld = buildSessionLiveWorld({
      entry,
      resolveRoom: (id) => rooms.get(id),
      resolveCharacterName: (id) => (id === 'char-1' ? '타이' : undefined),
    })

    await expect(liveWorld.hydrate('char-1')).resolves.toBe(live)
    expect(hydrate).toHaveBeenCalledWith('char-1')
    liveWorld.place(live)
    expect(place).toHaveBeenCalledWith(live)
    expect(liveWorld.roomSummary(12)).toEqual({
      roomId: 12,
      name: '방-12',
      longDesc: '',
      exits: ['위'],
      // 본인(char-1)도 그대로 실린다 — 본인 제외는 클라이언트 책임이다(스펙 §4).
      occupants: [{ characterId: 'char-1', name: '타이' }],
      items: [],
      creatures: [],
    })
  })
})
