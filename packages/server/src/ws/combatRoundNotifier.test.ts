import { afterEach, describe, expect, it, vi } from 'vitest'
import { serverEventSchema, type RoomNode, type ServerEvent } from 'shared'
import type { AttackOutcome, CombatRoundReport } from '../combat/index.js'
import { createCombatRegistry } from '../combat/combatRegistry.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import { DEFAULT_REVIVE_ROOM } from '../progression/death.js'
import { makeCharacter } from '../world/characterFixtures.testutil.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { makeCreature, makeRoom } from '../world/roomFixtures.testutil.js'
import { createPresenceBroadcaster } from './presenceBroadcaster.js'
import { characterStatsEvent } from './characterStatsEvent.js'
import { createCombatRoundNotifier, type CombatRoundNotifierDeps } from './combatRoundNotifier.js'

/**
 * 라운드 통지기 — 보고서 하나를 받아 스펙 §3.4 1~5단계 순서로 되쓰기와 전송을 수행한다.
 * 전송 spy 하나가 `combat:round`·`character:stats`·`world:room`·presence를 모두 받으므로(presence 방송기는
 * 실물이고 같은 spy로 보낸다) 수신자별 이벤트 순서를 배열 하나로 단언한다.
 */

const FIGHT_ROOM = 50
const NAMES: Record<string, string> = {
  t1: '표적',
  c1: '반격자',
  x1: '기여자',
  o1: '구경꾼',
  r1: '부활방손님',
}

function makeOutcome(overrides: Partial<AttackOutcome> = {}): AttackOutcome {
  return {
    hit: true,
    damage: 5,
    critical: false,
    fumble: false,
    died: false,
    specialAttack: null,
    messageInputs: { attacks: [] },
    ...overrides,
  }
}

function makeState(characterId: string, hpCurrent: number, mpCurrent: number): PlayerCombatState {
  return {
    characterId,
    hpCurrent,
    mpCurrent,
    level: 7,
    class: 4,
    effectiveStrength: 16,
    effectiveIntelligence: 10,
    armor: 5,
    thaco: 18,
    dexterity: 18,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    flags: '0'.repeat(16),
    alignment: 1,
    weapon: null,
    nextAttackAt: 0,
  }
}

function setup(rooms: readonly RoomNode[]) {
  const liveRegistry = createLiveCharacterRegistry()
  const combatRegistry = createCombatRegistry()
  const sent: Array<{ to: string; event: ServerEvent }> = []
  const sendToCharacter = vi.fn((to: string, event: ServerEvent) => {
    sent.push({ to, event })
  })
  const logger = { warn: vi.fn(), error: vi.fn() }
  const resolveCharacterName = (id: string): string | undefined => NAMES[id]
  const roomsById = new Map(rooms.map((room) => [room.roomId, room]))
  const awarded = { ids: new Set<string>() }
  const deps = {
    liveRegistry,
    combatRegistry,
    markCharacterDirty: vi.fn(),
    sendToCharacter,
    resolveRoomById: (roomId: number) => roomsById.get(roomId),
    resolveCharacterName,
    presence: createPresenceBroadcaster({
      resolveCharacterName,
      resolveActorFlags: () => '',
      sendToCharacter: (to, event) => sendToCharacter(to, event),
      logger,
    }),
    awardedPlayerIds: () => awarded.ids,
    logger,
  } satisfies CombatRoundNotifierDeps
  /** 라이브 문서와 전투상태를 함께 등록한다. */
  const place = (id: string, doc: { hp: number; mp: number; exp?: number; room?: number }) => {
    liveRegistry.register({
      character: makeCharacter({
        _id: id,
        name: NAMES[id],
        hpCurrent: doc.hp,
        mpCurrent: doc.mp,
        experience: doc.exp ?? 0,
        currentRoom: doc.room ?? FIGHT_ROOM,
      }),
      inventory: [],
    })
  }
  const order = () => sent.map(({ to, event }) => `${event.type}>${to}`)
  return { deps, liveRegistry, combatRegistry, sent, logger, awarded, place, order }
}

function fightRoom(...occupants: string[]): RoomNode {
  return makeRoom({ roomId: FIGHT_ROOM, occupants: new Set(occupants) })
}

function reviveRoom(...occupants: string[]): RoomNode {
  return makeRoom({ roomId: DEFAULT_REVIVE_ROOM, name: '부활의 방', occupants: new Set(occupants) })
}

function makeReport(room: RoomNode, overrides: Partial<CombatRoundReport> = {}): CombatRoundReport {
  return {
    creature: makeCreature('m1', '고블린'),
    room,
    targetId: 't1',
    incoming: { kind: 'melee', outcome: makeOutcome({ damage: 20 }) },
    counters: [],
    monsterDied: false,
    playerDeaths: [],
    statsBefore: new Map([['t1', { hpCurrent: 50, mpCurrent: 10 }]]),
    ...overrides,
  }
}

describe('createCombatRoundNotifier', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('1단계 — 생존한 상태 변경자 되쓰기', () => {
    it('최신 라이브 문서에 hp·mp만 얹어 재등록하고 사망 seam이 올린 경험치를 보존한다', () => {
      const h = setup([fightRoom('t1')])
      h.place('t1', { hp: 50, mp: 10, exp: 100 })
      h.combatRegistry.register(makeState('t1', 30, 8))
      // 같은 라운드에 사망 seam이 경험치를 올려 엔트리를 교체한 상황(오래된 참조로 되쓰면 사라진다).
      const raised = h.liveRegistry.get('t1')!
      h.liveRegistry.register({ ...raised, character: { ...raised.character, experience: 900 } })

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1')))

      const after = h.liveRegistry.get('t1')!.character
      expect(after).toMatchObject({ hpCurrent: 30, mpCurrent: 8, experience: 900 })
      expect(h.deps.markCharacterDirty).toHaveBeenCalledTimes(1)
      expect(h.deps.markCharacterDirty).toHaveBeenCalledWith('t1', after)
    })

    it('hp가 0 미만이면 applyVitals가 0으로 맞춰 되쓴다(사망 취소 상태 D8)', () => {
      const h = setup([fightRoom('t1')])
      h.place('t1', { hp: 50, mp: 10 })
      h.combatRegistry.register(makeState('t1', -4, 10))

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1')))

      expect(h.liveRegistry.get('t1')!.character.hpCurrent).toBe(0)
    })

    it('사망자는 되쓰기를 건너뛴다(사망 seam이 이미 되썼다)', () => {
      const h = setup([fightRoom(), reviveRoom('t1')])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.combatRegistry.register(makeState('t1', 200, 40))
      const before = h.liveRegistry.get('t1')

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom(), { playerDeaths: ['t1'] }))

      expect(h.deps.markCharacterDirty).not.toHaveBeenCalled()
      expect(h.liveRegistry.get('t1')).toBe(before)
    })

    it('hp·mp가 바뀌지 않은 반격자는 되쓰지 않고 combat:round만 받는다', () => {
      const h = setup([fightRoom('t1', 'c1')])
      h.place('t1', { hp: 50, mp: 10 })
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 50, 10))
      h.combatRegistry.register(makeState('c1', 40, 5))
      const report = makeReport(fightRoom('t1', 'c1'), {
        incoming: { kind: 'melee', outcome: makeOutcome({ hit: false, damage: 0 }) },
        counters: [{ characterId: 'c1', outcome: makeOutcome() }],
        statsBefore: new Map([
          ['t1', { hpCurrent: 50, mpCurrent: 10 }],
          ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ]),
      })

      createCombatRoundNotifier(h.deps)(report)

      expect(h.deps.markCharacterDirty).not.toHaveBeenCalled()
      expect(h.order()).toEqual(['combat:round>t1', 'combat:round>c1'])
    })
  })

  describe('전송 순서 (§3.4 2~4단계)', () => {
    it('combat:round 전원 → character:stats → world:room 순서로 보낸다(몬스터 사망)', () => {
      const room = fightRoom('t1', 'c1')
      const h = setup([room])
      h.place('t1', { hp: 50, mp: 10 })
      h.place('c1', { hp: 40, mp: 5, exp: 300 })
      h.place('x1', { hp: 60, mp: 0, exp: 70 })
      h.combatRegistry.register(makeState('t1', 30, 10))
      h.combatRegistry.register(makeState('c1', 40, 5))
      h.awarded.ids = new Set(['c1', 'x1'])
      const report = makeReport(room, {
        counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
        monsterDied: true,
        statsBefore: new Map([
          ['t1', { hpCurrent: 50, mpCurrent: 10 }],
          ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ]),
      })

      createCombatRoundNotifier(h.deps)(report)

      expect(h.order()).toEqual([
        'combat:round>t1',
        'combat:round>c1',
        'character:stats>t1',
        'character:stats>c1',
        'character:stats>x1',
        'world:room>t1',
        'world:room>c1',
      ])
    })

    it('character:stats는 되쓰기 뒤 최신 라이브 문서에서 만든다', () => {
      const h = setup([fightRoom('t1')])
      h.place('t1', { hp: 50, mp: 10, exp: 500 })
      h.combatRegistry.register(makeState('t1', 30, 10))

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1')))

      const stats = h.sent.find((s) => s.event.type === 'character:stats')
      expect(stats?.event).toEqual(characterStatsEvent(h.liveRegistry.get('t1')!.character))
      expect(stats?.event).toMatchObject({ hpCurrent: 30, experience: 500 })
    })

    it('경험치 수령자 중 라운드 수신자 밖 기여자도 character:stats 1건을 받는다', () => {
      const h = setup([fightRoom('t1')])
      h.place('t1', { hp: 50, mp: 10 })
      h.place('x1', { hp: 60, mp: 0, exp: 999 })
      h.combatRegistry.register(makeState('t1', 50, 10))
      h.awarded.ids = new Set(['x1'])

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1'), { monsterDied: true }))

      const toX1 = h.sent.filter((s) => s.to === 'x1')
      expect(toX1.map((s) => s.event.type)).toEqual(['character:stats'])
      expect(toX1[0]?.event).toMatchObject({ experience: 999 })
    })

    it('한 플레이어는 상태 변경·경험치 수령·사망에 모두 해당해도 character:stats를 1건만 받는다', () => {
      const h = setup([fightRoom(), reviveRoom('t1')])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.combatRegistry.register(makeState('t1', 200, 40))
      h.awarded.ids = new Set(['t1'])

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom(), { playerDeaths: ['t1'] }))

      expect(h.sent.filter((s) => s.event.type === 'character:stats')).toHaveLength(1)
    })

    it('몬스터가 죽지 않았으면 world:room을 보내지 않는다', () => {
      const h = setup([fightRoom('t1')])
      h.place('t1', { hp: 50, mp: 10 })
      h.combatRegistry.register(makeState('t1', 30, 10))

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1')))

      expect(h.sent.some((s) => s.event.type === 'world:room')).toBe(false)
    })

    it('몬스터 사망 world:room은 그 방의 스냅샷이며 방을 떠난 수신자는 받지 않는다', () => {
      const room = fightRoom('t1')
      const h = setup([room])
      h.place('t1', { hp: 50, mp: 10 })
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 50, 10))
      h.combatRegistry.register(makeState('c1', 40, 5))

      createCombatRoundNotifier(h.deps)(
        makeReport(room, {
          counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
          monsterDied: true,
        }),
      )

      const views = h.sent.filter((s) => s.event.type === 'world:room')
      expect(views.map((s) => s.to)).toEqual(['t1'])
      expect(views[0]?.event).toMatchObject({ roomId: FIGHT_ROOM, creatures: [] })
    })
  })

  describe('5단계 — 사망자 이동 알림', () => {
    it('출발 방 ≠ 부활 방: 출발 방 exited → 부활 방 entered → 본인 부활 방 world:room', () => {
      // 사망 seam이 이미 t1을 출발 방에서 빼 부활 방에 넣었다.
      const from = fightRoom('o1')
      const to = reviveRoom('t1', 'r1')
      const h = setup([from, to])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.place('o1', { hp: 10, mp: 0 })
      h.combatRegistry.register(makeState('t1', 200, 40))

      createCombatRoundNotifier(h.deps)(makeReport(from, { playerDeaths: ['t1'] }))

      expect(h.order()).toEqual([
        'combat:round>t1',
        'character:stats>t1',
        'world:presence>o1',
        'world:presence>r1',
        'world:room>t1',
      ])
      const [exited, entered, view] = h.sent.slice(2).map((s) => s.event)
      expect(exited).toMatchObject({
        roomId: FIGHT_ROOM,
        subject: { characterId: 't1' },
        change: { change: 'exited', announce: false },
      })
      expect(entered).toMatchObject({
        roomId: DEFAULT_REVIVE_ROOM,
        change: { change: 'entered' },
      })
      expect(view).toMatchObject({ type: 'world:room', roomId: DEFAULT_REVIVE_ROOM })
    })

    it('부활 방에서 죽으면(같은 방) presence 없이 본인 world:room만 보낸다', () => {
      const room = reviveRoom('t1', 'r1')
      const h = setup([room])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.combatRegistry.register(makeState('t1', 200, 40))

      createCombatRoundNotifier(h.deps)(
        makeReport(room, {
          playerDeaths: ['t1'],
          statsBefore: new Map([['t1', { hpCurrent: 3, mpCurrent: 40 }]]),
        }),
      )

      expect(h.order()).toEqual(['combat:round>t1', 'character:stats>t1', 'world:room>t1'])
    })

    // 방어적 케이스 — 현 combatTick에선 생기지 않는다(반격으로 몬스터가 죽으면 표적 사망이 취소된다, D8).
    // 순서 규칙이 단계 단위로 고정돼 있음을 보이려고 두 사망을 한 보고서에 겹쳐 둔다.
    it('(방어적) 몬스터 사망과 플레이어 사망이 겹치면 방 뷰(4단계)가 이동 알림(5단계)보다 먼저다', () => {
      const from = fightRoom('c1')
      const to = reviveRoom('t1')
      const h = setup([from, to])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 200, 40))
      h.combatRegistry.register(makeState('c1', 40, 5))

      createCombatRoundNotifier(h.deps)(
        makeReport(from, {
          counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
          monsterDied: true,
          playerDeaths: ['t1'],
        }),
      )

      expect(h.order()).toEqual([
        'combat:round>t1',
        'combat:round>c1',
        'character:stats>t1',
        'world:room>c1',
        'world:presence>c1',
        'world:room>t1',
      ])
    })

    it('사망자 라이브 엔트리가 없으면 logger.error 후 그 사망자의 이동 알림만 건너뛴다', () => {
      const h = setup([fightRoom('o1'), reviveRoom()])
      h.combatRegistry.register(makeState('t1', 200, 40))

      expect(() =>
        createCombatRoundNotifier(h.deps)(makeReport(fightRoom('o1'), { playerDeaths: ['t1'] })),
      ).not.toThrow()

      // 같은 원인(엔트리 없음)은 stats·revival 두 단계에 걸쳐도 1회만 남긴다.
      expect(h.logger.error).toHaveBeenCalledTimes(1)
      expect(h.order()).toEqual(['combat:round>t1'])
    })

    it('부활 방을 해석하지 못하면 logger.error 후 presence·world:room을 보내지 않는다', () => {
      const h = setup([fightRoom('o1')])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.combatRegistry.register(makeState('t1', 200, 40))

      createCombatRoundNotifier(h.deps)(makeReport(fightRoom('o1'), { playerDeaths: ['t1'] }))

      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ characterId: 't1', roomId: DEFAULT_REVIVE_ROOM }),
        expect.any(String),
      )
      expect(h.sent.filter((s) => s.event.type === 'world:presence')).toHaveLength(0)
      expect(h.sent.filter((s) => s.event.type === 'world:room')).toHaveLength(0)
    })
  })

  describe('실패 격리', () => {
    it('수신자 1명 전송이 throw해도 logger.error 후 나머지 수신자에게 계속 보낸다', () => {
      const room = fightRoom('t1', 'c1')
      const h = setup([room])
      h.place('t1', { hp: 50, mp: 10 })
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 30, 10))
      h.combatRegistry.register(makeState('c1', 35, 5))
      h.deps.sendToCharacter.mockImplementation((to: string, event: ServerEvent) => {
        if (to === 't1') throw new Error('socket closed')
        h.sent.push({ to, event })
      })
      const report = makeReport(room, {
        counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
        monsterDied: true,
        statsBefore: new Map([
          ['t1', { hpCurrent: 50, mpCurrent: 10 }],
          ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ]),
      })

      expect(() => createCombatRoundNotifier(h.deps)(report)).not.toThrow()

      expect(h.order()).toEqual(['combat:round>c1', 'character:stats>c1', 'world:room>c1'])
      expect(h.logger.error).toHaveBeenCalledTimes(3)
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ characterId: 't1' }),
        expect.any(String),
      )
    })

    it('4단계 방 뷰 생성이 throw해도 logger.error 후 5단계 사망자 이동 알림은 실행된다', () => {
      const from = fightRoom('c1')
      const to = reviveRoom('t1', 'r1')
      const h = setup([from, to])
      h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 200, 40))
      h.combatRegistry.register(makeState('c1', 40, 5))
      // 출발 방 점유자 c1의 이름 해석만 던진다 — 출발 방 뷰 생성은 실패하고 부활 방 뷰는 성공한다.
      const deps = {
        ...h.deps,
        resolveCharacterName: (id: string) => {
          if (id === 'c1') throw new Error('name lookup failed')
          return NAMES[id]
        },
      }

      expect(() =>
        createCombatRoundNotifier(deps)(
          makeReport(from, {
            counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
            monsterDied: true,
            playerDeaths: ['t1'],
          }),
        ),
      ).not.toThrow()

      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'room' }),
        expect.any(String),
      )
      expect(h.order()).toEqual([
        'combat:round>t1',
        'combat:round>c1',
        'character:stats>t1',
        'world:presence>c1',
        'world:presence>r1',
        'world:room>t1',
      ])
    })

    it('수집분 조회가 throw해도 통지기는 throw하지 않고 logger.error를 남긴다', () => {
      const h = setup([fightRoom('t1')])
      const deps = {
        ...h.deps,
        awardedPlayerIds: () => {
          throw new Error('boom')
        },
      }

      expect(() => createCombatRoundNotifier(deps)(makeReport(fightRoom('t1')))).not.toThrow()
      expect(h.logger.error).toHaveBeenCalled()
    })

    it('logger.error마저 throw해도 통지기는 throw하지 않는다', () => {
      const h = setup([fightRoom('t1')])
      h.logger.error.mockImplementation(() => {
        throw new Error('logger down')
      })
      h.deps.sendToCharacter.mockImplementation(() => {
        throw new Error('socket closed')
      })

      expect(() => createCombatRoundNotifier(h.deps)(makeReport(fightRoom('t1')))).not.toThrow()
    })

    it('생존 상태 변경자의 라이브 엔트리가 없으면 logger.error 후 다른 생존자 되쓰기를 계속한다', () => {
      const h = setup([fightRoom('t1', 'c1')])
      h.place('c1', { hp: 40, mp: 5 })
      h.combatRegistry.register(makeState('t1', 30, 10))
      h.combatRegistry.register(makeState('c1', 35, 5))
      const report = makeReport(fightRoom('t1', 'c1'), {
        counters: [{ characterId: 'c1', outcome: makeOutcome() }],
        statsBefore: new Map([
          ['t1', { hpCurrent: 50, mpCurrent: 10 }],
          ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ]),
      })

      createCombatRoundNotifier(h.deps)(report)

      // 같은 원인(엔트리 없음)은 write-back·stats 두 단계에 걸쳐도 1회만 남긴다.
      expect(h.logger.error).toHaveBeenCalledTimes(1)
      expect(h.liveRegistry.get('c1')!.character.hpCurrent).toBe(35)
      expect(h.deps.markCharacterDirty).toHaveBeenCalledTimes(1)
    })
  })

  it('보낸 모든 이벤트가 serverEventSchema를 통과한다', () => {
    const from = fightRoom('c1', 'o1')
    const to = reviveRoom('t1', 'r1')
    const h = setup([from, to])
    h.place('t1', { hp: 200, mp: 40, room: DEFAULT_REVIVE_ROOM })
    h.place('c1', { hp: 40, mp: 5 })
    h.combatRegistry.register(makeState('t1', 200, 40))
    h.combatRegistry.register(makeState('c1', 33, 5))

    createCombatRoundNotifier(h.deps)(
      makeReport(from, {
        counters: [{ characterId: 'c1', outcome: makeOutcome({ died: true }) }],
        monsterDied: true,
        playerDeaths: ['t1'],
        statsBefore: new Map([
          ['t1', { hpCurrent: 50, mpCurrent: 40 }],
          ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ]),
      }),
    )

    expect(h.sent.length).toBeGreaterThan(0)
    for (const { event } of h.sent) {
      expect(serverEventSchema.safeParse(event).success).toBe(true)
    }
  })
})
