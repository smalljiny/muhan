import { describe, it, expect } from 'vitest'
import type { ServerEvent } from 'shared/protocol'
import {
  applyPresence,
  formatPresenceNotice,
  NOTICE_LIMIT,
  type PresenceEvent,
} from './presence.js'
import { makeRoom } from '../test/roomFixtures.testutil.js'

type Change = Extract<ServerEvent, { type: 'world:presence' }>['change']

// world:presence 픽스처 — 기본 대상은 makeRoom() 점유자에 없는 c2(개발전사)다.
function presence(
  change: Change,
  subject = { characterId: 'c2', name: '개발전사' },
): PresenceEvent {
  return { type: 'world:presence', roomId: 1, subject: { kind: 'player', ...subject }, change }
}

const OUT_ANNOUNCED: Change = { change: 'moved-out', direction: '북', announce: true }
const IN_ANNOUNCED: Change = { change: 'moved-in', announce: true }
const ENTERED_ANNOUNCED: Change = { change: 'entered', announce: true }
const EXITED: Change = { change: 'exited', announce: false }

// 본인 c1 + 대상 c2가 함께 있는 방 — 퇴장 변화의 제거를 확인하는 시작 상태.
const C1 = { characterId: 'c1', name: '타이' }
const C2 = { characterId: 'c2', name: '개발전사' }

describe('formatPresenceNotice', () => {
  // 원본은 플레이어 이름 뒤에 항상 `님`을 붙이므로 받침 유무와 상관없이 `님이`로 고정된다.
  it.each(['개발전사', '무한검'])('formats moved-out for %s with a fixed 님이 particle', (name) => {
    const event = presence(OUT_ANNOUNCED, { characterId: 'c2', name })
    expect(formatPresenceNotice(event)).toBe(`${name}님이 북쪽으로 갔습니다.`)
  })

  it.each(['개발전사', '무한검'])('formats moved-in for %s as an arrival sentence', (name) => {
    const event = presence(IN_ANNOUNCED, { characterId: 'c2', name })
    expect(formatPresenceNotice(event)).toBe(`${name}님이 도착하였습니다.`)
  })

  it.each(['개발전사', '무한검'])('formats entered for %s as an arrival sentence', (name) => {
    const event = presence(ENTERED_ANNOUNCED, { characterId: 'c2', name })
    expect(formatPresenceNotice(event)).toBe(`${name}님이 도착하였습니다.`)
  })

  it('returns null for exited', () => {
    expect(formatPresenceNotice(presence(EXITED))).toBeNull()
  })
})

describe('applyPresence occupants', () => {
  it.each([IN_ANNOUNCED, ENTERED_ANNOUNCED])('adds the subject on $change', (change) => {
    const room = makeRoom({ occupants: [C1], notices: [] })
    expect(applyPresence(room, presence(change)).occupants).toEqual([C1, C2])
  })

  it.each([OUT_ANNOUNCED, EXITED])('removes the subject on $change', (change) => {
    const room = makeRoom({ occupants: [C1, C2], notices: [] })
    expect(applyPresence(room, presence(change)).occupants).toEqual([C1])
  })

  it.each([IN_ANNOUNCED, ENTERED_ANNOUNCED])(
    'does not duplicate an existing characterId on $change',
    (change) => {
      const room = makeRoom({ occupants: [C1, C2], notices: [] })
      expect(applyPresence(room, presence(change)).occupants).toEqual([C1, C2])
    },
  )

  it.each([OUT_ANNOUNCED, EXITED])(
    'keeps occupants unchanged when the $change subject is absent',
    (change) => {
      const room = makeRoom({ occupants: [C1], notices: [] })
      expect(applyPresence(room, presence(change)).occupants).toEqual([C1])
    },
  )

  it('updates occupants even when announce is false', () => {
    const room = makeRoom({ occupants: [C1], notices: [] })
    const next = applyPresence(room, presence({ change: 'moved-in', announce: false }))
    expect(next.occupants).toEqual([C1, C2])
  })
})

describe('applyPresence notices', () => {
  it.each<Change>([
    { change: 'moved-out', direction: '북', announce: false },
    { change: 'moved-in', announce: false },
    { change: 'entered', announce: false },
  ])('leaves notices unchanged when $change is not announced', (change) => {
    const room = makeRoom({ occupants: [C1, C2], notices: ['이전 알림'] })
    expect(applyPresence(room, presence(change)).notices).toEqual(['이전 알림'])
  })

  it('appends the sentence when announce is true', () => {
    const room = makeRoom({ occupants: [C1], notices: ['이전 알림'] })
    expect(applyPresence(room, presence(IN_ANNOUNCED)).notices).toEqual([
      '이전 알림',
      '개발전사님이 도착하였습니다.',
    ])
  })

  it('appends the sentence for an announced moved-out whose subject is not in occupants', () => {
    const room = makeRoom({ occupants: [C1], notices: [] })
    expect(applyPresence(room, presence(OUT_ANNOUNCED)).notices).toEqual([
      '개발전사님이 북쪽으로 갔습니다.',
    ])
  })

  it.each([
    ['present', [C1, C2]],
    ['absent', [C1]],
  ])('keeps notices unchanged on exited when the subject is %s', (_label, occupants) => {
    const room = makeRoom({ occupants, notices: ['이전 알림'] })
    expect(applyPresence(room, presence(EXITED)).notices).toEqual(['이전 알림'])
  })

  it('drops the oldest notice when the 21st arrives, keeping 20', () => {
    expect(NOTICE_LIMIT).toBe(20)
    const full = Array.from({ length: 20 }, (_, i) => `알림 ${i}`)
    const room = makeRoom({ occupants: [C1], notices: full })
    const next = applyPresence(room, presence(IN_ANNOUNCED))
    expect(next.notices).toHaveLength(20)
    expect(next.notices[0]).toBe('알림 1')
    expect(next.notices[19]).toBe('개발전사님이 도착하였습니다.')
  })
})

describe('applyPresence immutability', () => {
  it.each([IN_ANNOUNCED, OUT_ANNOUNCED, EXITED])(
    'does not mutate the input room on $change',
    (change) => {
      const occupants = [C1, C2]
      const notices = ['이전 알림']
      const room = makeRoom({ occupants, notices })
      const snapshot = structuredClone(room)
      const next = applyPresence(room, presence(change))
      expect(room).toEqual(snapshot)
      expect(room.occupants).toBe(occupants)
      expect(room.notices).toBe(notices)
      expect(next).not.toBe(room)
    },
  )
})
