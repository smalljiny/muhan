import { describe, it, expect } from 'vitest'
import type { ServerEvent } from 'shared'
import type { AttackDescriptor } from './resolveAttack.js'

/**
 * 와이어 계약 `combat:attacked.attacks` 원소와 서버 `AttackDescriptor`의 대응 강제.
 *
 * 와이어 원소는 `AttackDescriptor`에서 `specialAttack`만 뺀 6필드로 정의돼 있다(D11 — 몬스터
 * 특수공격 마커는 #99 소관). 그런데 `packages/shared`는 `packages/server`를 import할 수 없어
 * (의존 방향이 server → shared) 그 대응을 shared 쪽에서 강제할 수 없다. 강제는 여기서 한다.
 *
 * `resolveAttack.ts`에 필드가 늘면 이 테스트가 컴파일 타임에 깨진다. 깨지지 않으면 그 필드는
 * 와이어에 실리지 못하고, `serverEventSchema`가 strict라 실어 보내는 순간 프레임 전체가
 * 런타임에 거부된다 — 그 조용한 실패를 여기서 앞당겨 잡는다.
 */
type WireAttack = Extract<ServerEvent, { type: 'combat:attacked' }>['attacks'][number]

type DescriptorWire = Omit<AttackDescriptor, 'specialAttack'>

describe('combat:attacked.attacks ↔ AttackDescriptor', () => {
  it('AttackDescriptor 값이 와이어 원소로 그대로 실린다', () => {
    // 객체 리터럴이라 초과 프로퍼티 검사가 걸린다 — AttackDescriptor에 필드가 늘거나 줄면
    // 이 선언이 컴파일에 실패한다(드리프트 감지의 한쪽 방향).
    const descriptor: AttackDescriptor = {
      hit: true,
      damage: 7,
      critical: false,
      fumble: false,
      durabilityHit: false,
      weaponDropped: false,
      specialAttack: null,
    }
    const { specialAttack: _specialAttack, ...wire } = descriptor

    // 반대 방향 — 와이어 원소가 요구하는 필드를 서술자가 다 갖고 있는지, 그리고 그 반대인지.
    const toWire: WireAttack = wire
    const fromWire: DescriptorWire = toWire

    expect(fromWire).toEqual({
      hit: true,
      damage: 7,
      critical: false,
      fumble: false,
      durabilityHit: false,
      weaponDropped: false,
    })
  })
})
