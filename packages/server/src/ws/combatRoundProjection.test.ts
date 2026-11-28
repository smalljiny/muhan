import { describe, it, expect } from 'vitest'
import { serverEventSchema, type CreatureInstance, type RoomNode } from 'shared'
import type { AttackOutcome, CombatRoundReport, IncomingAction } from '../combat/index.js'
import { noDamageOutcome } from '../combat/resolveAttack.js'
import {
  projectCombatRound,
  computeRoundAudience,
  type RoundVitals,
} from './combatRoundProjection.js'

/**
 * combatRoundProjection — 라운드 보고서를 수신자별 `combat:round`로 투영하고(스펙 §3.6), G2 표의 네 집합
 * (라운드 수신자·상태 변경자·경험치 수령자 합류 stats 수신자·방 뷰 갱신 대상)을 계산하는 순수 함수 테스트.
 */

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

const MISS = makeOutcome({ hit: false, damage: 0 })

function makeCreature(): CreatureInstance {
  return {
    instanceId: 'm1',
    templateId: null,
    name: '고블린',
    level: 3,
    hpmax: 100,
    hpcur: 100,
    mpmax: 0,
    mpcur: 0,
    dexterity: 12,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 10,
    ndice: 1,
    sdice: 6,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: '',
    enemies: [],
    inventory: [],
  }
}

function makeRoom(occupantIds: readonly string[]): RoomNode {
  return {
    roomId: 50,
    name: '방',
    shortDesc: '',
    longDesc: '',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(occupantIds),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
  }
}

function makeReport(overrides: Partial<CombatRoundReport> = {}): CombatRoundReport {
  return {
    creature: makeCreature(),
    room: makeRoom(['t1', 'c1']),
    targetId: 't1',
    incoming: { kind: 'melee', outcome: MISS },
    counters: [],
    monsterDied: false,
    playerDeaths: [],
    statsBefore: new Map<string, RoundVitals>([
      ['t1', { hpCurrent: 50, mpCurrent: 10 }],
      ['c1', { hpCurrent: 40, mpCurrent: 5 }],
    ]),
    ...overrides,
  }
}

/** 임의의 id → hp·mp map을 `computeRoundAudience`의 `currentVitals` 조회 함수로 감싼다(map에 없으면 undefined). */
function vitalsFrom(
  map: ReadonlyMap<string, RoundVitals>,
): (id: string) => RoundVitals | undefined {
  return (id) => map.get(id)
}

describe('projectCombatRound', () => {
  it('사망 취소 상태 표적(D8)의 근접 빗맞음은 received melee hit:false damage:0이다', () => {
    const incoming: IncomingAction = { kind: 'melee', outcome: noDamageOutcome(false) }

    const event = projectCombatRound(makeReport({ incoming }), 't1')

    expect(event.received).toEqual({
      kind: 'melee',
      hit: false,
      damage: 0,
      critical: false,
      fumble: false,
    })
  })

  it('표적의 근접 빗맞음은 received melee hit:false damage:0이다', () => {
    const event = projectCombatRound(makeReport(), 't1')

    expect(event.received).toEqual({
      kind: 'melee',
      hit: false,
      damage: 0,
      critical: false,
      fumble: false,
    })
  })

  it('표적의 근접 명중은 AttackOutcome의 hit·damage·critical·fumble만 투영한다', () => {
    const incoming: IncomingAction = {
      kind: 'melee',
      outcome: makeOutcome({ hit: true, damage: 12, critical: true, fumble: false }),
    }

    const event = projectCombatRound(makeReport({ incoming }), 't1')

    expect(event.received).toEqual({
      kind: 'melee',
      hit: true,
      damage: 12,
      critical: true,
      fumble: false,
    })
  })

  it('반격만 한 플레이어는 received가 null이고 counter에 자기 반격 결과를 받는다', () => {
    const report = makeReport({
      counters: [{ characterId: 'c1', outcome: makeOutcome({ damage: 7, fumble: true }) }],
    })

    const event = projectCombatRound(report, 'c1')

    expect(event.received).toBeNull()
    expect(event.counter).toEqual({ hit: true, damage: 7, critical: false, fumble: true })
  })

  it('자기 회복 시전을 받은 표적은 received cast damage:0이다', () => {
    const event = projectCombatRound(makeReport({ incoming: { kind: 'cast', damage: 0 } }), 't1')

    expect(event.received).toEqual({ kind: 'cast', damage: 0 })
  })

  it('반격을 굴리지 않은 수신자는 counter가 null이다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })

    expect(projectCombatRound(report, 't1').counter).toBeNull()
  })

  it('표적이 반격도 굴렸으면 received와 counter를 함께 받는다', () => {
    const report = makeReport({
      counters: [
        { characterId: 'c1', outcome: makeOutcome({ damage: 3 }) },
        { characterId: 't1', outcome: makeOutcome({ damage: 9 }) },
      ],
    })

    const event = projectCombatRound(report, 't1')

    expect(event.received).toMatchObject({ kind: 'melee' })
    expect(event.counter).toEqual({ hit: true, damage: 9, critical: false, fumble: false })
  })

  it('youDied는 playerDeaths 포함 여부, monsterDied·몬스터 식별은 보고서 값이다', () => {
    const report = makeReport({ monsterDied: true, playerDeaths: ['t1'] })

    const forTarget = projectCombatRound(report, 't1')
    const forCounter = projectCombatRound(report, 'c1')

    expect(forTarget).toMatchObject({
      type: 'combat:round',
      creatureInstanceId: 'm1',
      creatureName: '고블린',
      monsterDied: true,
      youDied: true,
    })
    expect(forCounter.youDied).toBe(false)
    expect(forCounter.monsterDied).toBe(true)
  })

  it('다인 라운드에서 표적과 반격만 한 플레이어의 이벤트가 다르다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })

    expect(projectCombatRound(report, 't1')).not.toEqual(projectCombatRound(report, 'c1'))
  })

  it.each([
    ['근접 빗맞음 표적', makeReport(), 't1'],
    ['반격만 한 플레이어', makeReport({ counters: [{ characterId: 'c1', outcome: MISS }] }), 'c1'],
    [
      '시전 피해 표적',
      makeReport({ incoming: { kind: 'cast', damage: 8 }, playerDeaths: ['t1'] }),
      't1',
    ],
  ] as const)('투영 결과가 serverEventSchema를 통과한다 — %s', (_label, report, recipientId) => {
    const event = projectCombatRound(report, recipientId)

    expect(serverEventSchema.safeParse(event).success).toBe(true)
  })

  it('입력 보고서를 변형하지 않는다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })
    const snapshot = structuredClone({ ...report, room: null })

    projectCombatRound(report, 't1')
    projectCombatRound(report, 'c1')

    expect({ ...report, room: null }).toEqual(snapshot)
  })
})

describe('computeRoundAudience', () => {
  it('라운드 수신자는 표적 ∪ 반격자이며 중복을 제거한다', () => {
    const report = makeReport({
      counters: [
        { characterId: 'c1', outcome: MISS },
        { characterId: 't1', outcome: MISS },
      ],
    })

    const audience = computeRoundAudience(report, vitalsFrom(report.statsBefore), new Set())

    expect([...audience.roundRecipients]).toEqual(['t1', 'c1'])
  })

  it('상태 변경자는 hp 또는 mp가 바뀐 플레이어 ∪ playerDeaths이다', () => {
    const report = makeReport({
      statsBefore: new Map<string, RoundVitals>([
        ['t1', { hpCurrent: 50, mpCurrent: 10 }],
        ['c1', { hpCurrent: 40, mpCurrent: 5 }],
        ['c2', { hpCurrent: 30, mpCurrent: 5 }],
        ['d1', { hpCurrent: 20, mpCurrent: 0 }],
      ]),
      playerDeaths: ['d1'],
    })
    const current = new Map<string, RoundVitals>([
      ['t1', { hpCurrent: 45, mpCurrent: 10 }],
      ['c1', { hpCurrent: 40, mpCurrent: 3 }],
      ['c2', { hpCurrent: 30, mpCurrent: 5 }],
      ['d1', { hpCurrent: 20, mpCurrent: 0 }],
    ])

    const audience = computeRoundAudience(report, vitalsFrom(current), new Set())

    expect([...audience.statsChanged].sort()).toEqual(['c1', 'd1', 't1'])
  })

  it('되쓰기 대상은 상태 변경자 중 사망하지 않은 플레이어다', () => {
    const report = makeReport({ playerDeaths: ['t1'] })
    const current = new Map<string, RoundVitals>([
      ['t1', { hpCurrent: 100, mpCurrent: 50 }],
      ['c1', { hpCurrent: 35, mpCurrent: 5 }],
    ])

    const audience = computeRoundAudience(report, vitalsFrom(current), new Set())

    expect([...audience.survivorsToWriteBack]).toEqual(['c1'])
  })

  it('현재 전투상태가 없는 생존 플레이어는 상태 변경자가 아니다', () => {
    const report = makeReport()

    const audience = computeRoundAudience(report, () => undefined, new Set())

    expect(audience.statsChanged.size).toBe(0)
  })

  it('현재 전투상태가 없는 사망자는 상태 변경자에 들어가고 되쓰기 대상에서는 빠진다', () => {
    const report = makeReport({ playerDeaths: ['t1'] })

    const audience = computeRoundAudience(report, () => undefined, new Set())

    expect([...audience.statsChanged]).toEqual(['t1'])
    expect(audience.survivorsToWriteBack.has('t1')).toBe(false)
  })

  it('stats 수신자는 상태 변경자 ∪ 경험치 수령자(라운드 밖 기여자 포함)이며 1인 1건이다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })
    const current = new Map<string, RoundVitals>([
      ['t1', { hpCurrent: 45, mpCurrent: 10 }],
      ['c1', { hpCurrent: 40, mpCurrent: 5 }],
    ])

    const audience = computeRoundAudience(report, vitalsFrom(current), new Set(['t1', 'c1', 'x9']))

    expect([...audience.statsRecipients].sort()).toEqual(['c1', 't1', 'x9'])
  })

  it('반격만 하고 피해·경험치가 없는 플레이어는 stats 수신자가 아니다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })
    const current = new Map<string, RoundVitals>([
      ['t1', { hpCurrent: 45, mpCurrent: 10 }],
      ['c1', { hpCurrent: 40, mpCurrent: 5 }],
    ])

    const audience = computeRoundAudience(report, vitalsFrom(current), new Set())

    expect(audience.roundRecipients.has('c1')).toBe(true)
    expect(audience.statsRecipients.has('c1')).toBe(false)
  })

  it('몬스터가 죽지 않으면 방 뷰 갱신 대상은 비어 있다', () => {
    const report = makeReport({ counters: [{ characterId: 'c1', outcome: makeOutcome() }] })

    const audience = computeRoundAudience(report, vitalsFrom(report.statsBefore), new Set())

    expect(audience.roomViewRecipients.size).toBe(0)
  })

  it('몬스터가 죽으면 방 뷰 갱신 대상은 방에 아직 있는 라운드 수신자다', () => {
    const report = makeReport({
      room: makeRoom(['c1', 'bystander']),
      counters: [{ characterId: 'c1', outcome: makeOutcome() }],
      monsterDied: true,
    })

    const audience = computeRoundAudience(report, vitalsFrom(report.statsBefore), new Set())

    expect([...audience.roomViewRecipients]).toEqual(['c1'])
  })

  it('입력(보고서·경험치 수령자 집합)을 변형하지 않는다', () => {
    const report = makeReport({ playerDeaths: ['t1'], monsterDied: true })
    const awarded = new Set(['x9'])
    const occupantsBefore = [...report.room.occupants]
    const statsBefore = [...report.statsBefore]

    computeRoundAudience(report, () => ({ hpCurrent: 1, mpCurrent: 1 }), awarded)

    expect([...awarded]).toEqual(['x9'])
    expect([...report.room.occupants]).toEqual(occupantsBefore)
    expect([...report.statsBefore]).toEqual(statsBefore)
    expect(report.playerDeaths).toEqual(['t1'])
  })
})
