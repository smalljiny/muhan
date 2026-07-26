import type { Character, RoomNode, ServerEvent } from 'shared'
import { createLiveCharacterEntry, type EntryLogger } from '../world/liveCharacterEntry.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import { defaultFleeRng, type MoveActor, type TryMoveDeps } from '../world/tryMove.js'
import type { MoveHandlerDeps } from './handlers/move.js'
import { createRoomChannelAdapter } from './roomChannelAdapter.js'
import { createLiveSessionLifecycleAdapter } from './liveSessionLifecycleAdapter.js'
import type { LiveWorldBinding } from './liveWorldBinding.js'
import type { ChannelPort, ChannelDeliveryContext } from './channelPort.js'
import type { SessionLifecyclePort } from './sessionLifecyclePort.js'
import type { SessionRegistry } from './sessionRegistry.js'
import type { ConnectionContext } from './connection.js'

/**
 * 라이브 월드 조립 팩토리(Story 7) — index.ts가 넘기는 라이브 월드 의존 묶음을 진입 seam(liveWorldBinding)·
 * 이동 seam(moveDeps)·세션 수명 어댑터(lifecyclePort)·방 해소자(resolveRoom)로 파생한다.
 *
 * index.ts boot는 커버리지 제외 배선 코드라, 이 파생 로직을 테스트 가능한 순수 팩토리로 추출하고 index.ts는
 * 묶음 조립·전달만 남긴다(worldRuntime.ts 관례 미러). 팩토리는 transport(소켓·safeSend)를 만지지 않아
 * fake 없이 단위 테스트된다 — transport 결합은 `assembleRoomChannelPort`의 sendTo 클로저 하나에 격리한다.
 *
 * 단일 공유 불변식(#3): entry(진입 코어)·liveRegistry는 hydrate/place(liveWorldBinding)·이동(moveDeps)·
 * 종료 정리(lifecyclePort.release)·발화자 방 해소(resolveRoom)가 **동일 인스턴스**를 배후에 둬야 상태가
 * 분기하지 않는다. 팩토리가 entry를 1회 생성해 네 소비자에 같은 참조를 전달한다.
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
  /** 캐릭터 문서 로더 — hydrate가 소비한다. */
  readonly characterRepo: { findById(id: string): Promise<Character | null> }
  /** 변경 엔티티 side registry 기록 — 이동 write-behind·종료 수렴이 소비한다(실 flush는 저장 스케줄러). */
  readonly markDirty: (collection: string, id: string, snapshot: unknown) => void
  /** 현재 게임시각(0~23) — 이동 시간 게이트가 소비한다(gameTime.currentHour 주입). */
  readonly currentHour: () => number
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
  /** world:move 배선용 이동 의존(라이브 레지스트리·tryMove seam·markDirty). */
  readonly moveDeps: MoveHandlerDeps
  /** 세션 종료 수명 어댑터(markDirty → release). liveWorldBinding.entry.release와 같은 인스턴스를 배후에 둔다. */
  readonly lifecyclePort: SessionLifecyclePort
  /** 발화자(characterId) 현재 방 해소자 — 방 채널 어댑터가 fan-out 대상 방을 얻는 데 쓴다. */
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
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

  // 진입 코어 — 단일 인스턴스로 생성해 liveWorldBinding·lifecyclePort가 공유한다(#3).
  const entry = createLiveCharacterEntry({
    characterRepo: bundle.characterRepo,
    liveRegistry: bundle.liveRegistry,
    resolveRoom: resolveRoomById,
    onRoomEntered: bundle.onRoomEntered,
    onRoomLeft: bundle.onRoomLeft,
    logger: bundle.logger,
  })

  const liveWorldBinding: LiveWorldBinding = { entry, resolveRoom: resolveRoomById }

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
    markDirty: bundle.markDirty,
  }

  // 세션 종료 수명 어댑터 — release는 진입 코어의 것을 그대로 주입해 같은 레지스트리/방을 정리한다(#3).
  const lifecyclePort = createLiveSessionLifecycleAdapter({
    liveRegistry: bundle.liveRegistry,
    release: (characterId) => entry.release(characterId),
    markDirty: bundle.markDirty,
  })

  // 발화자 방 해소자(by-character): registry로 라이브 엔트리를 찾고 currentRoom(단일 출처)으로 방을 얻는다.
  const resolveRoom = (characterId: string): RoomNode | undefined => {
    const live = bundle.liveRegistry.get(characterId)
    if (live === undefined) return undefined
    return bundle.worldGraph.get(live.character.currentRoom)
  }

  return { liveWorldBinding, moveDeps, lifecyclePort, resolveRoom }
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
