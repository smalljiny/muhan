import type { ServerEvent } from 'shared'
import type { RoomState } from '../transport/wsClient.js'

/**
 * 클라이언트 `world:room` 테스트 픽스처 — 방 스냅샷과 그 와이어 이벤트 형태를 한 곳에서 만든다.
 *
 * 두 형태가 필요하다: 컴포넌트(`RoomPanel`)는 `type` 없는 `RoomState`를 props로 받고, 전송 계층
 * 테스트는 소켓으로 흘려보낼 `world:room` 이벤트를 필요로 한다. `roomEvent`가 후자를 전자에서
 * 파생시켜 두 표현이 갈라지지 않게 한다 — 기대값도 픽스처를 그대로 재사용하므로, 픽스처만 고치고
 * 기대값을 놓쳐 조용히 다른 것을 검증하는 경로가 없다.
 *
 * server `world/roomFixtures.testutil.ts` 선례를 따른다(호출부마다 복사하지 않는다).
 */

/** 확장 7필드를 모두 채운 기본 방. `overrides`로 필요한 필드만 갈아 끼운다. */
export function makeRoom(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 1,
    name: '무한의 광장',
    longDesc: '넓은 광장이 펼쳐져 있다.',
    exits: ['북', '동'],
    occupants: [{ characterId: 'c1', name: '타이' }],
    items: [{ instanceId: 'i1', name: '단검' }],
    creatures: [{ instanceId: 'm1', name: '들쥐', level: 2 }],
    ...overrides,
  }
}

/** 목록 필드가 전부 빈 방 — 덮어쓰기(누적 아님)를 증명하는 두 번째 방으로 쓴다. */
export function makeEmptyRoom(overrides: Partial<RoomState> = {}): RoomState {
  return makeRoom({
    roomId: 2,
    name: '좁은 골목',
    longDesc: '',
    exits: ['남'],
    occupants: [],
    items: [],
    creatures: [],
    ...overrides,
  })
}

/** 방 스냅샷을 와이어 `world:room` 이벤트로 감싼다(discriminator만 얹는다). */
export function roomEvent(room: RoomState): Extract<ServerEvent, { type: 'world:room' }> {
  return { type: 'world:room', ...room }
}
