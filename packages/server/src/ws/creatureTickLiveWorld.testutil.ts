import { afterEach, expect, vi } from 'vitest'
import {
  characterSchema,
  serverEventSchema,
  type Character,
  type CreatureInstance,
  type RoomNode,
  type ServerEvent,
} from 'shared'
import type { CombatRng } from '../combat/dice.js'
import { monsterDamage, playerBaseDamage } from '../combat/attackStats.js'
import { toCombatant } from '../combat/combatant.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import { createCombatTickBinding } from '../world/combatTickBinding.js'
import { combatRngScript } from './scriptedCombatRng.testutil.js'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { createWorldRuntime, type WorldRuntime } from '../world/worldRuntime.js'
import type { WorldTickSlot } from '../world/worldClock.js'
import { makeCharacter } from '../world/characterFixtures.testutil.js'
import { makeCreature, makeRoom } from '../world/roomFixtures.testutil.js'
import { F_SET } from '../world/hexFlags.js'
import { DEFAULT_REVIVE_ROOM } from '../progression/death.js'
import {
  createLiveWorldWiring,
  type LiveWorldWiring,
  type LiveWorldWiringBundle,
} from './liveWorldWiring.js'

/**
 * 몬스터 전투 tick 프로덕션 조립 통합 하네스(test-only) — 스펙 G4.
 *
 * boot(`index.ts`)의 조립 순서를 그대로 따른다:
 *   `createCombatTickBinding()` → `createWorldRuntime(worldGraph, { now, onCombatTick: binding.onCombatTick })`
 *   → 묶음 `bindCombatTick: (h) => binding.bind(h)` → `createLiveWorldWiring(bundle, { sendToCharacter })`.
 * 묶음의 `onRoomEntered`/`onRoomLeft`·`spawnTemplates`·`alloc`도 boot처럼 worldRuntime 산출물을 싣는다 —
 * 사망 seam의 부활 이동이 실 활성 집합을 갱신해야 출발 방 동결(빈 방 시간 정지)을 관측할 수 있다.
 *
 * boot와의 차이(이 하네스가 검증하지 않는 것):
 * - worldRuntime에 `templates: new Map()`·`events: []`를 넘겨 디스크 로드(creatures.json·events.json)를 격리한다.
 *   스폰·침공 슬롯은 시나리오에 개입하지 않는다.
 * - `LiveWorldWiringBundle` 리터럴은 하네스가 직접 만든다. 그래서 boot가 묶음 각 필드(특히 `bindCombatTick`)에
 *   무엇을 싣는지 자체는 검출되지 않는다(`index.ts`는 커버리지 제외 연결 코드) — 검증 대상은 같은 순서로
 *   조립했을 때의 슬롯·worldRuntime·wiring 연결이다.
 *
 * 월드 틱은 `WorldClock` 대신 크리처 tick 슬롯의 `run(tick)`을 수동 실행한다. `now`는 하네스의 가변
 * 시계 하나를 묶음·worldRuntime이 공유한다(boot의 `() => worldClock.currentTick()` 단일 출처 관례).
 *
 * 굴림은 테스트 파일의 `vi.mock('../combat/dice.js', ...)`가 `defaultCombatRng`를 스크립트 큐
 * (`scriptedCombatRng.testutil.ts`)로 바꿔 고정한다. 이 하네스는 굴림 seam을 알지 못한다.
 */

/** 전투 방. 출구가 없어 이동 게이트가 개입하지 않는다. */
export const ARENA = 100
/** 부활 방(1008). 부팅 검증(D9) 대상과 같은 번호다. */
export const REVIVE = DEFAULT_REVIVE_ROOM
/** 첫 tick 시각. 활성화 시각과 같아 몬스터 재생(활성화 후 60초)이 시나리오에 끼어들지 않는다. */
export const START_TICK = 10

// ── 굴림 값 상수 — 전제는 메인 통합 테스트의 결정성 전제 `it`이 프로덕션 공식으로 단언한다. ──
/** 몬스터 근접 명중 굴림 `rng(1,20)` 최댓값 — 명중 임계 ≤ 20이면 항상 명중. */
export const MONSTER_HIT = 20
/** 플레이어 반격 명중 굴림 `rng(1,30)` 최댓값 — 명중 임계 ≤ 30이면 항상 명중. */
export const PLAYER_HIT = 30
/** 명중 굴림 최솟값 — 명중 임계 > 1이면 항상 빗맞음(몬스터·플레이어 공용). */
export const MISS = 1
/** 플레이어 맨손 피해 주사위 굴림 `rng(1,5)`(FIGHTER class_stats 1d5). */
export const COUNTER_DAMAGE_ROLL = 3
/** 크리티컬 굴림 `rng(1,100)` — 맨손 숙련 p=0이라 `roll <= 0`이 거짓(크리 없음). */
export const NO_CRIT = 50
/** MMAGIC 시전 확률 굴림 `rng(1,100)` — `<= 20`이면 시전 시도. */
export const CAST_PASS = 1
/** 아는 주문이 1개일 때의 주문 선택 굴림 `rng(1,1)`. */
export const SPELL_PICK = 1
/** 삭풍(SHURTS) 피해 주사위 굴림 `rng(1,8)` — 최댓값. HP 1 표적은 어떤 보너스에서도 죽는다(하한 1 클램프). */
export const SHURTS_ROLL = 8
/** 활력(SVIGOR) 회복 주사위 굴림 `rng(1,6)`. */
export const SVIGOR_ROLL = 4

/** 사망 1회를 가르는 경험치 — 손실(level<20: exp/20)이 레벨 하한보다 위에서 일어나 2회 적용과 구별된다. */
export const RICH_EXP = 100_000

/** 플레이어 반격 명중 1회 = 명중·피해·크리 3굴림(맨손 FIGHTER, PUPDMG 없음 → 다중공격 굴림 없음). */
export const COUNTER_HIT: readonly number[] = [PLAYER_HIT, COUNTER_DAMAGE_ROLL, NO_CRIT]

/** 주문 번호(mtype.h) — 비트 위치로 몬스터 spells에 싣는다. */
export const SVIGOR = 0
export const SHURTS = 1

/** 지정 주문 비트만 세팅한 몬스터 spells(32 hex). */
export function spellsWith(...spellNos: readonly number[]): string {
  return spellNos.reduce((hex, bit) => F_SET(hex, bit), '0'.repeat(32))
}

/**
 * 시나리오 몬스터 — 근접 피해 주사위가 없어(ndice 0) 근접 명중이 굴림 1개만 소비한다.
 * 피해 = max(1, pdice - trunc((70 - 방어자 armor)/5))로 굴림 없이 정해진다.
 */
export function monster(
  instanceId: string,
  name: string,
  overrides: Partial<CreatureInstance> = {},
): CreatureInstance {
  return makeCreature(instanceId, name, {
    level: 3,
    hpmax: 1000,
    hpcur: 1000,
    thaco: 15,
    armor: 0,
    ndice: 0,
    sdice: 0,
    pdice: 30,
    experience: 1000,
    intelligence: 10,
    piety: 10,
    ...overrides,
  })
}

/** 시나리오 플레이어 시드 — 공유 픽스처(FIGHTER, level 7, 맨손)에 id·이름·방만 얹는다. */
export function player(
  id: string,
  name: string,
  room: number,
  overrides: Partial<Character> = {},
): Character {
  return makeCharacter({ _id: id, name, currentRoom: room, accountId: `acct-${id}`, ...overrides })
}

export interface HarnessOptions {
  readonly arenaCreatures?: readonly CreatureInstance[]
  readonly reviveCreatures?: readonly CreatureInstance[]
  readonly seeds: readonly Character[]
}

export interface LiveWorldHarness {
  readonly wiring: LiveWorldWiring
  readonly worldRuntime: WorldRuntime
  readonly arena: RoomNode
  readonly revive: RoomNode
  /** 전송 spy — `createLiveWorldWiring`의 transport.sendToCharacter. */
  readonly send: ReturnType<typeof vi.fn<(characterId: string, event: ServerEvent) => void>>
  /** 저장 spy — 묶음 `markDirty`. */
  readonly markDirty: ReturnType<
    typeof vi.fn<(collection: string, id: string, snapshot: unknown) => void>
  >
  /** 묶음 logger spy — 몬스터 단위 격리 로그를 단언한다. */
  readonly logger: {
    readonly warn: ReturnType<typeof vi.fn>
    readonly error: ReturnType<typeof vi.fn>
  }
  now(): number
  setNow(tick: number): void
  /** hydrate → place로 세션 진입을 재현한다. */
  enter(characterId: string): Promise<void>
  /** 크리처 tick 슬롯을 현재 시각으로 1회 실행한다. */
  runCreatureTick(): void
  /** 한 캐릭터가 받은 이벤트(전송 순서). */
  eventsFor(characterId: string): ServerEvent[]
  /** 모든 전송 `[수신자, 이벤트]`(전송 순서). */
  allSent(): ReadonlyArray<readonly [string, ServerEvent]>
  clearSent(): void
  /** 라이브 캐릭터 문서(없으면 throw). */
  live(characterId: string): Character
  /** 라이브 전투상태(없으면 throw). */
  state(characterId: string): PlayerCombatState
  /** 마지막 `markDirty('characters', id, …)` 스냅샷 — 저장되는 문서. */
  lastSaved(characterId: string): Character | undefined
  /** 방의 몬스터를 instanceId로 다시 찾는다(autonomic이 객체를 교체하므로 참조를 들고 있지 않는다). */
  creatureIn(room: RoomNode, instanceId: string): CreatureInstance | undefined
}

/** 크리처 tick 슬롯을 worldRuntime 산출물에서 찾는다. */
function creatureTickSlot(runtime: WorldRuntime): WorldTickSlot {
  const slot = runtime.slots.find((s) => s.name === 'creatureTick')
  if (slot === undefined) throw new Error('creatureTick 슬롯이 조립되지 않았다')
  return slot
}

export function buildHarness(options: HarnessOptions): LiveWorldHarness {
  const arena = makeRoom({
    roomId: ARENA,
    name: '전투장',
    creatures: [...(options.arenaCreatures ?? [])],
  })
  const revive = makeRoom({
    roomId: REVIVE,
    name: '부활의 방',
    creatures: [...(options.reviveCreatures ?? [])],
  })
  const worldGraph = new Map<number, RoomNode>([
    [ARENA, arena],
    [REVIVE, revive],
  ])
  const seeds = new Map(options.seeds.map((c) => [c._id, c]))

  let clock = START_TICK
  const now = (): number => clock

  // boot와 같은 조립 순서 — 슬롯 1회 생성 → worldRuntime에 onCombatTick → 묶음에 bind.
  const combatTickBinding = createCombatTickBinding()
  const worldRuntime = createWorldRuntime(worldGraph, {
    now,
    templates: new Map(),
    events: [],
    onCombatTick: combatTickBinding.onCombatTick,
  })

  const liveRegistry = createLiveCharacterRegistry()
  const markDirty = vi.fn<(collection: string, id: string, snapshot: unknown) => void>()
  const send = vi.fn<(characterId: string, event: ServerEvent) => void>()
  const logger = { warn: vi.fn(), error: vi.fn() }
  const bundle: LiveWorldWiringBundle = {
    worldGraph,
    liveRegistry,
    characterRepo: {
      findById: (id) => Promise.resolve(seeds.get(id) ?? null),
      hydrateInventory: () => Promise.resolve([]),
    },
    objectTemplates: new Map(),
    spawnTemplates: worldRuntime.templates,
    alloc: worldRuntime.alloc,
    markDirty,
    peekPending: () => undefined,
    currentHour: () => 12,
    now,
    onRoomEntered: worldRuntime.onRoomEntered,
    onRoomLeft: worldRuntime.onRoomLeft,
    bindCombatTick: (handler) => combatTickBinding.bind(handler),
    logger,
  }
  const wiring = createLiveWorldWiring(bundle, { sendToCharacter: send })
  const slot = creatureTickSlot(worldRuntime)

  return {
    wiring,
    worldRuntime,
    arena,
    revive,
    send,
    markDirty,
    logger,
    now,
    setNow: (tick) => {
      clock = tick
    },
    async enter(characterId) {
      const live = await wiring.liveWorldBinding.entry.hydrate(characterId)
      wiring.liveWorldBinding.entry.place(live)
    },
    runCreatureTick: () => slot.run(clock),
    eventsFor: (characterId) =>
      send.mock.calls.filter(([id]) => id === characterId).map(([, event]) => event),
    allSent: () => send.mock.calls.map(([id, event]) => [id, event] as const),
    clearSent: () => send.mockClear(),
    live(characterId) {
      const live = liveRegistry.get(characterId)
      if (live === undefined) throw new Error(`라이브 엔트리 없음: ${characterId}`)
      return live.character
    },
    state(characterId) {
      const state = wiring.combatRegistry.get(characterId)
      if (state === undefined) throw new Error(`전투상태 없음: ${characterId}`)
      return state
    },
    lastSaved(characterId) {
      const calls = markDirty.mock.calls.filter(
        ([collection, id]) => collection === 'characters' && id === characterId,
      )
      const last = calls[calls.length - 1]
      return last === undefined ? undefined : characterSchema.parse(last[2])
    },
    creatureIn: (room, instanceId) => room.creatures.find((c) => c.instanceId === instanceId),
  }
}

// ── 단언 헬퍼 ────────────────────────────────────────────────────────────────

export type RoundEvent = Extract<ServerEvent, { type: 'combat:round' }>
export type StatsEvent = Extract<ServerEvent, { type: 'character:stats' }>

/** 이벤트 목록에서 그 type이 정확히 1건임을 단언하고 좁힌 값을 돌려준다. */
export function only<T extends ServerEvent['type']>(
  events: readonly ServerEvent[],
  type: T,
): Extract<ServerEvent, { type: T }> {
  const matches = events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type)
  expect(matches).toHaveLength(1)
  const [event] = matches
  if (event === undefined) throw new Error(`${type} 이벤트 없음`)
  return event
}

/** 굴림 없는 피해 산출용 rng — 호출되면 굴림 예산 계산이 틀린 것이다. */
const noRoll: CombatRng = (min, max) => {
  throw new Error(`굴림 없는 피해 산출에서 rng(${min}, ${max}) 호출`)
}

/** 시나리오 몬스터(근접 주사위 없음)의 근접 피해 — 프로덕션 `monsterDamage`로 산출한다. */
export function expectedMonsterDamage(
  creature: CreatureInstance,
  target: PlayerCombatState,
): number {
  return monsterDamage(toCombatant(creature), toCombatant(target), noRoll)
}

/** `COUNTER_DAMAGE_ROLL`로 굴린 맨손 반격 피해 — 프로덕션 `playerBaseDamage` + 하한 1 클램프. */
export function expectedCounterDamage(state: PlayerCombatState): number {
  return Math.max(
    1,
    playerBaseDamage(toCombatant(state), () => COUNTER_DAMAGE_ROLL),
  )
}

/** 하네스가 보낸 모든 이벤트가 shared 와이어 스키마를 통과한다(클라이언트가 같은 스키마로 safeParse한다). */
export function expectAllSentWireValid(h: LiveWorldHarness): void {
  for (const [, event] of h.allSent()) {
    expect(serverEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
  }
}

/**
 * 테스트 파일 최상위에서 1회 호출한다. 반환 함수로 만든 하네스를 추적하고, 각 `it` 뒤(afterEach)에 그 하네스가
 * 보낸 모든 이벤트의 와이어 스키마를 검사한 뒤 굴림 큐를 비운다. `vi.mock` 블록은 호이스팅 때문에 파일마다 둔다.
 */
export function useTrackedHarness(): (options: HarnessOptions) => LiveWorldHarness {
  let current: LiveWorldHarness | undefined
  afterEach(() => {
    if (current !== undefined) expectAllSentWireValid(current)
    current = undefined
    combatRngScript.reset()
  })
  return (options) => {
    current = buildHarness(options)
    return current
  }
}
