import { describe, it, expect, vi } from 'vitest'
import type { RoomNode } from 'shared'
import { createLiveCharacterRegistry } from '../world/liveCharacterRegistry.js'

// 파일 스코프 hoist라 별도 파일에 둔다 — liveWorldWiring.test.ts의 실동작 단정을 오염시키지 않는다
// (spellByName.delegation.test.ts와 같은 격리 관례).
//
// 이 파일은 `.harness/rules/testing.md`의 "비즈니스 로직 mock 금지" 원칙의 문서화된 예외다.
// 팩토리를 실제 구현으로 감싼 spy이므로 로직이 가려지지 않으며(`...actual` 스프레드 + 원본 위임),
// 단정 대상은 산출물이 아니라 **어떤 인스턴스를 넘겼는가**라는 배선 사실이다.
vi.mock('../world/roomTargetResolvers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../world/roomTargetResolvers.js')>()
  return { ...actual, createRoomPlayerResolver: vi.fn(actual.createRoomPlayerResolver) }
})

import { createRoomPlayerResolver } from '../world/roomTargetResolvers.js'
import { createLiveWorldWiring, type LiveWorldWiringBundle } from './liveWorldWiring.js'
import { createInstanceIdAllocator } from '../world/spawn.js'

/**
 * 공유 불변식 #3 — 방 스코프 플레이어 해소자가 **기존 `resolveCharacterName` 인스턴스**를 배후에 둔다.
 *
 * 행동 동등 단정(같은 레지스트리에 도달하는가)은 `bundle.liveRegistry`를 새로 클로징한 별개 함수도
 * 통과시킨다. 여기서는 팩토리에 실제로 넘어간 인자를 잡아 **객체 동일성**(`toBe` 수준)을 고정한다 —
 * 배선이 해소자를 새로 만들면 이 단정이 깨진다.
 */
describe('resolveRoomPlayer 배선 — 이름 해소자 인스턴스 공유 (불변식 #3)', () => {
  it('기존 resolveCharacterName 인스턴스를 그대로 팩토리에 넘긴다 (재생성 없음)', () => {
    const bundle: LiveWorldWiringBundle = {
      worldGraph: new Map<number, RoomNode>(),
      liveRegistry: createLiveCharacterRegistry(),
      characterRepo: {
        findById: vi.fn(() => Promise.resolve(null)),
        hydrateInventory: vi.fn(() => Promise.resolve([])),
      },
      objectTemplates: new Map(),
      // 사망 seam 원재료 — 이 하네스는 소환·리스폰 경로를 검증하지 않아 빈 인덱스와 신규 발급기를 싣는다.
      spawnTemplates: new Map(),
      alloc: createInstanceIdAllocator(),
      markDirty: vi.fn(),
      peekPending: () => undefined,
      currentHour: () => 12,
      // P-flag 합성 시점 seam(#120 study 경로). 테스트는 고정 틱을 쓴다 — 만료 판정이 시간에 흔들리지 않게.
      now: () => 0,
      onRoomEntered: vi.fn(),
      onRoomLeft: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
    }

    const wiring = createLiveWorldWiring(bundle)

    expect(createRoomPlayerResolver).toHaveBeenCalledTimes(1)
    expect(createRoomPlayerResolver).toHaveBeenCalledWith(
      wiring.liveWorldBinding.resolveCharacterName,
    )
  })
})
