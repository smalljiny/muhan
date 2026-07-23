import { describe, it, expect } from 'vitest'
import { resolveHpMax, type Character, type RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import { resolvePlayerDot } from './dot.js'
import { RPHARM, RPPOIS, RPMPDR, RPBEFU, REARTH, RFIRER } from '../world/roomFlags.js'

/**
 * dot.ts — 플레이어 DoT resolver(player.c:578~730 damage-only 이식) 테스트.
 *
 * 결정적 rng·now 주입으로 오라클 공식(독 hpmax/5·질병 dice·위험방 8-MIN(con,2))을 검증하고,
 * xor 계약 입력 dotApplied·died 반환·immutability를 확정한다. 재생 분기·realm 저항 게이트는
 * 미이식(#99 유예)이므로 이식된 damage 경로만 검증한다.
 */

const NOW = 1000

/** 지정 비트를 세팅한 8바이트(64비트) room.flags number[]를 만든다. */
function flagsWith(...bits: number[]): number[] {
  const arr = new Array<number>(8).fill(0)
  for (const bit of bits) {
    const idx = Math.floor(bit / 8)
    arr[idx] = (arr[idx] ?? 0) | (1 << bit % 8)
  }
  return arr
}

/** 최소 RoomNode shape(flags만 의미) — DoT resolver는 room.flags만 읽는다. */
function makeRoom(flags: number[]): RoomNode {
  return {
    roomId: 1,
    name: '',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags,
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

/** con 보너스 1(stats[2]=16)·class4·level7 기준 캐릭터. hpCurrent/mpCurrent·statusEffects는 override. */
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '테스토스',
    class: 4,
    race: 1,
    stats: [16, 18, 16, 10, 14],
    gold: 0,
    currentRoom: 1,
    hpCurrent: 50,
    mpCurrent: 20,
    level: 7,
    experience: 0,
    schemaVersion: 2,
    accountId: 'acct-1',
    status: 'active',
    ...overrides,
  }
}

/** 활성 poison(until>now). */
const ACTIVE_POISON = { poison: { until: NOW + 100, interval: 30 } }
/** 활성 disease(until>now). */
const ACTIVE_DISEASE = { disease: { until: NOW + 100, interval: 20 } }

/** 고정 roll을 반환하고 (min,max) 호출 인자를 기록하는 rng 스텁. */
function fixedRng(roll: number, calls: Array<[number, number]> = []): CombatRng {
  return (min, max) => {
    calls.push([min, max])
    return roll
  }
}

describe('resolvePlayerDot', () => {
  it('비-harm 방에서 활성 독은 MAX(1, rng(1,trunc(hpmax/5)) - con) 만큼 hp를 차감한다', () => {
    const char = makeChar({ hpCurrent: 50, statusEffects: ACTIVE_POISON })
    const room = makeRoom(flagsWith())
    const calls: Array<[number, number]> = []
    // con bonus(stats[2]=16)=1. roll=10 → damage = MAX(1, 10-1) = 9.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10, calls), now: NOW })

    expect(result.character.hpCurrent).toBe(41)
    expect(result.died).toBe(false)
    expect(result.dotApplied).toBe(true)
    // 독 공식은 hpmax/5를 max 인자로 쓴다(단일화된 공식).
    const expectedMax = Math.trunc(resolveHpMax(char) / 5)
    expect(calls[0]).toEqual([1, expectedMax])
  })

  it('비-harm 방에서 활성 질병은 MAX(1, rng(1,6) - con) 만큼 hp를 차감한다', () => {
    const char = makeChar({ hpCurrent: 50, statusEffects: ACTIVE_DISEASE })
    const room = makeRoom(flagsWith())
    const calls: Array<[number, number]> = []
    // roll=5 → damage = MAX(1, 5-1) = 4.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(5, calls), now: NOW })

    expect(result.character.hpCurrent).toBe(46)
    expect(result.dotApplied).toBe(true)
    expect(calls[0]).toEqual([1, 6])
  })

  it('독·질병이 동시 활성이면 두 피해가 모두 누적된다', () => {
    const char = makeChar({
      hpCurrent: 50,
      statusEffects: { ...ACTIVE_POISON, ...ACTIVE_DISEASE },
    })
    const room = makeRoom(flagsWith())
    // roll=5 → 독 MAX(1,5-1)=4, 질병 MAX(1,5-1)=4 → 50-8=42.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(5), now: NOW })

    expect(result.character.hpCurrent).toBe(42)
    expect(result.dotApplied).toBe(true)
  })

  it('비-harm 방에서 병들지 않았으면 hp 변화·dotApplied 없음(재생 미이식)', () => {
    const char = makeChar({ hpCurrent: 30 })
    const room = makeRoom(flagsWith())
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(30)
    expect(result.died).toBe(false)
    expect(result.dotApplied).toBe(false)
  })

  it('MAX(1,...) 하한 — con 보너스가 roll을 상쇄해도 최소 1 피해', () => {
    const char = makeChar({ hpCurrent: 50, statusEffects: ACTIVE_POISON })
    const room = makeRoom(flagsWith())
    // roll=1, con=1 → 1-1=0 → MAX(1,0)=1.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(1), now: NOW })

    expect(result.character.hpCurrent).toBe(49)
    expect(result.dotApplied).toBe(true)
  })

  it('만료된 독(until<now)은 비활성 — 비-harm 방에서 피해 없음', () => {
    const char = makeChar({
      hpCurrent: 40,
      statusEffects: { poison: { until: NOW - 1, interval: 30 } },
    })
    const room = makeRoom(flagsWith())
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(40)
    expect(result.dotApplied).toBe(false)
  })

  it('RPHARM+RPPOIS 방은 이전 독이 없어도 이번 틱 독 피해를 준다(독 source)', () => {
    const char = makeChar({ hpCurrent: 50 })
    const room = makeRoom(flagsWith(RPHARM, RPPOIS))
    const calls: Array<[number, number]> = []
    // roll=10, con=1 → MAX(1,10-1)=9 → 50-9=41. rng는 hpmax/5 max로 호출.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10, calls), now: NOW })

    expect(result.character.hpCurrent).toBe(41)
    expect(result.dotApplied).toBe(true)
    const expectedMax = Math.trunc(resolveHpMax(char) / 5)
    expect(calls[0]).toEqual([1, expectedMax])
  })

  it('RPHARM+RPMPDR 방은 mp를 MIN(mpCurrent,3) 드레인한다', () => {
    const char = makeChar({ hpCurrent: 50, mpCurrent: 20 })
    const room = makeRoom(flagsWith(RPHARM, RPMPDR))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.mpCurrent).toBe(17)
    expect(result.dotApplied).toBe(true)
    // RPMPDR·RPPOIS·RPBEFU 중 하나라도 있으면 무형 생명력 흡수는 발동 안 함.
    expect(result.character.hpCurrent).toBe(50)
  })

  it('RPHARM+RPMPDR에서 mp가 0이면 실차감 0 → dotApplied false', () => {
    const char = makeChar({ hpCurrent: 50, mpCurrent: 0 })
    const room = makeRoom(flagsWith(RPHARM, RPMPDR))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.mpCurrent).toBe(0)
    expect(result.dotApplied).toBe(false)
  })

  it('RPHARM+realm(RFIRER) 방은 8-MIN(con,2) 무저항 피해(저항 게이트 #99 유예)', () => {
    const char = makeChar({ hpCurrent: 50 })
    const room = makeRoom(flagsWith(RPHARM, RFIRER))
    // con bonus 1 → 8 - MIN(1,2) = 7 → 50-7=43.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(43)
    expect(result.dotApplied).toBe(true)
  })

  it('RPHARM 단독(하위 플래그 없음) 방은 무형 생명력 흡수 8-MIN(con,2)', () => {
    const char = makeChar({ hpCurrent: 50 })
    const room = makeRoom(flagsWith(RPHARM))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(43)
    expect(result.dotApplied).toBe(true)
  })

  it('무형 흡수의 con 상한 — 높은 con(보너스 7)에서도 MIN(con,2)로 캡되어 8-2=6 피해', () => {
    // stats[2]=44 → bonusOf(44)=7. 8 - MIN(7,2) = 8-2 = 6 → 50-6=44.
    const char = makeChar({ hpCurrent: 50, stats: [16, 18, 44, 10, 14] })
    const room = makeRoom(flagsWith(RPHARM))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(44)
    expect(result.dotApplied).toBe(true)
  })

  it('trap: realm 플래그(REARTH)만 있고 RPHARM 없으면 realm 피해 없음', () => {
    const char = makeChar({ hpCurrent: 50 })
    const room = makeRoom(flagsWith(REARTH))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(50)
    expect(result.dotApplied).toBe(false)
  })

  it('RPBEFU 쿨다운은 Character 반환 범위 밖 — hp/mp 무변화(combat-state #99)', () => {
    const char = makeChar({ hpCurrent: 50, mpCurrent: 20 })
    const room = makeRoom(flagsWith(RPHARM, RPBEFU))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    // RPBEFU만 있는 harm 방: 독·질병 비활성, RPMPDR 없음, RPBEFU가 무형 흡수 조건을 막음.
    expect(result.character.hpCurrent).toBe(50)
    expect(result.character.mpCurrent).toBe(20)
    expect(result.dotApplied).toBe(false)
  })

  it('DoT로 hp<1이면 died=true·hpCurrent는 0으로 클램프', () => {
    const char = makeChar({ hpCurrent: 5, statusEffects: ACTIVE_POISON })
    const room = makeRoom(flagsWith())
    // roll=10, con=1 → 9 피해 → 5-9=-4 → 클램프 0, died=true.
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(result.character.hpCurrent).toBe(0)
    expect(result.died).toBe(true)
    expect(result.dotApplied).toBe(true)
  })

  it('입력 Character를 변형하지 않고 새 참조를 반환한다(immutability)', () => {
    const char = makeChar({ hpCurrent: 50, mpCurrent: 20, statusEffects: ACTIVE_POISON })
    const room = makeRoom(flagsWith(RPHARM, RPMPDR))
    const result = resolvePlayerDot(char, room, { rng: fixedRng(10), now: NOW })

    expect(char.hpCurrent).toBe(50)
    expect(char.mpCurrent).toBe(20)
    expect(result.character).not.toBe(char)
  })
})
