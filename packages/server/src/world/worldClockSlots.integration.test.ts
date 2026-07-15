import { describe, it, expect } from 'vitest'
import type { ExitEdge, RoomNode } from 'shared'
import { setFlag, hasFlag, XLOCKD, XCLOSD, XLOCKS } from './door.js'
import { WorldClock } from './worldClock.js'
import { FakeClock } from '../util/clock.testutil.js'
import { createGameTime } from './gameTime.js'
import { createCheckExitsSlot } from './checkExits.js'

// index.ts boot 배선의 통합 정합성(플랜 line 233 "선택"). index.ts는 커버리지 제외 배선 코드라
// 이 테스트가 실 배선 형상 — 하나의 WorldClock에 gameTime·checkExits 슬롯을 동시 등록하고
// FakeClock으로 구동해 두 슬롯이 각자 케이던스로 함께 발화함을 결정적으로 검증한다.

function makeExit(bits: number[], ltime: number, interval: number): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name: '문', targetRoomId: 100, flags, key: 0, ltime, interval }
}

function makeGraph(exits: ExitEdge[]): Map<number, RoomNode> {
  const room: RoomNode = {
    roomId: 1,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits,
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
  }
  return new Map([[room.roomId, room]])
}

describe('WorldClock 슬롯 통합 — gameTime + checkExits 동시 등록', () => {
  it('한 클록에 두 슬롯을 등록하면 각자 케이던스로 함께 발화한다', () => {
    // XLOCKS-only 출구: ltime=0, interval=5 → now>=6에서 만료. checkExits는 intervalSec=1.
    const exit = makeExit([XLOCKS], 0, 5)
    const graph = makeGraph([exit])
    const gameTime = createGameTime()

    const fake = new FakeClock()
    const clock = new WorldClock({ clock: fake })
    clock.register(gameTime.slot)
    clock.register(createCheckExitsSlot(graph))
    clock.start()

    // 149틱: 게임시각 슬롯(intervalSec=150)은 아직 미발화, checkExits는 이미 만료 재설정 완료.
    fake.tick(149)
    expect(gameTime.currentHour()).toBe(0)
    expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
    expect(hasFlag(exit.flags, XCLOSD)).toBe(true)

    // 150틱째: 게임시각 슬롯이 발화해 Time += 1 → currentHour 1.
    fake.tick(1)
    expect(gameTime.currentHour()).toBe(1)
  })
})
