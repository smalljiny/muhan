import { describe, it, expect, vi } from 'vitest'
import { resolveHpMax, resolveMpMax, type Character } from 'shared'
import { setFlag } from '../world/door.js'
import { regenVitals, createRegenSlot, RHEALR, BARBARIAN, MAGE } from './regen.js'

/**
 * HP/MP 재생 슬롯 테스트 — 원본 player.c:588-604 이식.
 *
 * 두 SUT를 분리해 검증한다:
 *   - `regenVitals`(순수): 입력 char를 변형하지 않고 재생 결과 새 Character를 반환.
 *   - `createRegenSlot`(슬롯): tick 계층 carve-out으로 라이브 char를 in-place 변형하되
 *     markDirty에는 distinct 스냅샷을 넘긴다.
 * 이 둘의 immutability 계약이 상반되므로(순수=무변이, 슬롯=carve-out 변이) 서로 다른 SUT에서 검증한다.
 */

/** 지정 비트들을 세팅한 방 flags(number[] 바이트 배열)를 만든다. */
function roomFlags(...bits: number[]): number[] {
  const flags: number[] = [0, 0]
  for (const b of bits) setFlag(flags, b)
  return flags
}

/** 유효 Character 픽스처. stats=[STR,DEX,CON,INT,PTY]; con=stats[2], int=stats[3]. */
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 4,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    level: 10,
    hpCurrent: 10,
    mpCurrent: 10,
    experience: 0,
    // v5 spell store 시드(빈 지식 비트마스크·realm [0,0,0,0]) — Character required 필드 충족.
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 3,
    accountId: 'acc-1',
    status: 'active',
    ...overrides,
  }
}

/** stats 5-tuple에서 con/int만 오버라이드한다. */
function withStats(con: number, int: number): [number, number, number, number, number] {
  return [10, 10, con, int, 10]
}

describe('regenVitals — 정상 방 재생량', () => {
  it('검사(fighter): con·int 보너스 없음 → hp+5, mp+5', () => {
    // class 4, level 10: hpMax=83, mpMax=54(둘 다 여유). hpGain=max(4,5+0+0)=5, mpGain=5.
    const char = makeChar({ class: 4, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(15)
    expect(result.mpCurrent).toBe(15)
  })

  it('권법가(barbarian=2): hp에 +2 클래스 보너스 + con 보너스 반영 → hp+8', () => {
    // class 2, con=15 → bonusOf(15)=1. hpGain=max(4, 5+1+2)=8. mpGain=max(4,5+0+0)=5.
    expect(BARBARIAN).toBe(2)
    const char = makeChar({ class: 2, level: 20, stats: withStats(15, 10), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(18)
    expect(result.mpCurrent).toBe(15)
  })

  it('도술사(mage=5): mp에 +2 클래스 보너스 + int>17 반영 → mp+8', () => {
    // class 5, int=18(>17 → +1). mpGain=max(4, 5+1+2)=8. hpGain=max(4,5+0+0)=5.
    expect(MAGE).toBe(5)
    const char = makeChar({ class: 5, level: 20, stats: withStats(10, 18), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(15)
    expect(result.mpCurrent).toBe(18)
  })

  it('con 낮음(음수 보너스): MAX(4,…) 바닥이 발동 → hp+4', () => {
    // class 1, con=3 → bonusOf(3)=-3. 5+(-3)+0=2 → max(4,2)=4. mpGain=max(4,5+0+0)=5.
    const char = makeChar({ class: 1, level: 10, stats: withStats(3, 3), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(14)
    expect(result.mpCurrent).toBe(15)
  })

  it('int 경계 17/18: 17은 +0, 18은 +1 (비-도술사에서 int 항 분리)', () => {
    const base = { class: 1, level: 10, hpCurrent: 10, mpCurrent: 10 }
    const int17 = regenVitals(makeChar({ ...base, stats: withStats(10, 17) }), { flags: roomFlags() })
    const int18 = regenVitals(makeChar({ ...base, stats: withStats(10, 18) }), { flags: roomFlags() })
    expect(int17.mpCurrent).toBe(15) // 5+0+0
    expect(int18.mpCurrent).toBe(16) // 5+1+0
  })

  it('입력 char를 변형하지 않는다(순수)', () => {
    const char = makeChar({ class: 4, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const before = structuredClone(char)
    regenVitals(char, { flags: roomFlags() })
    expect(char).toEqual(before)
  })
})

describe('regenVitals — RHEALR 방 +100 진폭', () => {
  it('RHEALR(bit 13) 방: 정상재생 후 hp/mp 각 +100', () => {
    expect(RHEALR).toBe(13)
    // 무적(class 9) level 20: hpMax=438, mpMax=288(둘 다 +100 후에도 여유). hpGain=5, mpGain=5.
    const char = makeChar({ class: 9, level: 20, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags(RHEALR) })
    expect(result.hpCurrent).toBe(115) // 10 + 5 + 100
    expect(result.mpCurrent).toBe(115) // 10 + 5 + 100
  })

  it('순서: 정상재생 → RHEALR+100 → 최종 클램프(최대치 초과 안 함)', () => {
    // class 4 level 10: hpMax=83. 10+5+100=115 → clamp 83. mpMax=54 → 54.
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const result = regenVitals(char, { flags: roomFlags(RHEALR) })
    expect(result.hpCurrent).toBe(resolveHpMax(char))
    expect(result.mpCurrent).toBe(resolveMpMax(char))
  })
})

describe('regenVitals — 최대치 클램프', () => {
  it('이미 최대치면 초과하지 않고 최대치 유지', () => {
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10) })
    const hpMax = resolveHpMax(char)
    const mpMax = resolveMpMax(char)
    const atMax = { ...char, hpCurrent: hpMax, mpCurrent: mpMax }
    const result = regenVitals(atMax, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(hpMax)
    expect(result.mpCurrent).toBe(mpMax)
  })

  it('최대치 근처에서 재생이 초과분을 클램프', () => {
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10) })
    const hpMax = resolveHpMax(char) // 83
    const near = { ...char, hpCurrent: hpMax - 2, mpCurrent: 10 } // 81 + 5 = 86 → clamp 83
    const result = regenVitals(near, { flags: roomFlags() })
    expect(result.hpCurrent).toBe(hpMax)
  })
})

describe('createRegenSlot — 슬롯 계약', () => {
  it('intervalSec===5, name==="regen" (D5: RHEALR /=3 케이던스 가속 미구현)', () => {
    const slot = createRegenSlot({ markDirty: vi.fn() })
    expect(slot.intervalSec).toBe(5)
    expect(slot.name).toBe('regen')
  })

  it('빈 provider(dormant): run이 markDirty를 호출하지 않는다', () => {
    const markDirty = vi.fn()
    const slot = createRegenSlot({ markDirty })
    slot.run(5)
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('RHEALR 방이어도 슬롯 intervalSec은 5로 고정(D5 verify)', () => {
    const char = makeChar({ class: 9, level: 20, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const slot = createRegenSlot({
      players: () => [{ character: char, room: { flags: roomFlags(RHEALR) } }],
      markDirty: vi.fn(),
    })
    expect(slot.intervalSec).toBe(5)
  })
})

describe('createRegenSlot — markDirty 스냅샷 계약 + carve-out', () => {
  it('재생 후 markDirty가 distinct 스냅샷(재생값 반영)으로 호출', () => {
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    let captured: unknown
    const markDirty = vi.fn((_collection: string, _id: string, snapshot: unknown) => {
      captured = snapshot
    })
    const slot = createRegenSlot({
      players: () => [{ character: char, room: { flags: roomFlags() } }],
      markDirty,
    })
    slot.run(5)

    expect(markDirty).toHaveBeenCalledWith('characters', 'char-1', expect.anything())
    const snap = captured as Character
    // 스냅샷은 재생값을 담는다(stale 아님).
    expect(snap.hpCurrent).toBe(15)
    expect(snap.mpCurrent).toBe(15)
    // 스냅샷은 라이브 char와 distinct 참조다.
    expect(snap).not.toBe(char)
  })

  it('스냅샷은 이후 라이브 char 변이에 영향받지 않는다(distinct 참조)', () => {
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    let captured: unknown
    const markDirty = vi.fn((_collection: string, _id: string, snapshot: unknown) => {
      captured = snapshot
    })
    const slot = createRegenSlot({
      players: () => [{ character: char, room: { flags: roomFlags() } }],
      markDirty,
    })
    slot.run(5)
    const snap = captured as Character
    const snapHpBefore = snap.hpCurrent
    // 라이브 char를 이후 변이해도 스냅샷은 불변.
    char.hpCurrent = 999
    expect(snap.hpCurrent).toBe(snapHpBefore)
  })

  it('carve-out: 슬롯 run이 라이브 char를 in-place 갱신(누적 baseline)', () => {
    const char = makeChar({ class: 4, level: 10, stats: withStats(10, 10), hpCurrent: 10, mpCurrent: 10 })
    const slot = createRegenSlot({
      players: () => [{ character: char, room: { flags: roomFlags() } }],
      markDirty: vi.fn(),
    })
    slot.run(5)
    expect(char.hpCurrent).toBe(15)
    expect(char.mpCurrent).toBe(15)
  })
})
