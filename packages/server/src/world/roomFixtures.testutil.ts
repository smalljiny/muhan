import type { CreatureInstance, ExitEdge, ItemInstance, RoomNode } from 'shared'
import { setFlag } from './door.js'
import { F_SET } from './hexFlags.js'

/**
 * 방·출구·아이템·크리처 픽스처 팩토리 — test-only.
 *
 * `projectRoomView`(roomView.test.ts)·`buildRoomSummary`(liveWorldBinding.test.ts)·
 * `createMoveHandler`(handlers/move.test.ts)·`liveWorldWiring.test.ts`가 각자 복사해 두던 동일
 * 픽스처 헬퍼를 여기 하나로 모은다. 두 flags 표현이 섞인다 — 출구는 바이트당 한 원소인
 * number[](door.ts hasFlag, `RoomNode`/`ExitEdge` 정본 폭 8바이트), 아이템·크리처는 16자 hex
 * string(hexFlags.ts F_ISSET). 픽스처는 손으로 비트를 계산하지 않고 setFlag·F_SET 헬퍼로 만든다 —
 * 바이트 오프셋 실수를 원천 차단한다.
 *
 * 파일명이 `.testutil.ts`라 server build(tsconfig.build.json)·coverage(vitest.config.ts) 양쪽
 * glob에서 자동 제외된다(테스트 인프라, 프로덕션 코드 아님).
 */

/** 지정 비트들을 세팅한 출구 flags(number[], 8바이트 — RoomNode 출구 flags 정본 폭)를 만든다. */
export function exitFlags(...bits: number[]): number[] {
  const flags = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const bit of bits) setFlag(flags, bit)
  return flags
}

/** 지정 비트들을 세팅한 아이템/크리처 flags(16자 hex string)를 만든다. */
export function flagsHex(...bits: number[]): string {
  return bits.reduce((hex, bit) => F_SET(hex, bit), '0'.repeat(16))
}

/** 플래그 없음(16자 zero hex). 리터럴을 손으로 적으면 0 개수를 잘못 세도 테스트가 통과한다. */
export const NO_FLAGS = flagsHex()

/** 목적지 방으로 가는 출구를 만든다. flags 생략 시 플래그 없음(exitFlags()), targetRoomId 생략 시 2. */
export function makeExit(name: string, flags: number[] = exitFlags(), targetRoomId = 2): ExitEdge {
  return { name, targetRoomId, flags, key: 0, ltime: 0, interval: 60 }
}

/**
 * targetRoomId를 우선 인자로 받는 변형 — 이동 계열 테스트처럼 목적지 방이 매번 달라지고 flags는
 * 드물게만 바뀔 때 쓴다(`makeExitTo('동', 200, exitFlags(XLOCKD))`).
 */
export function makeExitTo(name: string, targetRoomId: number, flags: number[] = exitFlags()): ExitEdge {
  return makeExit(name, flags, targetRoomId)
}

/** 바닥 아이템 픽스처. contains는 컨테이너 중첩 검증(비재귀 확인)에만 쓴다. */
export function makeItem(
  instanceId: string,
  name: string,
  flags = NO_FLAGS,
  contains: ItemInstance[] = [],
): ItemInstance {
  return { instanceId, name, description: '', value: 0, flags, contains }
}

/** 크리처 픽스처. 기본 level=3 — 다른 값이 필요하면 overrides로 명시한다. */
export function makeCreature(
  instanceId: string,
  name: string,
  overrides: Partial<CreatureInstance> = {},
): CreatureInstance {
  return {
    instanceId,
    templateId: null,
    name,
    level: 3,
    hpmax: 10,
    hpcur: 10,
    mpmax: 0,
    mpcur: 0,
    dexterity: 10,
    gold: 0,
    special: 0,
    armor: 0,
    thaco: 0,
    ndice: 0,
    sdice: 0,
    pdice: 0,
    realm: [0, 0, 0, 0],
    spells: '0'.repeat(32),
    class: 0,
    intelligence: 0,
    piety: 0,
    flags: NO_FLAGS,
    enemies: [],
    inventory: [],
    ...overrides,
  }
}

/** 방 픽스처. overrides로 필요한 필드만 덮어쓴다(위치 인자 난립 방지). */
export function makeRoom(overrides: Partial<RoomNode> = {}): RoomNode {
  return {
    roomId: 1,
    name: '작은 방',
    shortDesc: '작은 방이다',
    longDesc: '먼지 쌓인 작은 방이다.',
    exits: [],
    items: [],
    flags: [0, 0, 0, 0, 0, 0, 0, 0],
    occupants: new Set<string>(),
    creatures: [],
    permMon: [],
    random: [],
    traffic: 0,
    ...overrides,
  }
}
