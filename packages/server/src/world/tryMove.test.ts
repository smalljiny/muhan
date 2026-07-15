import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExitEdge, RoomNode } from 'shared'
import { setFlag, XLOCKD, XNOSEE } from './door.js'
import { RONEPL } from './moveGates.js'
import {
  tryMove,
  chooseFleeExit,
  defaultFleeRng,
  type MoveActor,
  type TryMoveDeps,
} from './tryMove.js'

// ── 테스트 픽스처 팩토리 ──────────────────────────────────────────────────────

// 출구 엣지(4바이트=32비트 flags). name·targetRoomId·세팅 비트만 지정.
function makeExit(name: string, targetRoomId: number, bits: number[] = []): ExitEdge {
  const flags = [0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return { name, targetRoomId, flags, key: 0, ltime: 0, interval: 60 }
}

// 방(8바이트=64비트 flags). exits·점유자·세팅 비트를 지정.
function makeRoom(
  roomId: number,
  exits: ExitEdge[],
  occupantIds: string[] = [],
  bits: number[] = [],
): RoomNode {
  const flags = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return {
    roomId,
    name: `방${roomId}`,
    shortDesc: '',
    longDesc: '',
    exits,
    items: [],
    flags,
    occupants: new Set(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

// deps 조립기 — 방 Map + 호출 로그를 가진 fake 방송/시각/rng seam을 주입한다.
function makeDeps(rooms: RoomNode[], currentHour = 12) {
  const graph = new Map<number, RoomNode>()
  for (const room of rooms) graph.set(room.roomId, room)

  // 호출 순서·시점 스냅샷을 기록하는 공유 로그.
  const log: Array<{ event: 'leave' | 'join'; room: number; hasActor: boolean }> = []

  const deps: TryMoveDeps = {
    resolveRoom: (roomId) => graph.get(roomId),
    currentHour: () => currentHour,
    broadcastLeave: vi.fn((room: RoomNode, a: MoveActor) => {
      // leave 시점: actor는 아직 출발 방 점유자여야 한다(재배치 前).
      log.push({ event: 'leave', room: room.roomId, hasActor: room.occupants.has(a.characterId) })
    }),
    broadcastJoin: vi.fn((room: RoomNode, a: MoveActor) => {
      // join 시점: actor는 이미 도착 방 점유자여야 한다(재배치 後).
      log.push({ event: 'join', room: room.roomId, hasActor: room.occupants.has(a.characterId) })
    }),
    onRoomEntered: vi.fn(),
    rng: defaultFleeRng,
  }
  return { deps, graph, log }
}

// ── chooseFleeExit (순수 함수) ────────────────────────────────────────────────

describe('chooseFleeExit', () => {
  it('빈 visibleExits면 undefined를 반환한다', () => {
    expect(chooseFleeExit([], defaultFleeRng)).toBeUndefined()
  })

  it('기본 결정적 rng는 첫 가시 출구를 선택한다', () => {
    const a = makeExit('동', 200)
    const b = makeExit('서', 300)
    expect(chooseFleeExit([a, b], defaultFleeRng)).toBe(a)
  })

  it('주입 rng chooser로 선택을 위임한다(seam)', () => {
    const a = makeExit('동', 200)
    const b = makeExit('서', 300)
    const pickLast = (exits: readonly ExitEdge[]) => exits[exits.length - 1]
    expect(chooseFleeExit([a, b], pickLast)).toBe(b)
  })
})

// ── tryMove — mode별 출구 해석 ────────────────────────────────────────────────

describe('tryMove 출구 해석', () => {
  it('source room을 actor.currentRoomId로 해석하지 못하면 거부한다', () => {
    const { deps } = makeDeps([])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 999 }
    const result = tryMove(deps, actor, '동', 'directional')
    expect(result.ok).toBe(false)
  })

  it.each(['directional', 'named', 'sneak'] as const)(
    '%s mode는 이름/방향으로 출구를 선형 탐색해 target으로 이동한다',
    (mode) => {
      const target = makeRoom(200, [])
      const source = makeRoom(100, [makeExit('동', 200)], ['me'])
      const { deps } = makeDeps([source, target])
      const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
      const result = tryMove(deps, actor, '동', mode)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.arrivedRoom.roomId).toBe(200)
    },
  )

  it('일치하는 출구가 없으면 "길이 막혀 있습니다"로 거부한다', () => {
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeDeps([source, makeRoom(200, [])])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '서', 'named')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('길이 막혀 있습니다')
  })

  it('XNOSEE 출구는 이름/방향 탐색에서 제외되어 이름 이동이 거부된다(6번째 강제 게이트)', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('비밀문', 200, [XNOSEE])], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '비밀문', 'named')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('길이 막혀 있습니다')
  })

  it('flee mode는 chooseFleeExit로 가시 출구를 선택해 이동한다', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '', 'flee')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.arrivedRoom.roomId).toBe(200)
  })

  it('flee mode는 XNOSEE 출구를 가시 후보에서 제외한다', () => {
    // 유일 출구가 XNOSEE라 가시 후보가 비어 flee가 거부된다.
    const source = makeRoom(100, [makeExit('비밀문', 200, [XNOSEE])], ['me'])
    const { deps } = makeDeps([source, makeRoom(200, [])])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '', 'flee')
    expect(result.ok).toBe(false)
  })

  it('target을 exit.targetRoomId로 해석한다', () => {
    const target = makeRoom(555, [])
    const source = makeRoom(100, [makeExit('동', 555)], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '동', 'directional')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.arrivedRoom.roomId).toBe(555)
  })
})

// ── tryMove — 통과 시 재배치 + 방송 ──────────────────────────────────────────

describe('tryMove 통과 시 재배치·방송', () => {
  it('점유자를 old.delete/new.add로 재배치한다', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200)], ['me', 'other'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    tryMove(deps, actor, '동', 'directional')
    expect(source.occupants.has('me')).toBe(false)
    expect(source.occupants.has('other')).toBe(true)
    expect(target.occupants.has('me')).toBe(true)
  })

  it('broadcastLeave→(재배치)→broadcastJoin 순서로 호출하고, 방송 시점 점유가 정확하다', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps, log } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    tryMove(deps, actor, '동', 'directional')
    expect(log).toEqual([
      { event: 'leave', room: 100, hasActor: true }, // leave 시점: 아직 출발 방에 있다
      { event: 'join', room: 200, hasActor: true }, // join 시점: 이미 도착 방에 있다
    ])
    expect(deps.broadcastLeave).toHaveBeenCalledTimes(1)
    expect(deps.broadcastJoin).toHaveBeenCalledTimes(1)
  })

  it('통과 시 onRoomEntered entry-hook을 도착 방·actor로 join 직후 1회 호출한다', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    tryMove(deps, actor, '동', 'directional')
    expect(deps.onRoomEntered).toHaveBeenCalledTimes(1)
    expect(deps.onRoomEntered).toHaveBeenCalledWith(target, actor)
    // entry-hook 호출 시점: actor는 이미 도착 방 점유자다(join 경로).
    expect(target.occupants.has('me')).toBe(true)
  })

  it('거부 시 onRoomEntered를 호출하지 않는다(무변경)', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200, [XLOCKD])], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    tryMove(deps, actor, '동', 'directional')
    expect(deps.onRoomEntered).not.toHaveBeenCalled()
  })
})

// ── tryMove — 거부 시 무변경 ─────────────────────────────────────────────────

describe('tryMove 게이트 거부 시 무변경', () => {
  it('XLOCKD 출구는 이동 취소 — 점유자·방송 불변', () => {
    const target = makeRoom(200, [])
    const source = makeRoom(100, [makeExit('동', 200, [XLOCKD])], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '동', 'directional')
    expect(result.ok).toBe(false)
    expect(source.occupants.has('me')).toBe(true)
    expect(target.occupants.size).toBe(0)
    expect(deps.broadcastLeave).not.toHaveBeenCalled()
    expect(deps.broadcastJoin).not.toHaveBeenCalled()
  })

  it('dangling 대상(그래프에 없음)은 이동 취소 — 무변경', () => {
    const source = makeRoom(100, [makeExit('동', 777)], ['me'])
    const { deps } = makeDeps([source])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '동', 'directional')
    expect(result.ok).toBe(false)
    expect(source.occupants.has('me')).toBe(true)
    expect(deps.broadcastLeave).not.toHaveBeenCalled()
  })

  it('flee도 공유 게이트 건틀릿을 거친다 — 정원 초과 시 이동 취소', () => {
    // flee가 가시 출구를 해석하지만 도착 방 정원 초과 → 공유 건틀릿이 거부.
    // (원본 flee는 패닉 이동이나 게이트를 건너뛰지 않음 — 4개 mode가 단일 본체 공유 검증)
    const target = makeRoom(200, [], ['resident'], [RONEPL])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '', 'flee')
    expect(result.ok).toBe(false)
    expect(source.occupants.has('me')).toBe(true)
    expect(target.occupants.has('me')).toBe(false)
    expect(deps.broadcastLeave).not.toHaveBeenCalled()
  })

  it('정원 초과(RONEPL 방에 이미 1명) 시 이동 취소 — 무변경', () => {
    const target = makeRoom(200, [], ['resident'], [RONEPL])
    const source = makeRoom(100, [makeExit('동', 200)], ['me'])
    const { deps } = makeDeps([source, target])
    const actor: MoveActor = { characterId: 'me', currentRoomId: 100 }
    const result = tryMove(deps, actor, '동', 'directional')
    expect(result.ok).toBe(false)
    expect(source.occupants.has('me')).toBe(true)
    expect(target.occupants.has('me')).toBe(false)
    expect(deps.broadcastLeave).not.toHaveBeenCalled()
  })
})

// ── flag-52 latent bug 비재현 (구조적 확인) ──────────────────────────────────

describe('flag-52 latent bug 비재현', () => {
  it('tryMove.ts 실행 코드에 상수 52·flag 52 검사가 존재하지 않는다', () => {
    const src = readFileSync(fileURLToPath(new URL('./tryMove.ts', import.meta.url)), 'utf8')
    // A4 §8 경고: F_ISSET(ext, 52)는 4바이트 exit flags 범위 밖 접근 → 재도입 방지.
    // 주석(오라클 경고 문서)은 52를 의도적으로 언급하므로 실행 코드만 검사한다:
    // 블록 주석(/* */)과 라인 주석(//)을 제거한 뒤 남은 코드에 리터럴 52가 없어야 한다.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/\b52\b/)
  })
})
