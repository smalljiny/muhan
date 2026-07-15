import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { ExitEdge, RoomNode } from 'shared'
import { intInRangeArb } from 'shared/property/arbitraries.testutil'
import { hasFlag, setFlag, XLOCKD, XCLOSD, XLOCKS, XCLOSS } from './door.js'
import { createCheckExitsSlot } from './checkExits.js'

/**
 * checkExits 스윕 property 테스트 — 타이머 자동 재설정의 핵심 불변식
 * "만료된 XLOCKS 출구는 XLOCKD ∧ XCLOSD가 **동시** 세팅된다(잠겼지만 열림 모순 부재)"를
 * fast-check로 실증한다(room.c:469 이식, "잠금은 닫힘을 함의").
 *
 * 비-vacuity 설계(advisor 지침): 완전 임의 flags/ltime/interval/now면 만료 ∧ XLOCKS 전건이
 * 일부 실행에서만 성립해 약하다. 대신 `now = ltime + interval + delta`(delta>=1)로 만료를
 * 보장하고 XLOCKS를 항상 세팅한 뒤, 두 비트를 **무조건** 단정한다 → 만료·재설정 경로를
 * 모든 실행에서 관측한다.
 *
 * in-place mutation 주의: 스윕은 exit.flags를 in-place 변경하므로 각 property 실행마다
 * 새 graph fixture를 만든다(공유 금지).
 */

// 단일 출구를 담는 fresh 방 노드(checkExits는 exits만 순회).
function makeRoom(exit: ExitEdge): RoomNode {
  return {
    roomId: 1,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [exit],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

// 지정 능력 비트를 세팅한 fresh ExitEdge(4바이트 flags, 매 호출 새 배열).
function makeExit(bits: number[], ltime: number, interval: number): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name: '문', targetRoomId: 100, flags, key: 0, ltime, interval }
}

const ltimeArb = intInRangeArb(0, 100000)
const intervalArb = intInRangeArb(1, 3600)
const deltaArb = intInRangeArb(1, 1000) // >=1 → strict less-than 만료 보장

describe('checkExits — 만료 XLOCKS 불변식 (property)', () => {
  it('만료된 XLOCKS 출구는 run 후 XLOCKD ∧ XCLOSD가 동시 세팅된다', () => {
    fc.assert(
      fc.property(ltimeArb, intervalArb, deltaArb, (ltime, interval, delta) => {
        const exit = makeExit([XLOCKS], ltime, interval)
        const graph = new Map<number, RoomNode>([[1, makeRoom(exit)]])
        const now = ltime + interval + delta // ltime+interval < now → 만료 보장
        createCheckExitsSlot(graph).run(now)
        // "잠겼지만 열림" 모순 부재: 두 비트가 동시에 세팅됨(무조건 단정, 성공 경로 항상 관측).
        expect(hasFlag(exit.flags, XLOCKD)).toBe(true)
        expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
      }),
    )
  })

  it('만료된 XCLOSS-only 출구는 XCLOSD만 세팅되고 XLOCKD는 세팅되지 않는다', () => {
    fc.assert(
      fc.property(ltimeArb, intervalArb, deltaArb, (ltime, interval, delta) => {
        const exit = makeExit([XCLOSS], ltime, interval)
        const graph = new Map<number, RoomNode>([[1, makeRoom(exit)]])
        const now = ltime + interval + delta
        createCheckExitsSlot(graph).run(now)
        expect(hasFlag(exit.flags, XCLOSD)).toBe(true)
        expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
      }),
    )
  })

  it('미만료(now <= ltime+interval) XLOCKS 출구는 상태 불변이다', () => {
    // now = ltime + interval - offset (offset>=0) → strict less-than false, 재설정 없음.
    fc.assert(
      fc.property(ltimeArb, intervalArb, (ltime, interval) => {
        const exit = makeExit([XLOCKS], ltime, interval)
        const graph = new Map<number, RoomNode>([[1, makeRoom(exit)]])
        const now = ltime + interval // 경계: ltime+interval < now false
        createCheckExitsSlot(graph).run(now)
        expect(hasFlag(exit.flags, XLOCKD)).toBe(false)
        expect(hasFlag(exit.flags, XCLOSD)).toBe(false)
      }),
    )
  })
})
