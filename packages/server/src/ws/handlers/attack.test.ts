import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  serverEventSchema,
  type Character,
  type ClientCommand,
  type CreatureInstance,
  type ObjectInstance,
  type ServerEvent,
} from 'shared'
import { makeCharacter } from '../../world/characterFixtures.testutil.js'
import { makeCreature, makeRoom, flagsHex } from '../../world/roomFixtures.testutil.js'
import { makeObjectInstance, makeTemplateIndex } from '../../items/objectFixtures.testutil.js'
import { MUNKIL } from '../../world/hexFlags.js'
import { createLiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import { createRoomPlayerResolver, resolveRoomCreature } from '../../world/roomTargetResolvers.js'
import { buildSpawnTemplateIndex, createInstanceIdAllocator } from '../../world/spawn.js'
import type { MarkCharacterDirty } from '../../world/markCharacterDirty.js'
import { createCombatRegistry } from '../../combat/combatRegistry.js'
import { createCreatureLedgers } from '../../combat/creatureLedgers.js'
import {
  assemblePlayerCombatState,
  type CombatStateCarry,
} from '../../combat/assemblePlayerCombatState.js'
import { grantBlind } from '../../combat/statusEffects.js'
import type { CombatRng } from '../../combat/dice.js'
import { maxRollRng, minRollRng } from '../../combat/dice.testutil.js'
import { assembleDeathSeams } from '../assembleDeathSeams.js'
import { normalizeHandlerEvents } from '../router.js'
import type { ActorContext } from '../actorContext.js'
import { composeCharacterFlags } from '../../character/flags.js'
import { checkPvpGate } from '../../combat/pvp.js'
import { initiateAttack } from '../../combat/initiateAttack.js'
import { createAttackHandler, type AttackHandlerDeps } from './attack.js'

/**
 * combat:attack 핸들러 스펙 — 대상 지목 2단(크리처 우선)·쿨다운 게이트·전투상태 재조립·공격 판정·
 * 되쓰기·이벤트 투영을 하나의 명령 경로로 배선한다.
 *
 * ## 킬 경로는 mock이 아니라 실 구현을 태운다
 * 사망 seam(`assembleDeathSeams`)·원장(`createCreatureLedgers`)·라이브 레지스트리를 전부 실 구현으로
 * 조립한다. 이 Story의 핵심 계약이 "공격 도중 사망 seam이 레지스트리 엔트리를 갈아끼우므로 되쓰기
 * 직전에 다시 읽어야 한다"인데, 그 seam을 mock으로 갈아끼우면 재조회를 없애도 테스트가 통과한다.
 *
 * ## 세 모듈만 부분 mock한다
 * `composeCharacterFlags`(호출 횟수)·`checkPvpGate`(미호출)·`initiateAttack`(미호출·반환 사유)은
 * 관측이 필요해 spy로 감싸되 **실 구현에 위임**한다. 동작을 바꾸는 mock은 두지 않는다.
 */

vi.mock('../../character/flags.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../character/flags.js')>()
  return { ...actual, composeCharacterFlags: vi.fn(actual.composeCharacterFlags) }
})
vi.mock('../../combat/pvp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../combat/pvp.js')>()
  return { ...actual, checkPvpGate: vi.fn(actual.checkPvpGate) }
})
vi.mock('../../combat/initiateAttack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../combat/initiateAttack.js')>()
  return { ...actual, initiateAttack: vi.fn(actual.initiateAttack) }
})

// ── 픽스처 ───────────────────────────────────────────────────────────────────

/** 현재 틱(고정). 쿨다운 비교·flags 만료 판정 기준이 이 값이다. */
const NOW = 100

const actor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

/** 공격 명령 팩토리 — 와이어 계약 필드만 싣는다. */
function attackCommand(
  target: string,
  extra: { ordinal?: number; id?: string } = {},
): ClientCommand {
  return { type: 'combat:attack', target, ...extra }
}

/**
 * 죽일 수 있는 크리처 — hpmax·hpcur 1, exp 100이라 한 대 맞으면 죽고 보상이 정확히 100이다
 * (expdiv = trunc(exp * dmg / hpmax) = 100).
 */
function makeFragileCreature(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return makeCreature('1:c0', '고블린', { hpmax: 1, hpcur: 1, experience: 100, ...overrides })
}

/** 잘 버티는 크리처 — 한 대로는 죽지 않는다(비-킬 경로 기본). */
function makeToughCreature(overrides: Partial<CreatureInstance> = {}): CreatureInstance {
  return makeCreature('1:c0', '고블린', { hpmax: 500, hpcur: 500, experience: 100, ...overrides })
}

interface SetupOptions {
  readonly character?: Character
  readonly inventory?: readonly ObjectInstance[]
  readonly others?: readonly Character[]
  readonly creatures?: readonly CreatureInstance[]
  readonly carry?: CombatStateCarry
  readonly rng?: CombatRng
  readonly roomless?: boolean
  readonly now?: number
}

/**
 * 핸들러 하네스 — 라이브 레지스트리·전투 레지스트리·원장·사망 seam을 실 구현으로 조립하고
 * 관측 지점(마킹·시각·방 해소·라이브 조회)만 spy로 감싼다.
 */
function setup(options: SetupOptions = {}) {
  const now = options.now ?? NOW
  const nowFn = vi.fn(() => now)
  const character = options.character ?? makeCharacter({ _id: 'char-1' })
  const inventory = options.inventory ?? []

  const liveRegistry = createLiveCharacterRegistry()
  liveRegistry.register({ character, inventory })
  for (const other of options.others ?? [])
    liveRegistry.register({ character: other, inventory: [] })

  const occupants = new Set<string>([
    character._id,
    ...(options.others ?? []).map((other) => other._id),
  ])
  const room = makeRoom({ roomId: 1, occupants, creatures: [...(options.creatures ?? [])] })

  const combatRegistry = createCombatRegistry()
  const ledgers = createCreatureLedgers()
  const markCharacterDirty = vi.fn<MarkCharacterDirty>()
  const logger = { error: vi.fn() }
  const seams = assembleDeathSeams({
    liveRegistry,
    ledgers,
    markCharacterDirty,
    creatureDeathDeps: {
      templates: buildSpawnTemplateIndex([]),
      alloc: createInstanceIdAllocator(),
    },
    logger,
  })
  const resolveCharacterName = (characterId: string): string | undefined =>
    liveRegistry.get(characterId)?.character.name

  const deps: AttackHandlerDeps = {
    liveRegistry,
    combatRegistry,
    objectTemplates: makeTemplateIndex([]),
    resolveRoom: vi.fn(() => (options.roomless === true ? undefined : room)),
    resolveRoomCreature,
    resolveRoomPlayer: createRoomPlayerResolver(resolveCharacterName),
    resolveCharacterName,
    now: nowFn,
    rng: options.rng ?? maxRollRng,
    ledgers,
    fireCreatureDeath: seams.fireCreatureDeath,
    firePlayerDeath: seams.firePlayerDeath,
    markCharacterDirty,
  }

  if (options.carry !== undefined) {
    combatRegistry.register(
      assemblePlayerCombatState(
        { character, inventory },
        deps.objectTemplates,
        composeCharacterFlags(character, now),
        options.carry,
      ),
    )
  }

  // 시드 조립에서 쓴 호출은 계수에서 제외한다(명령당 1회 단언의 기준선).
  vi.mocked(composeCharacterFlags).mockClear()
  const liveGet = vi.spyOn(liveRegistry, 'get')

  return {
    handler: createAttackHandler(deps),
    deps,
    liveRegistry,
    combatRegistry,
    ledgers,
    room,
    markCharacterDirty,
    logger,
    liveGet,
    now,
    nowFn,
  }
}

/** 핸들러 반환을 라우터와 같은 규칙으로 배열 정규화한다. */
function run(
  handler: ReturnType<typeof createAttackHandler>,
  command: ClientCommand,
  who: ActorContext = actor,
): readonly ServerEvent[] {
  return normalizeHandlerEvents(handler(command, who))
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 배선 격리 ────────────────────────────────────────────────────────────────

describe('createAttackHandler — 배선 격리', () => {
  it('라이브 미등록 actor는 error{internal} 1개를 낸다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    const events = run(handler, attackCommand('고블린'), {
      accountId: 'acc-9',
      characterId: 'ghost',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'internal' })
    expect(vi.mocked(initiateAttack)).not.toHaveBeenCalled()
  })

  it('방이 해소되지 않으면 error{internal}을 낸다', () => {
    const { handler } = setup({ roomless: true })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'internal' })
  })

  it('correlationId(id)를 거부 이벤트에 반향한다', () => {
    const { handler } = setup({ roomless: true })

    const events = run(handler, attackCommand('고블린', { id: 'cmd-7' }))

    expect(events[0]).toMatchObject({ type: 'error', correlationId: 'cmd-7' })
  })
})

// ── 쿨다운 게이트 ────────────────────────────────────────────────────────────

describe('createAttackHandler — 쿨다운 게이트', () => {
  it('now < nextAttackAt이면 rule_rejected로 거부하고 initiateAttack을 부르지 않는다', () => {
    const { handler } = setup({
      creatures: [makeToughCreature()],
      carry: { hpCurrent: 42, mpCurrent: 15, nextAttackAt: NOW + 5 },
    })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'rule_rejected' })
    expect(vi.mocked(initiateAttack)).not.toHaveBeenCalled()
  })

  it('now === nextAttackAt이면 공격이 통과한다 (경계)', () => {
    const { handler } = setup({
      creatures: [makeToughCreature()],
      carry: { hpCurrent: 42, mpCurrent: 15, nextAttackAt: NOW },
    })

    const events = run(handler, attackCommand('고블린'))

    expect(events[0]).toMatchObject({ type: 'combat:attacked' })
  })

  it('전투상태 미등록(첫 공격)이면 게이트를 통과하고 상태를 등록한다', () => {
    const { handler, combatRegistry } = setup({ creatures: [makeToughCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events[0]).toMatchObject({ type: 'combat:attacked' })
    expect(combatRegistry.get('char-1')).toBeDefined()
  })
})

// ── 대상 해소 ────────────────────────────────────────────────────────────────

describe('createAttackHandler — 대상 해소', () => {
  it('크리처가 없고 사람이 잡히면 사람 공격 거부 메시지를 낸다', () => {
    const { handler } = setup({ others: [makeCharacter({ _id: 'char-2', name: '타이' })] })

    const events = run(handler, attackCommand('타이'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'rule_rejected',
      message: '아직 사람은 공격할 수 없습니다',
    })
  })

  it('사람 대상 거부는 checkPvpGate·initiateAttack을 부르지 않는다', () => {
    const { handler } = setup({ others: [makeCharacter({ _id: 'char-2', name: '타이' })] })

    const events = run(handler, attackCommand('타이'))

    // 거부가 실제로 일어났음을 먼저 고정한다(핸들러가 아무 일도 안 해도 통과하는 것을 막는다).
    expect(events[0]).toMatchObject({ code: 'rule_rejected' })
    expect(vi.mocked(checkPvpGate)).not.toHaveBeenCalled()
    expect(vi.mocked(initiateAttack)).not.toHaveBeenCalled()
  })

  it('자기 자신을 지목해도 사람 공격 거부로 떨어진다 (별도 자기 제외 게이트 없음)', () => {
    const { handler } = setup({})

    const events = run(handler, attackCommand('테스토스'))

    expect(events[0]).toMatchObject({ message: '아직 사람은 공격할 수 없습니다' })
  })

  it('크리처·사람 모두 못 찾으면 미해소 거부 메시지를 낸다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    const events = run(handler, attackCommand('용'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'rule_rejected',
      message: '그런 것이 여기에 없습니다',
    })
  })

  it('같은 이름의 크리처와 사람이 함께 있으면 크리처를 먼저 고른다', () => {
    const { handler } = setup({
      others: [makeCharacter({ _id: 'char-2', name: '타이' })],
      creatures: [makeToughCreature({ name: '타이' })],
    })

    const events = run(handler, attackCommand('타이'))

    expect(events[0]).toMatchObject({ type: 'combat:attacked', targetInstanceId: '1:c0' })
  })

  it('ordinal을 해소자에 그대로 넘긴다 (동명 2마리 중 두 번째)', () => {
    const { handler } = setup({
      creatures: [
        makeToughCreature({ instanceId: '1:c0' }),
        makeToughCreature({ instanceId: '1:c1' }),
      ],
    })

    const events = run(handler, attackCommand('고블린', { ordinal: 2 }))

    expect(events[0]).toMatchObject({ targetInstanceId: '1:c1' })
  })
})

// ── 게이트 실패 ──────────────────────────────────────────────────────────────

describe('createAttackHandler — 무적 게이트', () => {
  it('MUNKIL 크리처는 initiateAttack이 돌려준 사유로 거부한다', () => {
    const { handler } = setup({ creatures: [makeToughCreature({ flags: flagsHex(MUNKIL) })] })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(1)
    const result = vi.mocked(initiateAttack).mock.results[0]
    const reason = result?.type === 'return' && !result.value.ok ? result.value.reason : ''
    expect(reason).not.toBe('')
    expect(events[0]).toMatchObject({ type: 'error', code: 'rule_rejected', message: reason })
  })

  // 오라클은 무적 게이트(`command5.c:147`) **앞에서** 타이머를 세팅한다(`:138`) — 막힌 공격도
  // 쿨다운을 먹는다. 이 단언이 없으면 거부가 공짜가 되어 이 명령의 유일한 유량 제한이 사라진다.
  it('게이트에 막혀도 쿨다운을 소모한다 (오라클 command5.c:138 순서)', () => {
    const { handler, combatRegistry } = setup({
      creatures: [makeToughCreature({ flags: flagsHex(MUNKIL) })],
      carry: { hpCurrent: 42, mpCurrent: 15, nextAttackAt: NOW },
    })

    run(handler, attackCommand('고블린'))

    expect(combatRegistry.get('char-1')?.nextAttackAt).toBe(NOW + 1)
  })

  // 거부 경로는 캐릭터 상태를 건드리지 않는다 — 쿨다운만 소모하고 hp·경험치·영속 마킹은 불변이다.
  it.each([
    ['쿨다운 미도래', { carry: { hpCurrent: 42, mpCurrent: 15, nextAttackAt: NOW + 5 } }, '고블린'],
    ['대상 미해소', {}, '없는것'],
    ['무적 게이트', { creatureFlags: flagsHex(MUNKIL) }, '고블린'],
  ])(
    '%s 거부는 markCharacterDirty·liveRegistry.register를 부르지 않는다',
    (_label, opts, target) => {
      const options =
        'creatureFlags' in opts
          ? { creatures: [makeToughCreature({ flags: opts.creatureFlags })] }
          : { creatures: [makeToughCreature()], ...opts }
      const { handler, markCharacterDirty, liveRegistry } = setup(options)
      const register = vi.spyOn(liveRegistry, 'register')

      const events = run(handler, attackCommand(target))

      expect(events[0]).toMatchObject({ type: 'error', code: 'rule_rejected' })
      expect(markCharacterDirty).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
    },
  )
})

// ── 성공 경로 ────────────────────────────────────────────────────────────────

describe('createAttackHandler — 성공 경로', () => {
  it('combat:attacked·character:stats 2개를 순서대로 낸다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'combat:attacked',
      targetInstanceId: '1:c0',
      targetName: '고블린',
      hit: true,
      died: false,
    })
    expect(events[1]).toMatchObject({ type: 'character:stats' })
  })

  it('발화 이벤트가 전부 와이어 계약(serverEventSchema)을 통과한다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(2) // 빈 배열을 순회하며 통과하는 공허한 단언 방지.
    for (const event of events) {
      expect(serverEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('attacks 원소는 와이어 6필드만 싣는다 (specialAttack 제외)', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    const event = run(handler, attackCommand('고블린'))[0]
    const attacks = event !== undefined && 'attacks' in event ? event.attacks : []

    expect(attacks.length).toBeGreaterThan(0)
    for (const attack of attacks) {
      expect(Object.keys(attack).sort()).toEqual(
        ['critical', 'damage', 'durabilityHit', 'fumble', 'hit', 'weaponDropped'].sort(),
      )
    }
  })

  it('빗나가도 combat:attacked·character:stats 2개를 낸다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()], rng: minRollRng })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'combat:attacked', hit: false, damage: 0 })
  })

  it('nextAttackAt = now + ATTACK_COOLDOWN_INTERVAL + cooldownIncrement (실명 없음)', () => {
    const { handler, combatRegistry } = setup({ creatures: [makeToughCreature()] })

    run(handler, attackCommand('고블린'))

    expect(combatRegistry.get('char-1')?.nextAttackAt).toBe(NOW + 1)
  })

  it('PBLIND 보유 시 nextAttackAt = now + ATTACK_COOLDOWN_BLIND', () => {
    const { handler, combatRegistry } = setup({
      character: grantBlind(makeCharacter({ _id: 'char-1' }), NOW + 50),
      creatures: [makeToughCreature()],
    })

    run(handler, attackCommand('고블린'))

    expect(combatRegistry.get('char-1')?.nextAttackAt).toBe(NOW + 6)
  })

  it('composeCharacterFlags를 명령당 정확히 1회 호출한다', () => {
    const { handler } = setup({ creatures: [makeToughCreature()] })

    run(handler, attackCommand('고블린'))

    expect(vi.mocked(composeCharacterFlags)).toHaveBeenCalledTimes(1)
  })
})

// ── 되쓰기 ───────────────────────────────────────────────────────────────────

describe('createAttackHandler — hp·mp 되쓰기', () => {
  it('전투상태의 hp·mp를 캐릭터 문서로 되쓰고 markCharacterDirty를 부른다', () => {
    const { handler, liveRegistry, markCharacterDirty } = setup({
      character: makeCharacter({ _id: 'char-1', hpCurrent: 42, mpCurrent: 15 }),
      creatures: [makeToughCreature()],
      // 몬스터 반격으로 이미 깎인 전투상태(캐릭터 문서와 다른 값).
      carry: { hpCurrent: 20, mpCurrent: 5, nextAttackAt: NOW },
    })

    const events = run(handler, attackCommand('고블린'))

    expect(liveRegistry.get('char-1')?.character).toMatchObject({ hpCurrent: 20, mpCurrent: 5 })
    expect(markCharacterDirty).toHaveBeenCalledTimes(1)
    expect(markCharacterDirty).toHaveBeenCalledWith(
      'char-1',
      expect.objectContaining({ hpCurrent: 20, mpCurrent: 5 }),
    )
    expect(events[1]).toMatchObject({ type: 'character:stats', hpCurrent: 20, mpCurrent: 5 })
  })

  it('인벤토리를 보존한다 (되쓰기가 라이브 엔트리를 통째로 갈아치우지 않는다)', () => {
    const item = makeObjectInstance({ _id: 'obj-7' })
    const { handler, liveRegistry } = setup({
      inventory: [item],
      creatures: [makeToughCreature()],
    })

    const events = run(handler, attackCommand('고블린'))

    // 되쓰기가 실제로 일어난 명령에서만 의미 있는 단언이다(공허한 통과 방지).
    expect(events[0]).toMatchObject({ type: 'combat:attacked' })
    expect(liveRegistry.get('char-1')?.inventory).toEqual([item])
  })

  it('되쓰기 직전에 라이브 엔트리를 다시 읽는다 (명령당 get 2회 이상)', () => {
    const { handler, liveGet } = setup({ creatures: [makeToughCreature()] })

    run(handler, attackCommand('고블린'))

    const selfReads = liveGet.mock.calls.filter(([id]) => id === 'char-1')
    expect(selfReads.length).toBeGreaterThanOrEqual(2)
  })
})

// ── 킬 경로 ──────────────────────────────────────────────────────────────────

describe('createAttackHandler — 킬 경로', () => {
  it('사망 seam이 올린 경험치를 되쓰기가 덮어쓰지 않는다', () => {
    const { handler, liveRegistry } = setup({
      character: makeCharacter({ _id: 'char-1', experience: 30, hpCurrent: 42, mpCurrent: 15 }),
      creatures: [makeFragileCreature()],
      carry: { hpCurrent: 20, mpCurrent: 5, nextAttackAt: NOW },
    })

    run(handler, attackCommand('고블린'))

    // E(30) + A(100) — 공격 시작 시점 스냅샷(30)으로 되쓰면 이 단언이 깨진다.
    expect(liveRegistry.get('char-1')?.character).toMatchObject({
      experience: 130,
      hpCurrent: 20,
      mpCurrent: 5,
    })
  })

  it('character:stats.experience가 되쓰기 후 문서와 같은 값이다', () => {
    const { handler, liveRegistry } = setup({
      character: makeCharacter({ _id: 'char-1', experience: 30 }),
      creatures: [makeFragileCreature()],
    })

    const events = run(handler, attackCommand('고블린'))

    expect(events[1]).toMatchObject({ type: 'character:stats', experience: 130 })
    expect(liveRegistry.get('char-1')?.character.experience).toBe(130)
  })

  it('사망 시 world:room을 세 번째 이벤트로 덧붙이고 죽은 크리처를 뺀다', () => {
    const { handler } = setup({ creatures: [makeFragileCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      type: 'combat:attacked',
      died: true,
      targetInstanceId: '1:c0',
    })
    const roomEvent = events[2]
    expect(roomEvent).toMatchObject({ type: 'world:room', roomId: 1 })
    const creatures =
      roomEvent !== undefined && 'creatures' in roomEvent ? roomEvent.creatures : undefined
    expect(creatures).toEqual([])
  })

  it('사망 경로 이벤트도 와이어 계약을 통과한다', () => {
    const { handler } = setup({ creatures: [makeFragileCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(3) // 빈 배열을 순회하며 통과하는 공허한 단언 방지.
    for (const event of events) {
      expect(serverEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('원장이 사망 후 폐기된다 (같은 instanceId 재조회가 빈 원장)', () => {
    const { handler, ledgers } = setup({ creatures: [makeFragileCreature()] })

    const events = run(handler, attackCommand('고블린'))

    expect(events[0]).toMatchObject({ type: 'combat:attacked', died: true })
    expect(ledgers.for('1:c0').size).toBe(0)
  })
})

// ── 배선 계약 (스냅샷 1회·도달 불가 갈래) ──────────────────────────────────────

describe('createAttackHandler — 배선 계약', () => {
  // flags 1회 단언과 대칭이다. now()를 두 번 부르면 쿨다운 비교와 flags 만료 판정이 서로 다른
  // 시점을 보게 되어, 경계 틱에서 "쿨다운은 지났는데 실명은 아직"처럼 판정이 갈린다.
  it('now()를 명령당 정확히 1회 부른다', () => {
    const { handler, nowFn } = setup({ creatures: [makeToughCreature()] })
    nowFn.mockClear() // 시드 조립에서 쓴 호출을 계수에서 제외한다.

    run(handler, attackCommand('고블린'))

    expect(nowFn).toHaveBeenCalledTimes(1)
  })

  // 되쓰기 직전 재조회가 빈손이면 배선 오류다 — 사망 seam이 엔트리를 지우는 경로가 이 토픽에 없다.
  // 이 갈래를 비워 두면 실제로 그런 배선이 생겼을 때 undefined 역참조로 터진다.
  it('되쓰기 직전 재조회가 빈손이면 error{internal}로 격리한다', () => {
    const { handler, liveRegistry } = setup({ creatures: [makeToughCreature()] })
    // 첫 조회(핸들러 진입)는 통과시키고 두 번째(되쓰기 직전)만 빈손으로 만든다.
    const real = liveRegistry.get.bind(liveRegistry)
    let calls = 0
    vi.spyOn(liveRegistry, 'get').mockImplementation((id) => {
      calls += 1
      return calls === 1 ? real(id) : undefined
    })

    const events = run(handler, attackCommand('고블린'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'internal' })
  })

  // firePlayerDeath는 이 토픽에서 구조적으로 도달 불가하다(몬스터 미반격·PvP 미배선).
  // 그 사실을 회귀로 잠근다 — 도달하면 배선 오류이고 사망 seam이 로그만 남긴다.
  it('플레이어 사망 seam은 발화하지 않는다 (몬스터가 반격하지 않는다)', () => {
    const { handler, logger } = setup({ creatures: [makeFragileCreature()] })

    run(handler, attackCommand('고블린'))

    expect(logger.error).not.toHaveBeenCalled()
  })
})
