import { describe, it, expect, vi } from 'vitest'
import {
  neededExp,
  resolveHpMax,
  resolveMpMax,
  serverEventSchema,
  type Character,
  type ClientCommand,
  type ObjectInstance,
  type RoomNode,
  type ServerEvent,
} from 'shared'
import { setFlag } from '../../world/door.js'
import { RTRAIN, goldToTrain } from '../../progression/train.js'
import { trainingFlagsForClass } from '../../progression/train.testutil.js'
import {
  createLiveCharacterRegistry,
  type LiveCharacter,
} from '../../world/liveCharacterRegistry.js'
import { createMarkCharacterDirty } from '../../world/markCharacterDirty.js'
import type { ActorContext } from '../actorContext.js'
import { createTrainHandler, type TrainHandlerDeps } from './train.js'
import { dispatch, createCommandRegistry, normalizeHandlerEvents } from '../router.js'
import type { ChannelPort } from '../channelPort.js'
import type { PermissionPort } from '../permissionPort.js'

/**
 * progress:train 핸들러 스펙 — 라이브 레지스트리·방 해소·train() 3게이트를 하나의 명령 경로로 배선한다.
 *
 * 픽스처(방 flags·class·level·exp·gold 임계)는 progression/train.test.ts의 것을 그대로 재사용한다 —
 * RTRAIN base 비트 + class-bit 역순 매칭과 neededExp/goldToTrain 임계를 여기서 재유도하지 않는다
 * (같은 값의 출처가 둘이 되면 드리프트한다).
 */

// ── 픽스처 (progression/train.test.ts 미러) ──────────────────────────────────

/** 지정 비트들을 세팅한 방 flags(number[] 바이트 배열)를 만든다. */
function roomFlags(...bits: number[]): number[] {
  const flags: number[] = [0]
  for (const b of bits) setFlag(flags, b)
  return flags
}

/** 주어진 flags를 가진 최소 유효 RoomNode. train()은 flags만 읽지만 deps 계약은 RoomNode다. */
function makeRoom(roomId: number, flags: number[]): RoomNode {
  return {
    roomId,
    name: `방-${roomId}`,
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

/**
 * 유효 Character 픽스처 — progression/train.test.ts의 makeChar 미러.
 *
 * `alignment`는 v6에서 **required로 승격**돼 더는 생략할 수 없다(부재 문서의 sentinel 0 시딩은
 * backfillCharacterV6 소관). train 경로가 alignment를 한 번도 읽지 않는다는 사실(checkLocation·
 * neededExp·goldToTrain·classifyPrestige·upLevel·resync 전 구간)은 그대로이나, 그 사실을 "필드를
 * 생략한 문서"로 표현하는 것이 타입상 불가해졌으므로 형제 픽스처 관례대로 `1`을 싣는다.
 */
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    _id: 'char-1',
    name: '타이',
    class: 1,
    race: 2,
    stats: [10, 10, 10, 10, 10],
    gold: 0,
    currentRoom: 1,
    level: 1,
    hpCurrent: 55,
    mpCurrent: 40,
    experience: 0,
    spells: new Array<number>(16).fill(0),
    realm: [0, 0, 0, 0],
    schemaVersion: 6,
    accountId: 'acc-1',
    status: 'active',
    alignment: 1,
    ...overrides,
  }
}

const actor: ActorContext = { accountId: 'acc-1', characterId: 'char-1' }

/** 정확히 1레벨분 exp·gold를 가진 class1 L2 캐릭터(성공 경로 표준 픽스처). */
const SUCCESS_LEVEL = 2
/** 무적 승급 경계 레벨(shared prestige의 INVINCIBLE_LEVEL). class<9면 이 레벨에서 승급한다. */
const PRESTIGE_LEVEL = 100
/** 무적 class 인덱스 — 승급 후 형상의 최대치 파생 입력이다. */
const INVINCIBLE_CLASS = 9
const SUCCESS_EXP = neededExp(SUCCESS_LEVEL)
const SUCCESS_GOLD = goldToTrain(SUCCESS_LEVEL)

function makeSuccessChar(overrides: Partial<Character> = {}): Character {
  return makeChar({
    class: 1,
    level: SUCCESS_LEVEL,
    experience: SUCCESS_EXP,
    gold: SUCCESS_GOLD,
    ...overrides,
  })
}

/**
 * 핸들러 deps 조립기 — 라이브 엔트리·방을 주입하고 markCharacterDirty spy를 노출한다.
 *
 * `live.inventory`는 생략 가능하다(기본 빈 인벤). 연마는 소지품을 읽지도 쓰지도 않으므로 대부분의
 * 케이스가 인벤을 진술할 이유가 없고, 인벤 보존 회귀 테스트만 명시적으로 채워 넣는다.
 */
function makeDeps(options: {
  live?: { character: Character; inventory?: readonly ObjectInstance[] }
  room?: RoomNode
  registry?: ReturnType<typeof createLiveCharacterRegistry>
}) {
  const markDirty = vi.fn()
  const registry = options.registry ?? createLiveCharacterRegistry()
  if (options.live !== undefined) {
    const live: LiveCharacter = {
      character: options.live.character,
      inventory: options.live.inventory ?? [],
    }
    registry.register(live)
  }
  const resolveRoom = vi.fn((_characterId: string) => options.room)
  return {
    markDirty,
    registry,
    resolveRoom,
    deps: {
      liveRegistry: registry,
      resolveRoom,
      markCharacterDirty: createMarkCharacterDirty(markDirty),
    },
  }
}

/**
 * 핸들러 반환을 항상 배열로 정규화한다 — 성공 경로는 2개(`[progress:trained, character:stats]`),
 * 거부 경로는 1개다.
 *
 * 프로덕션 `dispatch`가 쓰는 것과 **같은** 정규화 함수를 쓴다. 여기서 `Array.isArray` 분기를 손으로
 * 다시 적으면 배열 판별 규칙의 출처가 둘이 되어, 라우터가 정규화 규칙을 바꿔도 이 테스트는 계속 통과한다.
 */
function run(deps: TrainHandlerDeps, command: ClientCommand): readonly ServerEvent[] {
  return normalizeHandlerEvents(createTrainHandler(deps)(command, actor))
}

describe('createTrainHandler', () => {
  describe('성공 경로', () => {
    it('progress:trained·character:stats 2개를 순서대로 낸다', () => {
      const character = makeSuccessChar()
      const { deps } = makeDeps({
        live: { character },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: 'progress:trained',
        level: SUCCESS_LEVEL + 1,
        levelsGained: 1,
        gold: 0,
        prestige: 'none',
      })
      expect(events[1]).toMatchObject({ type: 'character:stats' })
    })

    it('발화 이벤트가 전부 와이어 계약(serverEventSchema)을 통과한다', () => {
      const { deps } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      expect(events).toHaveLength(2) // 빈 배열을 순회하며 통과하는 공허한 단언 방지.
      for (const event of events) {
        expect(serverEventSchema.safeParse(event).success).toBe(true)
      }
      const parsed = serverEventSchema.safeParse(events[0])
      if (parsed.success && parsed.data.type === 'progress:trained') {
        // stats는 5-튜플로 그대로 전달된다(map/spread로 넓히면 타입·길이 계약이 깨진다).
        expect(parsed.data.stats).toHaveLength(5)
      }
    })

    /**
     * D10 — 스탯 통지는 `character:stats` 하나로 통일한다. 이 이벤트는 **연마가 확정한 문서**에서
     * 투영해야 한다. 명령 시작 시점 문서(`live.character`)로 투영하면 클라이언트가 한 박자 뒤처진
     * 레벨·경험치를 받는다.
     */
    it('character:stats가 연마 후 확정 문서의 level·experience를 싣는다', () => {
      const { deps } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      // train()은 exp를 깎지 않으므로 experience는 그대로이고 level만 오른다.
      expect(events[1]).toMatchObject({
        type: 'character:stats',
        level: SUCCESS_LEVEL + 1,
        experience: SUCCESS_EXP,
      })
    })

    /**
     * `hpMax`·`mpMax`는 문서에 없고 `class`·`level`에서 매번 파생한다(compute-on-read). 따라서
     * **레벨이 오르면 최대치도 바뀐다** — 이 케이스가 "낡은 문서로 투영" 변이를 잡는 지점이다.
     */
    it('character:stats의 hpMax·mpMax가 연마 후 레벨의 resolveHpMax·resolveMpMax와 일치한다', () => {
      const before = makeSuccessChar()
      const { deps, registry } = makeDeps({
        live: { character: before },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      const after = registry.get('char-1')?.character
      expect(after?.level).toBe(SUCCESS_LEVEL + 1)
      const grown = { class: before.class, level: SUCCESS_LEVEL + 1 }
      expect(events[1]).toMatchObject({
        type: 'character:stats',
        hpMax: resolveHpMax(grown),
        mpMax: resolveMpMax(grown),
      })
      // 비-공허 근거: 연마 전후의 최대치가 실제로 다르다. 같다면 위 단언은 낡은 문서로 투영해도
      // 통과하므로 계약을 검증하지 못한다.
      expect(resolveHpMax(before)).not.toBe(resolveHpMax(grown))
      expect(resolveMpMax(before)).not.toBe(resolveMpMax(grown))
    })

    /**
     * 승급(무적) 경로가 **가장 강한 stale-투영 검출기**다. 일반 연마는 레벨이 +1이지만 승급은
     * `level 100 → 1`·`experience → 0`·`class → 9`로 전 필드가 크게 튄다. 게다가
     * `progress:trained`만 보면 `levelsGained: 0`이라 아무 일도 없었던 것처럼 보이고, 실제 변화는
     * 오직 `character:stats`에만 나타난다 — 이 Story가 추가한 계약이 이 경로에서 특히 load-bearing이다.
     */
    it('승급(무적) 경로에서도 character:stats가 전이 후 문서를 싣는다', () => {
      const before = makeChar({
        class: 1,
        level: PRESTIGE_LEVEL,
        experience: neededExp(PRESTIGE_LEVEL),
        gold: goldToTrain(PRESTIGE_LEVEL),
      })
      const { deps } = makeDeps({
        live: { character: before },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: 'progress:trained',
        levelsGained: 0,
        prestige: 'invincible',
      })
      // 전이 후 형상: class 9·level 1·experience 0. 시작 시점 문서로 투영하면 셋 다 틀린다.
      const promoted = { class: INVINCIBLE_CLASS, level: 1 }
      expect(events[1]).toMatchObject({
        type: 'character:stats',
        level: 1,
        experience: 0,
        hpMax: resolveHpMax(promoted),
        mpMax: resolveMpMax(promoted),
      })
      // 비-공허 근거: 승급 전후 최대치가 실제로 다르다(hpCurrent·mpCurrent도 풀회복으로 함께 튄다).
      expect(resolveHpMax(before)).not.toBe(resolveHpMax(promoted))
      expect(events[1]).toMatchObject({
        hpCurrent: resolveHpMax(promoted),
        mpCurrent: resolveMpMax(promoted),
      })
    })

    it('character:stats의 hpCurrent·mpCurrent가 라이브 엔트리의 확정 값과 일치한다', () => {
      const { deps, registry } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const events = run(deps, { type: 'progress:train' })

      const after = registry.get('char-1')?.character
      expect(after).toBeDefined()
      expect(events[1]).toMatchObject({
        type: 'character:stats',
        hpCurrent: after?.hpCurrent,
        mpCurrent: after?.mpCurrent,
      })
    })

    it('alignment 값과 무관하게 성공한다 (OQ5 — train 경로는 alignment를 읽지 않는다)', () => {
      // v6에서 alignment가 required가 돼 "필드를 생략한 문서"로는 이 사실을 표현할 수 없다.
      // 대신 세 값(중립 sentinel 0 · 선 1 · 악 2) 전부에서 성공 경로가 동일함을 고정한다 —
      // 어느 값에서든 분기하면 train이 alignment를 읽고 있다는 뜻이다.
      for (const alignment of [0, 1, 2]) {
        const { deps } = makeDeps({
          live: { character: makeSuccessChar({ alignment }) },
          room: makeRoom(1, trainingFlagsForClass(1)),
        })

        const events = run(deps, { type: 'progress:train' })

        expect(events[0]).toMatchObject({ type: 'progress:trained' })
      }
    })

    it('markCharacterDirty가 정확히 1회 호출된다 (핸들러 중복 마킹 없음 — train.finalize가 소유)', () => {
      const { deps, markDirty } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      createTrainHandler(deps)({ type: 'progress:train' }, actor)

      expect(markDirty).toHaveBeenCalledTimes(1)
      expect(markDirty.mock.calls[0]?.slice(0, 2)).toEqual(['characters', 'char-1'])
      const snapshot = markDirty.mock.calls[0]?.[2] as Character
      expect(snapshot.level).toBe(SUCCESS_LEVEL + 1)
    })

    it('성공 시 라이브 엔트리를 새 Character로 교체한다', () => {
      const { deps, registry } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      createTrainHandler(deps)({ type: 'progress:train' }, actor)

      expect(registry.get('char-1')?.character.level).toBe(SUCCESS_LEVEL + 1)
      expect(registry.get('char-1')?.character.gold).toBe(0)
    })
  })

  describe('거부 사유 5종 → rule_rejected + 한국어 message', () => {
    /** 사유별 픽스처 — 각 케이스는 선행 게이트를 모두 통과하는 입력을 쓴다(다층 guard 원칙). */
    const cases: { name: string; character: Character; flags: number[] }[] = [
      {
        name: 'not-training-room',
        character: makeChar({ class: 1 }),
        flags: roomFlags(), // 아무 비트도 없음
      },
      {
        name: 'class-mismatch',
        // class2(idx=1) → 방은 bit6이어야 하는데 bit4만 set → 역순 매칭 실패.
        character: makeChar({ class: 2, level: 1, experience: 0, gold: 0 }),
        flags: roomFlags(RTRAIN, 4),
      },
      {
        name: 'caretaker-forbidden',
        character: makeChar({ class: 10, level: 127 }),
        flags: trainingFlagsForClass(10),
      },
      {
        name: 'insufficient-exp',
        // location 통과, exp만 부족(gold는 충분).
        character: makeChar({ class: 1, level: 2, experience: 0, gold: 1_000_000_000 }),
        flags: trainingFlagsForClass(1),
      },
      {
        name: 'insufficient-gold',
        // location·exp 통과, gold만 1 부족.
        character: makeChar({
          class: 1,
          level: 2,
          experience: neededExp(2),
          gold: goldToTrain(2) - 1,
        }),
        flags: trainingFlagsForClass(1),
      },
    ]

    it.each(cases)(
      '$name → rule_rejected + 비어 있지 않은 한국어 message',
      ({ character, flags }) => {
        const { deps, markDirty } = makeDeps({
          live: { character },
          room: makeRoom(1, flags),
        })

        const event = createTrainHandler(deps)({ type: 'progress:train' }, actor)

        expect(event).toMatchObject({ type: 'error', code: 'rule_rejected' })
        const message = (event as { message: string }).message
        expect(message.length).toBeGreaterThan(0)
        // 한글이 실제로 들어 있어야 한다(미사상 사유가 빈/영문 message로 새는 것을 막는다).
        expect(message).toMatch(/[가-힣]/)
        expect(markDirty).not.toHaveBeenCalled()
      },
    )

    it('거부 사유 5종이 서로 다른 message를 갖는다 (사유별 사상 누락 적발)', () => {
      const messages = cases.map(({ character, flags }) => {
        const { deps } = makeDeps({ live: { character }, room: makeRoom(1, flags) })
        const event = createTrainHandler(deps)({ type: 'progress:train' }, actor)
        return (event as { message: string }).message
      })
      expect(new Set(messages).size).toBe(cases.length)
    })

    /**
     * 거부는 error 이벤트 **1개**다 — 상태가 바뀌지 않았으므로 스탯 스냅샷을 덧붙이지 않는다.
     * 성공 경로만 배열을 낸다는 계약을 여기서 고정한다.
     */
    it.each(cases)(
      '$name 거부는 이벤트 1개만 낸다 (character:stats 없음)',
      ({ character, flags }) => {
        const { deps } = makeDeps({ live: { character }, room: makeRoom(1, flags) })

        const events = run(deps, { type: 'progress:train' })

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ type: 'error', code: 'rule_rejected' })
      },
    )

    it('id가 있으면 rule_rejected 이벤트에 correlationId를 반향한다', () => {
      const { deps } = makeDeps({
        live: { character: makeChar({ class: 1 }) },
        room: makeRoom(1, roomFlags()),
      })

      const event = createTrainHandler(deps)({ type: 'progress:train', id: 't9' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'rule_rejected', correlationId: 't9' })
    })
  })

  describe('배선 격리 (internal)', () => {
    it('라이브 미등록 actor면 error{internal}, train 미실행', () => {
      const { deps, markDirty, resolveRoom } = makeDeps({
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      const event = createTrainHandler(deps)({ type: 'progress:train', id: 't1' }, actor)

      expect(event).toMatchObject({ type: 'error', code: 'internal', correlationId: 't1' })
      expect(markDirty).not.toHaveBeenCalled()
      // 라이브 조회가 먼저 실패하므로 방 해소까지 가지 않는다.
      expect(resolveRoom).not.toHaveBeenCalled()
    })

    it('방이 해소되지 않으면 error{internal} 1개, train 미실행', () => {
      const { deps, markDirty } = makeDeps({
        live: { character: makeSuccessChar() },
        room: undefined,
      })

      const events = run(deps, { type: 'progress:train', id: 't2' })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'error', code: 'internal', correlationId: 't2' })
      expect(markDirty).not.toHaveBeenCalled()
    })

    it('방 해소는 actor.characterId로 조회한다', () => {
      const { deps, resolveRoom } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })

      createTrainHandler(deps)({ type: 'progress:train' }, actor)

      expect(resolveRoom).toHaveBeenCalledWith('char-1')
    })

    it('defensive narrow: progress:train이 아닌 명령은 undefined를 반환한다', () => {
      const { deps } = makeDeps({
        live: { character: makeSuccessChar() },
        room: makeRoom(1, trainingFlagsForClass(1)),
      })
      expect(createTrainHandler(deps)({ type: 'debug:echo', text: '핑' }, actor)).toBeUndefined()
    })
  })
})

// ── 조건부 등록 + 라이브 엔트리 교체 불변식 ──────────────────────────────────

describe('createCommandRegistry — progress:train 조건부 등록', () => {
  const testChannelPort: ChannelPort = { deliver: () => {} }
  const testPermission: PermissionPort = { check: () => true }
  const denyPermission: PermissionPort = { check: () => false }

  function makeTrainDeps() {
    return makeDeps({
      live: { character: makeSuccessChar() },
      room: makeRoom(1, trainingFlagsForClass(1)),
    })
  }

  it('train deps 없이 만들면 progress:train은 미등록 → unknown_type', () => {
    const registry = createCommandRegistry(testChannelPort)
    const result = dispatch(registry, { type: 'progress:train' }, actor, testPermission)
    expect(result.outcome).toBe('rejected')
    expect(result.events[0]).toMatchObject({ type: 'error', code: 'unknown_type' })
  })

  it('train deps를 주면 progress:train이 train 핸들러로 디스패치된다 (permissive 어댑터 — OQ3 기본 allow)', () => {
    const { deps } = makeTrainDeps()
    const registry = createCommandRegistry(testChannelPort, { train: deps })

    const result = dispatch(registry, { type: 'progress:train' }, actor, testPermission)

    expect(result.outcome).toBe('handled')
    // dispatch가 핸들러의 배열 반환을 그대로 정규화해 내보낸다(스탯 통지가 소켓까지 나간다).
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toMatchObject({
      type: 'progress:trained',
      level: SUCCESS_LEVEL + 1,
      levelsGained: 1,
    })
    expect(result.events[1]).toMatchObject({ type: 'character:stats', level: SUCCESS_LEVEL + 1 })
  })

  it('deny 어댑터에서는 핸들러 이전에 forbidden으로 거부된다 (OQ3)', () => {
    const { deps, markDirty } = makeTrainDeps()
    const registry = createCommandRegistry(testChannelPort, { train: deps })

    // 형식 검증(safeParse)을 통과하는 완전한 payload를 보낸다 — 선행 guard에서 떨어지면 bad_payload가
    // 나와 권한 레이어를 검증하지 못한다(.harness/rules/testing.md 다층 guard 원칙).
    const result = dispatch(registry, { type: 'progress:train', id: 'p1' }, actor, denyPermission)

    expect(result.outcome).toBe('rejected')
    expect(result.events[0]).toMatchObject({
      type: 'error',
      code: 'forbidden',
      correlationId: 'p1',
    })
    // 권한 레이어가 핸들러 진입 자체를 막았다(연마가 실행되지 않았다).
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('알 수 없는 키를 실은 progress:train은 bad_payload로 떨어진다 (strictObject)', () => {
    const { deps } = makeTrainDeps()
    const registry = createCommandRegistry(testChannelPort, { train: deps })

    const result = dispatch(registry, { type: 'progress:train', extra: 1 }, actor, testPermission)

    expect(result.outcome).toBe('rejected')
    expect(result.events[0]).toMatchObject({ type: 'error', code: 'bad_payload' })
  })

  /**
   * 라이브 엔트리 교체 불변식(T3.10).
   *
   * train()은 새 Character를 반환하고 LiveCharacter.character는 readonly라, 핸들러는 registry.register로
   * 엔트리를 통째로 교체한다. 이 설계는 **턴 밖으로 LiveCharacter 참조를 보유하는 코드가 0건**이라는
   * 불변식 위에 서 있다. 후속 토픽이 live를 캐시하면(예: 세션 바인딩에 LiveCharacter를 들고 있으면)
   * 두 번째 디스패치가 갱신 이전의 stale 객체를 보게 되어 이 테스트가 깨진다 — 그때 신호를 준다.
   *
   * 비-vacuous 근거: train은 experience를 깎지 않으므로, 정확히 1레벨분 exp로 시작하면 1회 성공 후
   * 임계가 올라 두 번째 호출은 insufficient-exp가 된다. 엔트리가 교체되지 않아 stale(level 2, exp
   * 임계 충족)이었다면 두 번째 호출도 성공했을 것이므로, 거부 코드 자체가 교체를 증명한다.
   */
  it('연마 성공 후 후속 명령이 교체된 새 라이브 객체를 관측한다', () => {
    const { deps, registry: liveRegistry } = makeTrainDeps()
    const registry = createCommandRegistry(testChannelPort, { train: deps })

    const first = dispatch(registry, { type: 'progress:train' }, actor, testPermission)
    expect(first.events[0]).toMatchObject({ type: 'progress:trained', level: SUCCESS_LEVEL + 1 })

    // 후속 명령 — stale 엔트리였다면 다시 성공했을 입력이다.
    const second = dispatch(registry, { type: 'progress:train' }, actor, testPermission)
    expect(second.events[0]).toMatchObject({ type: 'error', code: 'rule_rejected' })

    // 라이브 단일 출처도 상승한 level·차감된 gold를 보유한다.
    expect(liveRegistry.get('char-1')?.character.level).toBe(SUCCESS_LEVEL + 1)
    expect(liveRegistry.get('char-1')?.character.gold).toBe(0)
  })

  /**
   * 인벤 보존 회귀 — 엔트리 교체는 **character만** 갈아끼워야 한다.
   *
   * 핸들러가 `register({ character })`처럼 새 객체를 통째로 만들면 인벤이 조용히 사라진다. 진입에서
   * 한 번만 적재하는 설계라 그 손실을 되돌릴 경로가 없다(다음 재접속까지 빈손이 된다).
   */
  it('연마 성공 후에도 라이브 엔트리의 인벤토리가 유실되지 않는다', () => {
    const book: ObjectInstance = {
      _id: 'obj-book',
      objnum: 42,
      type: 7,
      owner: { type: 'character', id: 'char-1' },
      slot: null,
      equipped: false,
      value: 100,
      shotscur: 0,
      schemaVersion: 1,
    }
    const { deps, registry: liveRegistry } = makeDeps({
      live: { character: makeSuccessChar(), inventory: [book] },
      room: makeRoom(1, trainingFlagsForClass(1)),
    })
    const registry = createCommandRegistry(testChannelPort, { train: deps })

    const result = dispatch(registry, { type: 'progress:train' }, actor, testPermission)
    expect(result.events[0]).toMatchObject({ type: 'progress:trained' })

    expect(liveRegistry.get('char-1')?.inventory).toEqual([book])
  })
})
