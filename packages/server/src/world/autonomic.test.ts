import { describe, it, expect } from 'vitest'
import type { CreatureInstance, ItemInstance, RoomNode } from 'shared'
import { runAutonomic, alwaysFireRng, neverFireRng, type AutonomicRng } from './autonomic.js'
import { F_ISSET, F_SET, MSCAVE, MHASSC, MPERMT, MDMFOL, MBEFUD, MCHARM } from './hexFlags.js'

function makeCreature(over: Partial<CreatureInstance> = {}): CreatureInstance {
  return {
    instanceId: '1:c0',
    templateId: null,
    name: '몬스터',
    level: 1,
    hpmax: 100,
    hpcur: 100,
    mpmax: 60,
    mpcur: 60,
    dexterity: 14,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    flags: '0000000000000000',
    enemies: [],
    inventory: [],
    ...over,
  }
}

function makeItem(name: string, flags: string): ItemInstance {
  return { instanceId: `1:${name}`, name, description: '', value: 1, flags, contains: [] }
}

function makeRoom(over: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 1,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set(['p1']),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
    ...over,
  }
}

const ctx = (over: { now?: number; activatedAt?: number; room?: RoomNode; rng?: AutonomicRng } = {}) => ({
  now: over.now ?? 1000,
  activatedAt: over.activatedAt ?? 0,
  room: over.room ?? makeRoom(),
  rng: over.rng ?? neverFireRng,
})

describe('runAutonomic — 순수 함수(입력 미변형)', () => {
  it('입력 크리처를 in-place 변형하지 않고 새 상태를 반환한다', () => {
    const c = makeCreature({ hpcur: 10, lastRegenAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(c.hpcur).toBe(10) // 입력 불변
    expect(result.creature).not.toBe(c)
    expect(result.creature.hpcur).toBeGreaterThan(10)
  })
})

describe('§3.1 MBEFUD/MCHARM 만료 (오라클 stale-scrub — undefined 타이머=LT 0=과거)', () => {
  it('MBEFUD이고 befuddledUntil<now면 MBEFUD를 클리어한다', () => {
    const c = makeCreature({ flags: F_SET('0000000000000000', MBEFUD), befuddledUntil: 500 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MBEFUD)).toBe(false)
  })
  it('befuddledUntil 미설정(스폰 stale 비트)이면 MBEFUD를 스크럽한다(오라클 update.c:258 무가드, LT=0<t)', () => {
    // 오라클: lasttime[LT_BEFUD]=0 → LT=0 < t → tick 1에서 무조건 클리어. undefined=활성 상태이상 없음.
    const c = makeCreature({ flags: F_SET('0000000000000000', MBEFUD) })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MBEFUD)).toBe(false)
  })
  it('활성 befud 타이머(now<befuddledUntil)면 MBEFUD를 유지한다(E6 상태이상 seam)', () => {
    const c = makeCreature({ flags: F_SET('0000000000000000', MBEFUD), befuddledUntil: 2000 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MBEFUD)).toBe(true)
  })
  it('MCHARM이고 now>charmedUntil이면 MCHARM을 클리어한다', () => {
    const c = makeCreature({ flags: F_SET('0000000000000000', MCHARM), charmedUntil: 500 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MCHARM)).toBe(false)
  })
  it('charmedUntil 미설정(스폰 stale 비트)이면 MCHARM을 스크럽한다(오라클 update.c:277, LT=0<t)', () => {
    const c = makeCreature({ flags: F_SET('0000000000000000', MCHARM) })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MCHARM)).toBe(false)
  })
  it('활성 charm 타이머(now<charmedUntil)면 MCHARM을 유지한다(E6 주문 seam)', () => {
    const c = makeCreature({ flags: F_SET('0000000000000000', MCHARM), charmedUntil: 2000 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(F_ISSET(result.creature.flags, MCHARM)).toBe(true)
  })
})

describe('§3.2 재생(HEALS) — 60초마다 HP+max(1,hpmax/10)·MP+max(1,mpmax/6)', () => {
  it('만신이면 재생하지 않는다', () => {
    const c = makeCreature({ hpcur: 100, mpcur: 60, lastRegenAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000 }))
    expect(result.creature.hpcur).toBe(100)
    expect(result.creature.lastRegenAt).toBe(0) // 미적용
  })

  it('밀린 주기를 while 루프로 소급 적용한다(활성 내내, activatedAt=0)', () => {
    // lastRegenAt=0, activatedAt=0, now=180 → due 60·120·180 3회. HP 10*3=30, MP 10*3=30.
    const c = makeCreature({ hpcur: 1, mpcur: 1, lastRegenAt: 0 })
    const result = runAutonomic(c, ctx({ now: 180, activatedAt: 0 }))
    expect(result.creature.hpcur).toBe(31) // 1 + 10 + 10 + 10
    expect(result.creature.mpcur).toBe(31) // 1 + 10 + 10 + 10
    expect(result.creature.lastRegenAt).toBe(180)
  })

  it('hpmax/mpmax를 넘겨 클램프한다', () => {
    const c = makeCreature({ hpmax: 100, hpcur: 95, mpmax: 60, mpcur: 55, lastRegenAt: 0 })
    const result = runAutonomic(c, ctx({ now: 60 }))
    expect(result.creature.hpcur).toBe(100) // 95+10 클램프
    expect(result.creature.mpcur).toBe(60) // 55+10 클램프
  })

  it('빈 방=시간 정지 — 동결 구간을 소급하지 않는다(baseline=max(lastRegenAt+60, activatedAt))', () => {
    // lastRegenAt=0(t=0에 스폰), 방 t=30~1000 동결 후 activatedAt=1000 재활성, now=1000.
    // 소급 없으면: due=max(60,1000)=1000 → 1회만. 소급되면 ~16회(잘못).
    const c = makeCreature({ hpcur: 1, mpcur: 1, lastRegenAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, activatedAt: 1000 }))
    expect(result.creature.hpcur).toBe(11) // 1 + 10 (단 1회, 동결 구간 미소급)
  })

  it('lastRegenAt 미설정이면 activatedAt을 기준으로 삼는다', () => {
    const c = makeCreature({ hpcur: 1, mpcur: 1 }) // lastRegenAt undefined
    // activatedAt=0 → due=60·120 (now=120) 2회
    const result = runAutonomic(c, ctx({ now: 120, activatedAt: 0 }))
    expect(result.creature.hpcur).toBe(21) // 1 + 10 + 10
  })
})

describe('§3.3 scavenge — MSCAVE·20초↑·15%·바닥 첫 회수가능 아이템', () => {
  it('MSCAVE·20초 경과·rng 통과·회수가능 아이템이면 줍고 MHASSC 세팅한다', () => {
    const item = makeItem('금화', '0000000000000000')
    const room = makeRoom({ items: [item] })
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.scavenge).toEqual({ itemIndex: 0 })
    expect(F_ISSET(result.creature.flags, MHASSC)).toBe(true)
  })

  it('제외 flag(OPERMT 등)를 가진 아이템은 줍지 않는다', () => {
    const item = makeItem('돈주머니', '0300000000000000') // OPERMT|OHIDDN
    const room = makeRoom({ items: [item] })
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.scavenge).toBeUndefined()
    expect(F_ISSET(result.creature.flags, MHASSC)).toBe(false)
  })

  it('20초↑ 경과 시 조건 무관하게 lastScavengeAt=now로 리셋한다', () => {
    const room = makeRoom({ items: [] }) // 아이템 없어 scavenge 실패
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.scavenge).toBeUndefined()
    expect(result.creature.lastScavengeAt).toBe(1000)
  })

  it('20초 미경과면 scavenge 게이트를 통과하지 않는다', () => {
    const item = makeItem('금화', '0000000000000000')
    const room = makeRoom({ items: [item] })
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 990 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.scavenge).toBeUndefined()
    expect(result.creature.lastScavengeAt).toBe(990) // 미리셋
  })

  it('rng가 15 초과면 아이템이 있어도 줍지 않는다(확률 실패)', () => {
    const item = makeItem('금화', '0000000000000000')
    const room = makeRoom({ items: [item] })
    const c = makeCreature({ flags: F_SET('0000000000000000', MSCAVE), lastScavengeAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: neverFireRng }))
    expect(result.scavenge).toBeUndefined()
  })
})

describe('§3.4 wander-out — 배회 크리처·적 없음·확률=traffic·소멸', () => {
  it('!MHASSC·!MPERMT·!MDMFOL·20초↑·rng≤traffic·적 없음이면 wanderOut', () => {
    const room = makeRoom({ traffic: 100 })
    const c = makeCreature({ lastWanderAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.wanderOut).toBe(true)
  })

  it('적이 있으면 wander-out 하지 않는다', () => {
    const room = makeRoom({ traffic: 100 })
    const c = makeCreature({ lastWanderAt: 0, enemies: ['player1'] })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.wanderOut).toBe(false)
  })

  it('MPERMT는 wander-out 제외(고정 몬스터)', () => {
    const room = makeRoom({ traffic: 100 })
    const c = makeCreature({ flags: F_SET('0000000000000000', MPERMT), lastWanderAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.wanderOut).toBe(false)
  })

  it('MDMFOL는 wander-out 제외(DM 추종)', () => {
    const room = makeRoom({ traffic: 100 })
    const c = makeCreature({ flags: F_SET('0000000000000000', MDMFOL), lastWanderAt: 0 })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.wanderOut).toBe(false)
  })

  it('rng > traffic이면 wander-out 하지 않는다(확률 실패)', () => {
    const room = makeRoom({ traffic: 10 })
    const c = makeCreature({ lastWanderAt: 0 })
    // rng가 50 반환 → 50 <= 10 실패
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: () => 50 }))
    expect(result.wanderOut).toBe(false)
  })

  it('방금 scavenge로 MHASSC가 세팅되면 같은 틱 wander-out에서 제외된다', () => {
    const item = makeItem('금화', '0000000000000000')
    const room = makeRoom({ items: [item], traffic: 100 })
    const c = makeCreature({
      flags: F_SET('0000000000000000', MSCAVE),
      lastScavengeAt: 0,
      lastWanderAt: 0,
    })
    const result = runAutonomic(c, ctx({ now: 1000, room, rng: alwaysFireRng }))
    expect(result.scavenge).toEqual({ itemIndex: 0 })
    expect(result.wanderOut).toBe(false) // MHASSC 세팅으로 제외
  })
})
