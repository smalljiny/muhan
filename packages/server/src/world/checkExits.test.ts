import { describe, it, expect } from 'vitest'
import type { ExitEdge, RoomNode } from 'shared'
import { setFlag, hasFlag, XLOCKD, XCLOSD, XLOCKS, XCLOSS } from './door.js'
import { WorldClock } from './worldClock.js'
import { FakeClock } from '../util/clock.testutil.js'
import { createCheckExitsSlot } from './checkExits.js'

// ── 테스트 fixture 헬퍼 ───────────────────────────────────────────────────────

// 테스트용 출구 엣지 팩토리. flags는 4바이트(32비트) number[]로 주어진 능력 비트를
// setFlag로 세팅한다. ltime/interval로 타이머 만료 경계를 제어한다(만료 = ltime+interval<now).
function makeExit(bits: number[], ltime: number, interval: number): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name: '문', targetRoomId: 100, flags, key: 0, ltime, interval }
}

// 출구 배열을 담는 최소 방 노드. checkExits는 exits만 순회하므로 나머지는 기본값으로 채운다.
function makeRoom(roomId: number, exits: ExitEdge[]): RoomNode {
  return {
    roomId,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits,
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

// 방 노드 배열로 Map<number, RoomNode> 그래프를 구성한다.
function makeGraph(rooms: RoomNode[]): Map<number, RoomNode> {
  return new Map(rooms.map((r) => [r.roomId, r]))
}

describe('createCheckExitsSlot — 슬롯 계약', () => {
  it('name은 checkExits, intervalSec는 1(매 틱 평가)이다', () => {
    const slot = createCheckExitsSlot(makeGraph([]))
    expect(slot.name).toBe('checkExits')
    expect(slot.intervalSec).toBe(1)
  })
})

describe('createCheckExitsSlot — 타이머 자동 재설정 (WorldClock 구동)', () => {
  it('만료된 XLOCKS-only 출구를 XLOCKD·XCLOSD 둘 다 재설정한다(room.c:469, "잠금은 닫힘 함의")', () => {
    // ltime=0, interval=5 → now>=6에서 만료(5<6). tick(6)으로 now=6까지 진행.
    // XCLOSS 없는 XLOCKS-only 출구(data/world에 4개 실재)라도 원본은 XCLOSD를 함께 세팅해
    // "잠겼지만 열린" 모순 상태를 만들지 않는다.
    const exit = makeExit([XLOCKS], 0, 5)
    const graph = makeGraph([makeRoom(1, [exit])])
    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    clock.register(createCheckExitsSlot(graph))
    clock.start()

    fake.tick(6)

    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
  })

  it('만료된 XCLOSS 출구를 XCLOSD로 재닫는다', () => {
    const exit = makeExit([XCLOSS], 0, 5)
    const graph = makeGraph([makeRoom(1, [exit])])
    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    clock.register(createCheckExitsSlot(graph))
    clock.start()

    fake.tick(6)

    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
  })

  it('한 출구가 XLOCKS+XCLOSS를 동시에 보유·만료 시 XLOCKD·XCLOSD를 한 스윕에서 둘 다 설정한다', () => {
    // XLOCKS 분기(if)가 XLOCKD+XCLOSD를 모두 세팅하므로 XCLOSS(else-if 미평가)와 무관하게 결과 동일.
    const exit = makeExit([XLOCKS, XCLOSS], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(6) // 5 < 6 → 둘 다 만료

    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
  })

  it('여러 방·여러 출구를 한 스윕에서 모두 재설정한다', () => {
    const e1 = makeExit([XLOCKS], 0, 5)
    const e2 = makeExit([XCLOSS], 0, 5)
    const graph = makeGraph([makeRoom(1, [e1]), makeRoom(2, [e2])])
    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    clock.register(createCheckExitsSlot(graph))
    clock.start()

    fake.tick(6)

    expect(hasFlag(e1.flags, XLOCKD)).toBe(true)
    expect(hasFlag(e2.flags, XCLOSD)).toBe(true)
  })
})

describe('createCheckExitsSlot — 불변 케이스', () => {
  it('미만료 출구(ltime+interval >= now)는 상태 불변이다', () => {
    // XLOCKS+XCLOSS 둘 다 보유해 두 조건의 미만료(<-false) 분기를 함께 커버한다.
    // ltime=0, interval=5, now=5 → 5<5 false(경계, 아직 만료 아님).
    const exit = makeExit([XLOCKS, XCLOSS], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(5)

    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
  })

  it('능력 없는 출구(XLOCKS/XCLOSS 없음)는 만료돼도 불변이다', () => {
    // 능력 비트 없음 → 두 조건의 hasFlag(-false) 분기를 함께 커버한다. now=100으로 명백 만료.
    const exit = makeExit([], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(100)

    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
  })
})

describe('createCheckExitsSlot — 만료 경계 (strict less-than, room.c:469)', () => {
  it('now == ltime+interval이면 아직 만료 아님(불변)', () => {
    const exit = makeExit([XLOCKS], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(5) // 5 < 5 → false

    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
  })

  it('now < ltime+interval이면 만료 아님(불변)', () => {
    const exit = makeExit([XLOCKS], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(4) // 5 < 4 → false

    expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
  })

  it('now > ltime+interval이면 만료(재잠금)', () => {
    const exit = makeExit([XLOCKS], 0, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(6) // 5 < 6 → true

    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
  })

  it('ltime 오프셋을 반영한다(ltime=10, interval=5 → now=16에서 만료)', () => {
    const exit = makeExit([XCLOSS], 10, 5)
    const slot = createCheckExitsSlot(makeGraph([makeRoom(1, [exit])]))

    slot.run(15) // 15 < 15 → false
    expect(hasFlag(exit.flags, XCLOSD)).toBe(false)

    slot.run(16) // 15 < 16 → true
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
  })
})
