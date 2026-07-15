import { describe, it, expect } from 'vitest'
import type { ExitEdge, RoomNode } from 'shared'
import { setFlag } from './door.js'
import {
  evaluateMoveGates,
  danglingGate,
  lockedGate,
  closedGate,
  timeGate,
  capacityGate,
  MOVE_GATE_ORDER,
  XNGHTO,
  XDAYON,
  RONEPL,
  RTWOPL,
  RTHREE,
  type MoveGateActor,
  type MoveGateInput,
} from './moveGates.js'

// ── 테스트 픽스처 팩토리 ──────────────────────────────────────────────────────

// 출구 엣지(4바이트=32비트 flags). 주어진 비트만 세팅한 나머지 중립 출구.
function makeExit(bits: number[]): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name: '문', targetRoomId: 100, flags, key: 0, ltime: 0, interval: 60 }
}

// 대상 방(8바이트=64비트 flags). occupantCount 명의 가짜 점유자를 채운다.
function makeRoom(bits: number[], occupantCount: number): RoomNode {
  const flags = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  const occupants = new Set<string>()
  for (let i = 0; i < occupantCount; i += 1) occupants.add(`c${i}`)
  return {
    roomId: 100,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags,
    occupants,
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

const actor: MoveGateActor = { characterId: 'me' }

// 모든 강제 게이트를 통과하는 중립 입력. 각 리젝트 케이스는 이 위에 한 게이트만 토글한다
// (다층 guard 원칙 — 검증 대상 이전 게이트를 모두 통과시킨다).
function baseInput(over: Partial<MoveGateInput> = {}): MoveGateInput {
  return { exit: makeExit([]), targetRoom: makeRoom([], 0), actor, currentHour: 12, ...over }
}

// ── 건틀릿 전체: 중립 입력 통과 ───────────────────────────────────────────────

describe('evaluateMoveGates — 중립 입력', () => {
  it('강제 게이트에 걸리지 않는 입력은 통과한다', () => {
    expect(evaluateMoveGates(baseInput())).toEqual({ ok: true })
  })
})

// ── 강제 게이트: dangling ─────────────────────────────────────────────────────

describe('dangling 게이트 (1b)', () => {
  it('targetRoom이 undefined면 거부한다', () => {
    const result = evaluateMoveGates(baseInput({ targetRoom: undefined }))
    expect(result).toEqual({ ok: false, reason: '그쪽으로 지도가 없습니다' })
  })

  it('targetRoom이 있으면 통과한다', () => {
    expect(danglingGate(baseInput())).toEqual({ ok: true })
  })
})

// ── 강제 게이트: XLOCKD / XCLOSD ──────────────────────────────────────────────

describe('XLOCKD 게이트 (4)', () => {
  it('잠긴 출구는 거부한다', () => {
    const result = evaluateMoveGates(baseInput({ exit: makeExit([2]) }))
    expect(result).toEqual({ ok: false, reason: '문이 잠겨 있습니다' })
  })

  it('잠기지 않은 출구는 통과한다', () => {
    expect(lockedGate(baseInput())).toEqual({ ok: true })
  })
})

describe('XCLOSD 게이트 (5)', () => {
  it('닫힌 출구는 거부한다', () => {
    const result = evaluateMoveGates(baseInput({ exit: makeExit([3]) }))
    expect(result).toEqual({ ok: false, reason: '문이 닫혀 있습니다' })
  })

  it('닫히지 않은 출구는 통과한다', () => {
    expect(closedGate(baseInput())).toEqual({ ok: true })
  })
})

// ── 강제 게이트: 시간 (XNGHTO / XDAYON) ───────────────────────────────────────

describe('시간 게이트 — XNGHTO 야간전용 (7)', () => {
  const nightExit = () => makeExit([XNGHTO])

  it.each([
    [6, true],
    [7, false],
    [19, false],
    [20, true],
  ])('currentHour=%i → ok=%s', (hour, ok) => {
    const result = timeGate(baseInput({ exit: nightExit(), currentHour: hour }))
    expect(result.ok).toBe(ok)
  })

  it('낮 시간(t=7..19)에 거부 사유를 반환한다', () => {
    const result = evaluateMoveGates(baseInput({ exit: nightExit(), currentHour: 12 }))
    expect(result).toEqual({ ok: false, reason: '그 출구는 밤에만 열려 있습니다' })
  })
})

describe('시간 게이트 — XDAYON 주간전용 (8)', () => {
  const dayExit = () => makeExit([XDAYON])

  it.each([
    [5, false],
    [6, true],
    [20, true],
    [21, false],
  ])('currentHour=%i → ok=%s', (hour, ok) => {
    const result = timeGate(baseInput({ exit: dayExit(), currentHour: hour }))
    expect(result.ok).toBe(ok)
  })

  it('밤 시간(t<=5 또는 t>=21)에 거부 사유를 반환한다', () => {
    const result = evaluateMoveGates(baseInput({ exit: dayExit(), currentHour: 23 }))
    expect(result).toEqual({ ok: false, reason: '그 출구는 밤에는 닫혀 있습니다' })
  })
})

// ── 강제 게이트: 정원 (RONEPL / RTWOPL / RTHREE) ──────────────────────────────

describe('정원 게이트 (17)', () => {
  const OVER = { ok: false, reason: '그 방에 있는 사용자가 너무 많습니다' }

  it('RONEPL: 점유자 0명 통과, 1명 이상 거부', () => {
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RONEPL], 0) }))).toEqual({ ok: true })
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RONEPL], 1) }))).toEqual(OVER)
  })

  it('RTWOPL: 점유자 1명 이하 통과, 2명 이상 거부', () => {
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RTWOPL], 1) }))).toEqual({ ok: true })
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RTWOPL], 2) }))).toEqual(OVER)
  })

  it('RTHREE: 점유자 2명 이하 통과, 3명 이상 거부', () => {
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RTHREE], 2) }))).toEqual({ ok: true })
    expect(evaluateMoveGates(baseInput({ targetRoom: makeRoom([RTHREE], 3) }))).toEqual(OVER)
  })

  it('정원 플래그 없는 방은 점유자가 많아도 통과한다', () => {
    expect(capacityGate(baseInput({ targetRoom: makeRoom([], 9) }))).toEqual({ ok: true })
  })

  it('targetRoom이 undefined면 방어적으로 통과한다(dangling이 선행 거부하므로 도달 불가 경로)', () => {
    expect(capacityGate(baseInput({ targetRoom: undefined }))).toEqual({ ok: true })
  })
})

// ── §3.3 순서 검증 ────────────────────────────────────────────────────────────

describe('건틀릿 순서 (§3.3)', () => {
  it('게이트 순서가 §3.3 표와 일치한다', () => {
    expect(MOVE_GATE_ORDER).toEqual([
      'dangling',
      '침묵',
      '전투',
      'XLOCKD',
      'XCLOSD',
      '비행',
      '시간',
      '경비',
      '성별',
      '무소지',
      '등반',
      '은신',
      '레벨',
      '정원',
      '패거리결혼',
    ])
  })

  it('dangling과 XLOCKD가 동시 성립하면 dangling이 먼저 거부한다', () => {
    const result = evaluateMoveGates(baseInput({ targetRoom: undefined, exit: makeExit([2]) }))
    expect(result).toEqual({ ok: false, reason: '그쪽으로 지도가 없습니다' })
  })
})

// ── stub 게이트: 항상 통과 ────────────────────────────────────────────────────

describe('순서-유지 stub 게이트', () => {
  it('강제 게이트에 안 걸리는 입력은 stub 자리를 지나 통과한다', () => {
    // 비행(XFLYSP=11)·경비(XPGUAR=18) 등 stub 대상 플래그를 세팅해도 거부하지 않는다.
    const result = evaluateMoveGates(baseInput({ exit: makeExit([11, 18]) }))
    expect(result).toEqual({ ok: true })
  })
})

// ── 순수성: 입력 비변형 ───────────────────────────────────────────────────────

describe('게이트 순수성', () => {
  it('evaluateMoveGates는 입력을 변형하지 않는다', () => {
    const room = makeRoom([RTWOPL], 1)
    const exit = makeExit([XNGHTO])
    const input = baseInput({ exit, targetRoom: room, currentHour: 3 })
    const sizeBefore = room.occupants.size
    const exitFlagsBefore = [...exit.flags]
    const roomFlagsBefore = [...room.flags]

    evaluateMoveGates(input)

    expect(room.occupants.size).toBe(sizeBefore)
    expect(exit.flags).toEqual(exitFlagsBefore)
    expect(room.flags).toEqual(roomFlagsBefore)
  })
})
