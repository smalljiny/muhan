import type { RoomNode } from 'shared'
import type { ChannelPort, ChannelDeliveryContext } from './channelPort.js'

/**
 * ChannelPort의 실 방 채널 어댑터.
 *
 * mock이 아니라 실 구현이다 — 발화자의 현재 방을 조회해 그 방 occupants(점유자 characterId 집합)
 * 전 멤버에게 동기 fan-out한다. no-op 어댑터(noopChannelAdapter.ts)와 달리 실제로 방 멤버 집합에
 * 발화를 뿌린다. 생성자 주입 관례(전역 싱글턴·서비스 로케이터 조회 금지)로 방 조회원·전달원을 받아
 * 소유한다. noopChannelAdapter.ts의 seam 관례를 미러한다.
 *
 * 가시성 필터(어둠·투명 등)는 여기서 적용하지 않는다 — occupants 전 멤버에게 전달하고, 어느 멤버가
 * 실제로 발화를 인지하는지(어둠/투명 판정)와 발화자 자신 제외는 송신 시점 seam(sendTo 구현부)의
 * 소관이다. 이 어댑터는 방 멤버십에 따른 fan-out 대상 집합만 결정한다.
 *
 * plugin.ts의 no-op 기본 어댑터 교체는 이 토픽 범위에서 수행하지 않는다 — 런타임 방 배치(enterWorld·
 * 초기 occupancy)가 E3/후속 소관이라 관찰 가능한 fan-out을 아직 exercise할 수 없다. 어댑터는 주입
 * 가능한 실 구현으로 제공만 하고, 기본 어댑터 교체는 방 배치 seam이 붙는 시점으로 유예한다.
 *
 * 동기 시그니처: deliver는 Promise를 반환하지 않는다(channelPort.ts 계약 유지). fan-out은 주입된
 * sendTo에 위임하며, 네트워크 async가 필요해지면 sendTo 구현부가 내부에서 처리한다.
 */

/**
 * 방 채널 어댑터가 의존하는 주입 seam. 생성자 주입으로 받아 소유한다(전역 싱글턴 금지).
 *
 * `resolveRoom`은 발화자의 현재 방을 조회한다 — 방 미해석 시 undefined를 반환한다.
 * `sendTo`는 방 멤버 한 명에게 발화를 전달한다 — 실 전달 채널(WebSocket 등)은 이 구현부가 소유한다.
 */
export interface RoomChannelAdapterDeps {
  /** 발화자(characterId)의 현재 방을 조회한다. 방을 못 찾으면 undefined. */
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
  /** 방 멤버(characterId)에게 채널 전달 컨텍스트를 전달한다. 실 송신 채널을 소유. */
  readonly sendTo: (characterId: string, ctx: ChannelDeliveryContext) => void
}

/**
 * 실 방 채널 어댑터를 만든다. deliver는 발화자 방을 조회해 occupants 전 멤버에게 동기 fan-out한다.
 */
export function createRoomChannelAdapter(deps: RoomChannelAdapterDeps): ChannelPort {
  const { resolveRoom, sendTo } = deps
  return {
    deliver(ctx) {
      const room = resolveRoom(ctx.speaker.characterId)
      // 방어 처리: 방이 미해석(undefined)이면 조용히 no-op한다. 배선 정상 경로에선 발화자가 항상
      // 방에 배치돼 있어 도달하지 않지만, 배치 seam 미완 시점의 방어선으로 둔다.
      if (room === undefined) {
        return
      }
      // occupants는 읽기만 한다(immutability — 어댑터는 방 상태를 변경하지 않는다). 발화자 자신을
      // 제외하지 않는다 — 전 멤버 전달이며, 제외 여부는 송신 시점 seam(sendTo)의 소관이다.
      for (const memberId of room.occupants) {
        sendTo(memberId, ctx)
      }
    },
  }
}
