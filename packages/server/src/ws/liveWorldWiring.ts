import type { Character, ObjectInstance, RoomNode, ServerEvent } from 'shared'
import type { ObjectTemplateIndex } from '../items/objectTemplate.js'
import {
  createLiveCharacterEntry,
  type EntryLogger,
  type LiveCharacterEntry,
} from '../world/liveCharacterEntry.js'
import type { LiveCharacter, LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { InstanceIdAllocator, SpawnTemplateIndex } from '../world/spawn.js'
import { composeCharacterFlags } from '../character/flags.js'
import { assemblePlayerCombatState } from '../combat/assemblePlayerCombatState.js'
import { createCombatRegistry, type CombatRegistry } from '../combat/combatRegistry.js'
import { createCreatureLedgers } from '../combat/creatureLedgers.js'
import { defaultCombatRng } from '../combat/dice.js'
import {
  CHARACTERS_COLLECTION,
  createMarkCharacterDirty,
  type MarkCharacterDirty,
} from '../world/markCharacterDirty.js'
import {
  createRoomPlayerResolver,
  resolveRoomCreature,
  type RoomCreatureResolver,
  type RoomPlayerResolver,
} from '../world/roomTargetResolvers.js'
import { defaultFleeRng, type MoveActor, type TryMoveDeps } from '../world/tryMove.js'
import { createMarkObjectDeleted } from '../save/markObjectDeleted.js'
import type { MoveHandlerDeps } from './handlers/move.js'
import type { TrainHandlerDeps } from './handlers/train.js'
import type { StudyHandlerDeps } from './handlers/study.js'
import { createRoomChannelAdapter } from './roomChannelAdapter.js'
import { createLiveSessionLifecycleAdapter } from './liveSessionLifecycleAdapter.js'
import { assembleDeathSeams } from './assembleDeathSeams.js'
import type { AttackHandlerDeps } from './handlers/attack.js'
import type { LiveWorldBinding } from './liveWorldBinding.js'
import type { ChannelPort, ChannelDeliveryContext } from './channelPort.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import type { SessionRegistry } from './sessionRegistry.js'
import type { ConnectionContext } from './connection.js'

/**
 * 라이브 월드 조립 팩토리(Story 7) — index.ts가 넘기는 라이브 월드 의존 묶음을 진입 seam(liveWorldBinding)·
 * 이동 seam(moveDeps)·연마 seam(trainDeps)·학습 seam(studyDeps)·세션 수명 어댑터(lifecyclePort)·
 * 방 해소자(resolveRoom)로 파생한다.
 *
 * index.ts boot는 커버리지 제외 배선 코드라, 이 파생 로직을 테스트 가능한 순수 팩토리로 추출하고 index.ts는
 * 묶음 조립·전달만 남긴다(worldRuntime.ts 관례 미러). 팩토리는 transport(소켓·safeSend)를 만지지 않아
 * fake 없이 단위 테스트된다 — transport 결합은 `assembleRoomChannelPort`의 sendTo 클로저 하나에 격리한다.
 *
 * 단일 공유 불변식(#3): entry(진입 코어)·liveRegistry는 hydrate/place(liveWorldBinding)·이동(moveDeps)·
 * 종료 정리(lifecyclePort.release)·발화자 방 해소(resolveRoom)가 **동일 인스턴스**를 배후에 둬야 상태가
 * 분기하지 않는다. 팩토리가 entry를 1회 생성해 네 소비자에 같은 참조를 전달한다. 같은 이유로 점유자 이름
 * 해소자(resolveCharacterName)도 1회 생성해 진입·이동 두 world:room 생산자가 같은 참조를 공유한다.
 * 방 스코프 플레이어 해소자(resolveRoomPlayer)는 그 이름 해소자를 **재사용해** 1회 생성한다 — 지목 경로가
 * 표시 경로와 다른 클로저를 배후에 두면 "보이는 이름"과 "지목되는 이름"이 갈린다.
 *
 * 이 불변식은 **이 팩토리를 거친 묶음 파생 경로에 한정**된다. `plugin.ts`가 진입 seam을
 * `liveWorld ?? wiring?.liveWorldBinding`로 해소하므로, 호출자가 `liveWorld`와 `liveWorldDeps`를 함께
 * 주입하면 두 생산자가 서로 다른 해소자를 갖게 된다(현재 프로덕션 호출자는 후자만 넘겨 도달 불가).
 */

/** logger seam — save/logger·worldClock 관례 미러(console 금지). EntryLogger를 그대로 재사용한다. */
export type LiveWorldLogger = EntryLogger

/**
 * 라이브 월드 의존 묶음 — index.ts boot가 조립해 buildApp/registerWebsocket에 주입한다. 팩토리는 이
 * 원재료에서 진입·이동·수명 seam을 파생한다(전역 조회 금지 — 인자 주입).
 */
export interface LiveWorldWiringBundle {
  /** 정본 방 그래프(roomId → 방 노드). resolveRoom·tryMove·liveWorldBinding이 공유한다. */
  readonly worldGraph: Map<number, RoomNode>
  /** 라이브 캐릭터 레지스트리(단일 인스턴스). entry·moveDeps·lifecyclePort·resolveRoom이 공유한다. */
  readonly liveRegistry: LiveCharacterRegistry
  /**
   * 캐릭터 문서·인벤토리 로더 — hydrate가 소비한다. 두 조회가 한 진입에서 함께 일어나므로 seam도
   * 하나로 묶는다(`CharacterRepository`가 두 메서드를 모두 갖는다 — boot는 인스턴스를 그대로 싣는다).
   */
  readonly characterRepo: {
    findById(id: string): Promise<Character | null>
    hydrateInventory(id: string): Promise<ObjectInstance[]>
  }
  /**
   * object 템플릿 인덱스(objnum → 템플릿). boot가 `loadObjectTemplates()`로 **1회** 만들어 싣는다 —
   * objects.json은 부팅 시 고정 콘텐츠라 세션·명령마다 다시 읽을 이유가 없고, 모든 소비자가 같은
   * 참조를 봐야 이름·스탯 해소가 갈리지 않는다(#3 단일 공유 불변식의 확장).
   *
   * 소비자는 인스턴스↔템플릿 결합과 인벤 스코프 이름 해소(#120)다.
   */
  readonly objectTemplates: ObjectTemplateIndex
  /**
   * 크리처 스폰 템플릿 인덱스(몹번호 → 템플릿). 사망 seam의 MSUMMO 소환·MPERMT 리스폰 타이머 리셋이
   * 소비한다(`CreatureDeathDeps.templates`).
   *
   * boot는 `worldRuntime.templates`를 **그대로** 싣는다. 사망 seam이 자기 인덱스를 따로 로드하면
   * 같은 몹번호가 두 객체로 갈라져 perm 슬롯 이름 매칭(slot.misc → template.name)이 스폰 경로와
   * 다른 사본을 보게 된다 — creatures.json은 부팅 고정 콘텐츠라 사본을 둘 이유가 없다.
   */
  readonly spawnTemplates: SpawnTemplateIndex
  /**
   * 방별 monotonic instanceId 발급기(D7). 사망 seam의 MSUMMO 소환이 소비한다(`CreatureDeathDeps.alloc`).
   *
   * boot는 `worldRuntime.alloc`을 **그대로** 싣는다 — perm 리스폰·random 스폰·invasion 3경로가 이미
   * 공유하는 그 인스턴스여야 소환 크리처 instanceId가 충돌하지 않는다. 별도 발급기를 만들면 방별
   * 카운터가 `room.creatures.length`에서 다시 시작해(`createInstanceIdAllocator`의 lazy fallback)
   * 살아 있는 크리처와 같은 `${roomId}:c${idx}`를 발급하고, 그때부터 지목·원장·제거가 엉뚱한 개체를
   * 가리킨다. 예외도 로그도 남지 않는 종류의 사고다.
   */
  readonly alloc: InstanceIdAllocator
  /** 변경 엔티티 side registry 기록 — 이동 write-behind·종료 수렴이 소비한다(실 flush는 저장 스케줄러). */
  readonly markDirty: (collection: string, id: string, snapshot: unknown) => void
  /**
   * 미영속 스냅샷 조회 seam(`SaveEngine.peekPending`). 원시 `(collection, id)` 형태로 싣고, 팩토리가
   * `'characters'`로 **1회 좁혀** 진입 코어에 준다(markDirty → markCharacterDirty 관례 미러).
   *
   * save 계층은 collection 무지라 반환이 `unknown`이다 — 좁힘 지점이 아니라 **소비 지점**(hydrate)이
   * 자기 스키마로 런타임 검증한다.
   */
  readonly peekPending: (collection: string, id: string) => unknown
  /** 현재 게임시각(0~23) — 이동 시간 게이트가 소비한다(gameTime.currentHour 주입). */
  readonly currentHour: () => number
  /**
   * 현재 절대 틱 — 캐릭터 P-flag 합성(`composeCharacterFlags`)의 시점 기준이다.
   * boot가 `() => worldClock.currentTick()`을 싣는다. 훅 `now`(onRoomEntered의 activate/respawn)와
   * **같은 tick 도메인**이어야 만료 판정이 갈리지 않으므로 별도 시계를 만들지 않는다.
   */
  readonly now: () => number
  /** 방 진입 훅(활성화 + perm 리스폰) — entry.place·tryMove join 경로가 공유한다. */
  readonly onRoomEntered: (room: RoomNode, actor: MoveActor) => void
  /** 방 퇴장 훅(빈 방 비활성화) — entry.release·tryMove leave 경로가 공유한다. */
  readonly onRoomLeft: (room: RoomNode, actor: MoveActor) => void
  /** 진입 로거(orphan currentRoom 폴백 경고 등). */
  readonly logger: LiveWorldLogger
}

/** 팩토리 산출물 — registerWebsocket이 소비할 파생 seam 묶음. */
export interface LiveWorldWiring {
  /** 세션 진입 seam(hydrate/place/roomSummary 파생용 진입 코어 + roomId 해소자). */
  readonly liveWorldBinding: LiveWorldBinding
  /** world:move 배선용 이동 의존(라이브 레지스트리·tryMove seam·markCharacterDirty). */
  readonly moveDeps: MoveHandlerDeps
  /**
   * progress:train 배선용 연마 의존(라이브 레지스트리·by-character 방 해소자·markCharacterDirty).
   * 신규 원재료 없이 기존 seam 셋의 조합이다 — 묶음(LiveWorldWiringBundle)은 변하지 않는다.
   */
  readonly trainDeps: TrainHandlerDeps
  /**
   * progress:study 배선용 학습 의존(라이브 레지스트리·템플릿 인덱스·now·두 영속 마킹 seam).
   * 신규 원재료는 `now` 하나뿐이고, 나머지는 기존 seam(레지스트리·objectTemplates·markDirty 파생)의 조합이다.
   */
  readonly studyDeps: StudyHandlerDeps
  /**
   * combat:attack 배선용 공격 의존. 이 팩토리가 사망 seam·원장·전투 레지스트리를 **1회씩** 조립해
   * 싣고, 나머지 seam(방·대상 해소자·이름 해소자·markCharacterDirty)은 위에서 만든 인스턴스를
   * 그대로 재사용한다(#3).
   */
  readonly attackDeps: AttackHandlerDeps
  /**
   * 라이브 전투상태 레지스트리(단일 인스턴스). 진입(place 시 등록)·공격 핸들러(조회·교체 등록)·
   * 세션 종료(되쓰기 후 제거)가 같은 참조를 본다. 세 소비자가 갈리면 hp가 갈래마다 다르게 보인다.
   */
  readonly combatRegistry: CombatRegistry
  /** 세션 종료 수명 어댑터(전투상태 되쓰기 → markCharacterDirty → release → 전투상태 제거). liveWorldBinding.entry.release와 같은 인스턴스를 배후에 둔다. */
  readonly lifecyclePort: SessionLifecyclePort
  /**
   * characters 전체 문서 스냅샷 seam(bundle.markDirty를 1회 감싼 단일 인스턴스). moveDeps·lifecyclePort가
   * 같은 인스턴스를 공유하며, 후속 라이브 호출처(train 등)도 이것을 소비한다.
   */
  readonly markCharacterDirty: MarkCharacterDirty
  /** 발화자(characterId) 현재 방 해소자 — 방 채널 어댑터가 fan-out 대상 방을 얻는 데 쓴다. */
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
  /**
   * 방 스코프 크리처 해소자(이름·별칭 접두 + 서수 + `find_crt` 가시성 게이트). 의존이 없는 순수 함수라
   * 모듈 함수를 그대로 싣는다 — 관찰자 flags는 호출 인자이지 배선 원재료가 아니다(#121이 합성해 넘긴다).
   */
  readonly resolveRoomCreature: RoomCreatureResolver
  /**
   * 방 스코프 플레이어 해소자(점유자 표시 이름 접두 + 서수 → characterId). 아래 이름 해소자
   * (`resolveCharacterName`)를 **재사용해 1회 생성**한다(#3) — 새로 만들면 지목 경로가 두 world:room
   * 생산자와 다른 해소자를 배후에 두게 되어 이름 규칙이 갈릴 수 있다.
   */
  readonly resolveRoomPlayer: RoomPlayerResolver
}

/**
 * 라이브 월드 의존 묶음을 파생 seam으로 조립한다(순수 — transport 미접촉).
 *
 * entry를 1회 생성해 liveWorldBinding·lifecyclePort가 공유하고(#3), roomId 해소자(worldGraph.get)를
 * liveWorldBinding·tryMove가 공유한다. 이동 방송(broadcastLeave/broadcastJoin)은 Story 8 몫이라 여기서는
 * no-op으로 채운다 — 방 채팅과 달리 이동 통지는 이 토픽 완료 기준 밖이다.
 */
export function createLiveWorldWiring(bundle: LiveWorldWiringBundle): LiveWorldWiring {
  const resolveRoomById = (roomId: number): RoomNode | undefined => bundle.worldGraph.get(roomId)

  // characters 스냅샷 seam — 1회 생성해 moveDeps·lifecyclePort가 같은 인스턴스를 공유한다(계약 단일화).
  const markCharacterDirty = createMarkCharacterDirty(bundle.markDirty)

  // objectDeletions 삭제 마킹 seam — 같은 이유로 **1회** 생성한다(#3). 삭제 호출처가 늘어도
  // (버림·소모품 등) 같은 인스턴스를 나눠 쓴다.
  //
  // 형제 `markCharacterDirty`와 달리 이 seam은 `LiveWorldWiring` 산출물에 노출하지 않는다. 노출의 효용은
  // "여러 파생 seam이 같은 인스턴스를 쓴다"를 테스트가 단언할 수 있게 하는 것인데(둘 다 프로덕션에서
  // `wiring.*`로 직접 읽는 호출자는 없다 — 소비는 전부 파생된 deps를 통한다), 내부 소비자가
  // studyDeps 하나뿐이면 단언할 대상이 없어 표면만 넓어진다. 두 번째 소비자가 생기면 그때 노출한다.
  const markObjectDeleted = createMarkObjectDeleted(bundle.markDirty)

  // characters pending 조회 seam — 원시 `peekPending`을 'characters'로 **1회** 좁힌다(#3, markCharacterDirty 미러).
  // 좁힘이 여러 곳에 흩어지면 컬렉션 리터럴 오타가 조용한 "pending 없음"이 되어 #124가 되살아난다.
  const peekPendingCharacter = (id: string): unknown =>
    bundle.peekPending(CHARACTERS_COLLECTION, id)

  // 라이브 전투상태 레지스트리 — **1회** 생성해 진입(place)·공격 핸들러·세션 종료가 공유한다(#3).
  const combatRegistry = createCombatRegistry()

  // 진입 코어 — 단일 인스턴스로 생성해 liveWorldBinding·lifecyclePort가 공유한다(#3).
  const entryCore = createLiveCharacterEntry({
    characterRepo: bundle.characterRepo,
    liveRegistry: bundle.liveRegistry,
    resolveRoom: resolveRoomById,
    onRoomEntered: bundle.onRoomEntered,
    onRoomLeft: bundle.onRoomLeft,
    peekPendingCharacter,
    logger: bundle.logger,
  })

  /**
   * 진입 코어에 전투상태 등록을 덧씌운 entry — 배치 직후 전투상태를 조립해 레지스트리에 넣는다.
   *
   * **왜 `liveCharacterEntry`를 직접 고치지 않는가**: `world/`는 `combat/`을 import하지 않는다
   * (스펙 §3.2 — `liveCharacterRegistry`·`assemblePlayerCombatState`의 JSDoc이 같은 규약을 명시한다).
   * 진입 코어에 조립기를 넣으면 그 규약이 깨지고 world 계층이 전투 계층을 역참조하게 된다. 그래서
   * 배선 계층인 이 팩토리가 감싼다 — 방향은 ws→world·ws→combat로 유지되고, 두 도메인은 서로를 모른다.
   *
   * flags는 `composeCharacterFlags(character, now)`로 여기서 합성한다(조립기는 hex를 인자로만 받는
   * 순수 함수다 — `playerState.ts`의 주입 규약).
   *
   * ★ **등록된 상태가 있으면 hp·mp·nextAttackAt을 carry로 이어받는다**(공격 핸들러의 D4와 같은 규칙).
   * `entryCore.place`는 **멱등**이라 이미 점유자면 조기 반환하는데(`liveCharacterEntry.ts:218`),
   * 래퍼가 그 멱등성을 따라가지 않고 무조건 새 상태를 덮으면 **재접속이 진행 중 전투를 초기화한다** —
   * `nextAttackAt`이 0으로 돌아가 공격 쿨다운이 지워지고(재접속으로 연타 가능), 몬스터 반격이
   * 연결되는 시점(#99)에는 hp가 문서 값으로 복귀해 "재접속하면 회복"이 된다. grace 창 재접속은
   * 실재 경로다(#124 회귀 스위트가 그 창을 위해 존재한다).
   *
   * 최초 입장(등록 상태 없음)은 carry 없이 조립한다 — 캐릭터 문서의 hp·mp가 초기값이 되고
   * `nextAttackAt`은 0이라 첫 공격에 쿨다운 게이트가 없다.
   */
  const entry: LiveCharacterEntry = {
    ...entryCore,
    place: (live: LiveCharacter) => {
      entryCore.place(live)
      const registered = combatRegistry.get(live.character._id)
      const carry =
        registered === undefined
          ? undefined
          : {
              hpCurrent: registered.hpCurrent,
              mpCurrent: registered.mpCurrent,
              nextAttackAt: registered.nextAttackAt,
            }
      const flags = composeCharacterFlags(live.character, bundle.now())
      combatRegistry.register(assemblePlayerCombatState(live, bundle.objectTemplates, flags, carry))
    },
    // 등록·제거를 같은 래퍼가 대칭으로 소유한다 — 제거를 lifecyclePort에만 두면 `entry.release`를
    // 포트 밖에서 부르는 호출자가 생겼을 때 전투상태가 남는다. `remove`는 미등록에 no-op이라
    // 어댑터의 제거와 중복돼도 무해하다.
    release: (characterId: string) => {
      entryCore.release(characterId)
      combatRegistry.remove(characterId)
    },
  }

  // 점유자 이름 해소자 — **1회 생성**해 진입 seam(liveWorldBinding)과 이동 seam(moveDeps)이 같은 참조를
  // 공유한다(#3). 두 번 만들면 두 발화 경로가 서로 다른 클로저를 쓰게 되어 나중에 해소 규칙이 갈릴 수 있다.
  const resolveCharacterName = (characterId: string): string | undefined =>
    bundle.liveRegistry.get(characterId)?.character.name

  // 방 스코프 플레이어 해소자 — 위 이름 해소자를 감싸 **1회 생성**한다(#3의 확장). 지목 경로가 표시
  // 경로(world:room 두 생산자)와 같은 클로저를 배후에 둬야 "보이는 이름"과 "지목되는 이름"이 갈리지 않는다.
  const resolveRoomPlayer = createRoomPlayerResolver(resolveCharacterName)

  const liveWorldBinding: LiveWorldBinding = {
    entry,
    resolveRoom: resolveRoomById,
    resolveCharacterName,
  }

  // 이동 방송 seam은 Story 8이 채널 어댑터로 결선한다(이동 통지). 이 토픽은 no-op으로 두어 tryMove 계약만
  // 충족한다 — 방 채팅 전파(#6)는 채널 포트가, 이동 leave/join 통지는 후속 토픽이 소유한다.
  const noopBroadcast = (_room: RoomNode, _actor: MoveActor): void => {}
  const tryMoveDeps: TryMoveDeps = {
    resolveRoom: resolveRoomById,
    currentHour: bundle.currentHour,
    broadcastLeave: noopBroadcast,
    broadcastJoin: noopBroadcast,
    onRoomEntered: bundle.onRoomEntered,
    onRoomLeft: bundle.onRoomLeft,
    rng: defaultFleeRng,
  }
  const moveDeps: MoveHandlerDeps = {
    liveRegistry: bundle.liveRegistry,
    tryMoveDeps,
    markCharacterDirty,
    resolveCharacterName,
  }

  // 세션 종료 수명 어댑터 — release는 진입 코어의 것을 그대로 주입해 같은 레지스트리/방을 정리한다(#3).
  // combatRegistry도 같은 인스턴스를 주어 종료 시 전투로 깎인 hp·mp가 캐릭터 문서로 되쓰인다.
  const lifecyclePort = createLiveSessionLifecycleAdapter({
    liveRegistry: bundle.liveRegistry,
    release: (characterId) => entry.release(characterId),
    markCharacterDirty,
    combatRegistry,
  })

  // 발화자 방 해소자(by-character): registry로 라이브 엔트리를 찾고 currentRoom(단일 출처)으로 방을 얻는다.
  const resolveRoom = (characterId: string): RoomNode | undefined => {
    const live = bundle.liveRegistry.get(characterId)
    if (live === undefined) return undefined
    return bundle.worldGraph.get(live.character.currentRoom)
  }

  // 연마 의존 — 신규 원재료 없이 기존 세 seam의 조합이다(레지스트리·by-character 방 해소자·스냅샷 헬퍼).
  // moveDeps와 달리 by-roomId 해소자가 아니라 위의 by-character resolveRoom을 쓰므로 그 선언 뒤에 둔다.
  const trainDeps: TrainHandlerDeps = {
    liveRegistry: bundle.liveRegistry,
    resolveRoom,
    markCharacterDirty,
  }

  // 학습 의존 — 방을 읽지 않는다(대상이 소지품 스코프라 방 해소자가 필요 없다). 신규 원재료는 `now`뿐이고,
  // 두 마킹은 위에서 1회씩 만든 인스턴스를 그대로 싣는다(#3).
  const studyDeps: StudyHandlerDeps = {
    liveRegistry: bundle.liveRegistry,
    objectTemplates: bundle.objectTemplates,
    now: bundle.now,
    markCharacterDirty,
    markObjectDeleted,
  }

  // 크리처별 데미지 원장 라우터 — **1회** 생성해 공격 누적(attackDeps.ledgers)과 사망 분배
  // (fireCreatureDeath 내부)가 같은 참조를 쓴다. 두 인스턴스로 갈리면 사망 시점에 읽는 원장이 비어
  // 기여자 게이트(`ledger.get(id) > 0`)가 전부 탈락하고 보상이 조용히 0이 된다(assembleDeathSeams 헤더).
  const ledgers = createCreatureLedgers()

  // 사망 seam — **1회** 조립한다. 소환·리스폰이 쓰는 alloc·templates는 묶음이 실어 준 worldRuntime
  // 인스턴스를 그대로 넘긴다(bundle.alloc JSDoc — instanceId 충돌 방지).
  const deathSeams = assembleDeathSeams({
    liveRegistry: bundle.liveRegistry,
    ledgers,
    markCharacterDirty,
    creatureDeathDeps: { templates: bundle.spawnTemplates, alloc: bundle.alloc },
    logger: bundle.logger,
  })

  // 공격 의존 — 신규 원재료는 없다. 사망 seam·원장·전투 레지스트리는 위에서 1회씩 만든 것이고,
  // 나머지는 전부 기존 인스턴스의 재사용이다(#3). 특히 `resolveCharacterName`은 world:room 두
  // 생산자와 같은 참조여야 "보이는 이름"과 사망 후 방 재투영의 이름이 갈리지 않는다.
  const attackDeps: AttackHandlerDeps = {
    ...deathSeams,
    liveRegistry: bundle.liveRegistry,
    combatRegistry,
    objectTemplates: bundle.objectTemplates,
    resolveRoom,
    resolveRoomCreature,
    resolveRoomPlayer,
    resolveCharacterName,
    now: bundle.now,
    // 굴림 seam — 전투 모듈은 순수 함수로 남고 프로덕션 배선이 실 rng를 꽂는다(attack.ts 헤더).
    rng: defaultCombatRng,
    ledgers,
    markCharacterDirty,
  }

  return {
    liveWorldBinding,
    moveDeps,
    trainDeps,
    studyDeps,
    attackDeps,
    combatRegistry,
    lifecyclePort,
    resolveRoom,
    markCharacterDirty,
    // 크리처 해소자는 의존이 없어 모듈 함수를 그대로 노출한다(재생성 없음 — 참조가 곧 단일 인스턴스).
    resolveRoomCreature,
    resolveRoomPlayer,
  }
}

/** assembleRoomChannelPort 의존 seam — 발화자 방 해소자 + 세션 색인 + 소켓 해소자 + 안전 전송. */
export interface RoomChannelPortDeps<Socket> {
  /** 발화자(characterId) 현재 방 해소자(wiring.resolveRoom). fan-out 대상 방을 얻는다. */
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
  /** characterId → 세션 바인딩 색인(소켓 역참조용 connection 보유). */
  readonly registry: Pick<SessionRegistry, 'get'>
  /** 바인딩 connection → 소켓 역참조자. 소켓이 이미 정리됐으면 undefined. */
  readonly resolveSocket: (connection: ConnectionContext) => Socket | undefined
  /** 소켓으로 서버 이벤트를 안전 전송(OPEN 가드·backpressure). */
  readonly safeSend: (socket: Socket, event: ServerEvent) => void
}

/**
 * 방 채널 포트를 조립한다 — 유일한 transport 결합 지점(sendTo).
 *
 * 방 fan-out 대상 결정은 `createRoomChannelAdapter`(방 occupants 전 멤버, 발화자 자신 제외 안 함)에 위임하고,
 * 이 함수는 멤버 한 명을 실제 소켓으로 보내는 sendTo만 조립한다. sendTo는 세션 색인으로 바인딩을 찾고 소켓을
 * 역참조해 `chat:said`(ChannelDeliveryContext 평탄화)를 safeSend로 내보낸다. 미등록 멤버(색인 없음)·정리된
 * 소켓(역참조 undefined)은 조용히 스킵한다. Socket 타입을 제네릭으로 열어 소켓 구현(ws.WebSocket)에 결합하지
 * 않아 fake 소켓으로 단위 테스트된다.
 */
export function assembleRoomChannelPort<Socket>(deps: RoomChannelPortDeps<Socket>): ChannelPort {
  const sendTo = (characterId: string, ctx: ChannelDeliveryContext): void => {
    const binding = deps.registry.get(characterId)
    if (binding === undefined) return
    const socket = deps.resolveSocket(binding.connection)
    if (socket === undefined) return
    const event: ServerEvent = {
      type: 'chat:said',
      channel: ctx.channel,
      speakerCharacterId: ctx.speaker.characterId,
      text: ctx.text,
      ...(ctx.target !== undefined ? { target: ctx.target } : {}),
    }
    deps.safeSend(socket, event)
  }
  return createRoomChannelAdapter({ resolveRoom: deps.resolveRoom, sendTo })
}
