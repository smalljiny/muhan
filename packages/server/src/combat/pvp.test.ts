import { describe, it, expect, expectTypeOf } from 'vitest'
import type { CreatureInstance, RoomNode } from 'shared'
import { checkTargetImmunity, checkPvpGate } from './pvp.js'
import type { TargetImmunityInput, PvpGateInput } from './pvp.js'
import type { PlayerCombatState } from './playerState.js'
import { F_SET, MUNKIL, MMGONL, MENONL, PCHAOS, PFAMIL } from '../world/hexFlags.js'
import { setFlag } from '../world/door.js'
import { RNOKIL, RSUVIV } from '../world/moveGates.js'
import { PVP_COOLDOWN_INCREMENT, CARETAKER } from './constants.js'

// 재사용 계약 고정 — 게이트 입력은 최소 구조 shape이나, 실 타입(PlayerCombatState/CreatureInstance/
// RoomNode)이 구조적으로 할당 가능해야 호출자가 그대로 넘길 수 있다. 이 할당성이 깨지면 Story 8~10
// 배선 시점이 아니라 여기서 컴파일 실패로 드러난다.
describe('게이트 입력 재사용 계약(타입 레벨)', () => {
  it('실 전투 타입이 게이트 입력 shape에 구조적으로 할당된다', () => {
    expectTypeOf<PlayerCombatState>().toMatchTypeOf<TargetImmunityInput['attacker']>()
    expectTypeOf<CreatureInstance>().toMatchTypeOf<TargetImmunityInput['defender']>()
    expectTypeOf<PlayerCombatState>().toMatchTypeOf<PvpGateInput['attacker']>()
    expectTypeOf<PlayerCombatState>().toMatchTypeOf<PvpGateInput['defender']>()
    expectTypeOf<CreatureInstance>().toMatchTypeOf<PvpGateInput['defender']>()
    expectTypeOf<RoomNode>().toMatchTypeOf<PvpGateInput['room']>()
  })
})

/**
 * pvp 게이트 스펙 — command5.c:146-201 오라클 충실 이식 검증.
 *
 * 관용 분리 고정: creature/player flags는 hex string(F_SET/F_ISSET), room flags는 number[]
 * (setFlag/hasFlag)로 픽스처를 구성한다. 두 계열을 뒤섞으면 게이트가 항상 통과하는 사고를 방지하므로,
 * RNOKIL·RSUVIV 방은 반드시 number[] + setFlag로 세팅해 거부/면제를 유발한다.
 */

const FIGHTER = 4 // class < CARETAKER — MENONL 대상

describe('checkTargetImmunity (player→creature 대상 무적 게이트)', () => {
  it('MUNKIL 크리처는 마법무기여도 무조건 거부한다', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: { adjustment: 3 } },
      defender: { flags: F_SET('', MUNKIL) },
    })
    expect(r.ok).toBe(false)
  })

  it('MMGONL 크리처는 마법무기여도 거부한다(마법만)', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: { adjustment: 3 } },
      defender: { flags: F_SET('', MMGONL) },
    })
    expect(r.ok).toBe(false)
  })

  it('MENONL + class<CARETAKER + 무기 없음(맨손)이면 거부한다', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: null },
      defender: { flags: F_SET('', MENONL) },
    })
    expect(r.ok).toBe(false)
  })

  it('MENONL + class<CARETAKER + 무기 adjustment<1이면 거부한다', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: { adjustment: 0 } },
      defender: { flags: F_SET('', MENONL) },
    })
    expect(r.ok).toBe(false)
  })

  it('MENONL + 마법무기(adjustment>=1)면 허용한다', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: { adjustment: 1 } },
      defender: { flags: F_SET('', MENONL) },
    })
    expect(r.ok).toBe(true)
  })

  it('MENONL + class>=CARETAKER면 무기 없어도 허용한다(운영진 면제)', () => {
    const r = checkTargetImmunity({
      attacker: { class: CARETAKER, weapon: null },
      defender: { flags: F_SET('', MENONL) },
    })
    expect(r.ok).toBe(true)
  })

  it('플래그 없는 크리처는 허용하고 쿨다운 증분은 0이다', () => {
    const r = checkTargetImmunity({
      attacker: { class: FIGHTER, weapon: null },
      defender: { flags: '' },
    })
    expect(r).toEqual({ ok: true, cooldownIncrement: 0 })
  })

  it('순수 함수: 입력 객체를 변형하지 않는다', () => {
    const defender = { flags: '' }
    const attacker = { class: FIGHTER, weapon: null }
    checkTargetImmunity({ attacker, defender })
    expect(defender).toEqual({ flags: '' })
    expect(attacker).toEqual({ class: FIGHTER, weapon: null })
  })
})

// 방 flags를 number[] + setFlag(door.ts)로 구성한다 — hex/F_ISSET 관용과 분리.
function roomWith(...bits: number[]): { flags: number[] } {
  const flags: number[] = []
  for (const bit of bits) setFlag(flags, bit)
  return { flags }
}
const plainRoom = (): { flags: number[] } => ({ flags: [] })

describe('checkPvpGate (player→player 3중 게이트)', () => {
  it('RNOKIL 방(number[]+setFlag)에서는 무조건 거부한다', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PCHAOS), level: 1 },
      defender: { flags: F_SET('', PCHAOS) },
      room: roomWith(RNOKIL),
      checkWarResult: false,
    })
    expect(r.ok).toBe(false)
  })

  it('공격자가 선(비 PCHAOS)하고 level<128이고 비 RSUVIV면 거부한다', () => {
    const r = checkPvpGate({
      attacker: { flags: '', level: 1 },
      defender: { flags: F_SET('', PCHAOS) },
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r.ok).toBe(false)
  })

  it('대상이 선(비 PCHAOS)하고 공격자 level<128이고 비 RSUVIV면 거부한다', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PCHAOS), level: 1 },
      defender: { flags: '' },
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r.ok).toBe(false)
  })

  it('공격자 level>=128이면 선악 게이트를 통과한다', () => {
    const r = checkPvpGate({
      attacker: { flags: '', level: 128 },
      defender: { flags: '' },
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r.ok).toBe(true)
  })

  it('RSUVIV 방(number[]+setFlag)에서는 선악 게이트를 통과한다', () => {
    const r = checkPvpGate({
      attacker: { flags: '', level: 1 },
      defender: { flags: '' },
      room: roomWith(RSUVIV),
      checkWarResult: false,
    })
    expect(r.ok).toBe(true)
  })

  it('양측 PCHAOS면 선악 게이트를 통과한다', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PCHAOS), level: 1 },
      defender: { flags: F_SET('', PCHAOS) },
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r.ok).toBe(true)
  })

  it('비-패거리: 선악 게이트 적용 — 선한 공격자면 거부(checkWarResult 무관)', () => {
    const r = checkPvpGate({
      attacker: { flags: '', level: 1 },
      defender: { flags: '' },
      room: plainRoom(),
      checkWarResult: true, // 비-패거리라 무시됨
    })
    expect(r.ok).toBe(false)
  })

  it('양측 패거리 + 평화(checkWarResult=false): 선악 게이트 스킵 → 선한 양측이어도 허용', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PFAMIL), level: 1 }, // 선(비 PCHAOS) + PFAMIL
      defender: { flags: F_SET('', PFAMIL) }, // 선 + PFAMIL
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r.ok).toBe(true)
  })

  it('양측 패거리 + 전쟁(checkWarResult=true): 선악 게이트 재적용 → 선한 공격자 거부', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PFAMIL), level: 1 },
      defender: { flags: F_SET('', PFAMIL) },
      room: plainRoom(),
      checkWarResult: true,
    })
    expect(r.ok).toBe(false)
  })

  it('성립 시 쿨다운 +3 증분을 constants.ts 상수로 반환한다', () => {
    const r = checkPvpGate({
      attacker: { flags: F_SET('', PCHAOS), level: 1 },
      defender: { flags: F_SET('', PCHAOS) },
      room: plainRoom(),
      checkWarResult: false,
    })
    expect(r).toEqual({ ok: true, cooldownIncrement: PVP_COOLDOWN_INCREMENT })
    expect(PVP_COOLDOWN_INCREMENT).toBe(3)
  })

  it('순수 함수: 입력 room.flags를 변형하지 않는다', () => {
    const room = roomWith(RSUVIV)
    const before = [...room.flags]
    checkPvpGate({
      attacker: { flags: F_SET('', PCHAOS), level: 1 },
      defender: { flags: F_SET('', PCHAOS) },
      room,
      checkWarResult: false,
    })
    expect(room.flags).toEqual(before)
  })
})
