import { F_ISSET, MUNKIL, MMGONL, MENONL, PCHAOS, PFAMIL } from '../world/hexFlags.js'
import { hasFlag } from '../world/door.js'
import { RNOKIL, RSUVIV } from '../world/moveGates.js'
import { PVP_COOLDOWN_INCREMENT, CARETAKER } from './constants.js'

/**
 * 전투 개시 자격 게이트 — command5.c:146-201 오라클 충실 이식.
 *   - checkTargetImmunityPre: 플레이어→크리처 MUNKIL 판정(:146). registerEnemy **전** 거부(aggro 미등록).
 *   - checkTargetImmunityPost: 플레이어→크리처 MMGONL/MENONL 판정(:160-173). registerEnemy **후** 거부
 *     (aggro 등록·물리 공격만 실패). 오라클 add_enm_crt(:153)가 MUNKIL 뒤·MMGONL/MENONL 앞이라 이 분해가
 *     인터리브를 재현한다(Story 10 T10.3).
 *   - checkPvpGate: 플레이어→플레이어 안전지대·선악·패거리 3중 게이트(:176-201).
 *
 * 두 함수 모두 부수효과·전역 상태 없이 입력을 읽기만 한다(문 상태머신 같은 carve-out 없음).
 *
 * 관용 분리(중요): creature/player flags는 hex string이라 `F_ISSET`(hexFlags.ts)로, room flags는
 * number[]라 `hasFlag`(door.ts)로 읽는다. 두 표현이 다른 헬퍼를 쓰므로 입력 타입에서 각각 string과
 * number[]로 강제한다 — 컴파일러가 관용 혼용을 차단한다(잘못 쓰면 게이트가 항상 통과하는 사고 방지).
 *
 * 입력은 최소 구조 shape(MoveGateActor 선례)이라, PlayerCombatState·CreatureInstance·RoomNode가
 * 구조적으로 할당 가능하다 — 호출자는 실 타입을 그대로 넘긴다.
 */

/** 게이트 결정 — 허용이면 쿨다운 증분 포함, 거부면 어느 게이트에서 막혔는지 사유 포함. */
export type CombatGateResult =
  | { readonly ok: true; readonly cooldownIncrement: number }
  | { readonly ok: false; readonly reason: string }

/** 대상 무적 게이트 입력. attacker는 플레이어(class·무기), defender는 크리처(hex flags). */
export interface TargetImmunityInput {
  readonly attacker: {
    /** 클래스 인덱스 — class<CARETAKER인 플레이어만 MENONL 대상 무적에 걸린다. */
    readonly class: number
    /** 착용 무기(미착용이면 null). MENONL은 adjustment>=1인 마법무기만 관통한다. */
    readonly weapon: { readonly adjustment: number } | null
  }
  /** 대상 크리처 — hex string flags. */
  readonly defender: { readonly flags: string }
}

/** PvP 3중 게이트 입력. flags는 hex(F_ISSET), room.flags는 number[](hasFlag), checkWarResult는 주입. */
export interface PvpGateInput {
  /** 공격자 플레이어 — hex flags + level. 선악 게이트는 양쪽 검사 모두 attacker.level을 쓴다(오라클). */
  readonly attacker: { readonly flags: string; readonly level: number }
  /** 대상 플레이어 — hex flags. */
  readonly defender: { readonly flags: string }
  /** 현재 방 — number[] flags. RNOKIL(안전지대)·RSUVIV(대련장)를 읽는다. */
  readonly room: { readonly flags: number[] }
  /**
   * 가족-전쟁 판정 결과(주입 seam). 원작 `check_war(...)` 대체값이다 — 양측 PFAMIL일 때만 의미가
   * 있으며, true면 선악 게이트를 재적용(전쟁 중 패거리원 교전 허용), false면 스킵(평시 패거리 보호).
   * 이름을 `atWar`가 아닌 `checkWarResult`로 두어, 미래 배선자가 의미를 조용히 뒤집지 못하게 한다.
   */
  readonly checkWarResult: boolean
}

/**
 * 대상 무적 게이트 pre-단계 — 플레이어→크리처 MUNKIL(command5.c:146). registerEnemy **전** 판정한다:
 * MUNKIL 크리처는 절대 해칠 수 없어 aggro 등록조차 하지 않는다(:148 이전). 통과 시 쿨다운 증분 0.
 */
export function checkTargetImmunityPre(input: Pick<TargetImmunityInput, 'defender'>): CombatGateResult {
  if (F_ISSET(input.defender.flags, MUNKIL)) {
    return { ok: false, reason: '당신은 그것을 해칠 수 없습니다.' }
  }
  return { ok: true, cooldownIncrement: 0 }
}

/**
 * 대상 무적 게이트 post-단계 — 플레이어→크리처 MMGONL/MENONL(command5.c:160-173). registerEnemy **후**
 * 판정한다 — 오라클 add_enm_crt(:153)가 이 두 거부(:160/:167) 앞이라, MMGONL/MENONL 크리처를 물리 공격하면
 * 타격은 거부돼도 aggro는 등록돼 몬스터가 이후 틱에 반격한다(criterion 3).
 *   1) MMGONL → 거부(마법만 유효).
 *   2) MENONL && class<CARETAKER → 무기 없음 || adjustment<1이면 거부(비마법무기 관통 불가).
 * 통과 시 쿨다운 증분 0(무적 게이트는 반격 쿨다운을 늘리지 않는다 — PvP 게이트만 +3).
 */
export function checkTargetImmunityPost(input: TargetImmunityInput): CombatGateResult {
  const { attacker, defender } = input
  if (F_ISSET(defender.flags, MMGONL)) {
    return { ok: false, reason: '당신의 무기는 아무 소용이 없는듯 합니다.' }
  }
  if (F_ISSET(defender.flags, MENONL) && attacker.class < CARETAKER) {
    if (attacker.weapon === null || attacker.weapon.adjustment < 1) {
      return { ok: false, reason: '당신의 무기는 아무 소용이 없는듯 합니다.' }
    }
  }
  return { ok: true, cooldownIncrement: 0 }
}

/**
 * PvP 3중 게이트 — 플레이어→플레이어(command5.c:176-201).
 *   1) RNOKIL 방 → 무조건 거부(안전지대).
 *   2) 양측 PFAMIL이면 consentApplies = checkWarResult, 아니면 consentApplies = true.
 *   3) consentApplies면 선악 게이트: 공격자/대상 중 하나라도 선(비 PCHAOS)하고 attacker.level<128이고
 *      비 RSUVIV면 거부(양쪽 검사 모두 attacker.level 사용 — 오라클 그대로).
 *   4) 양측 패거리 + 평화(checkWarResult=false)면 선악 게이트를 스킵하고 허용(오라클 재현, 정정 금지).
 * 통과 시 쿨다운 증분 +3(PVP_COOLDOWN_INCREMENT).
 */
export function checkPvpGate(input: PvpGateInput): CombatGateResult {
  const { attacker, defender, room, checkWarResult } = input

  if (hasFlag(room.flags, RNOKIL)) {
    return { ok: false, reason: '이 곳에서는 싸울 수 없습니다.' }
  }

  // PFAMIL은 "패거리 가입 여부" boolean이지 특정 패거리 ID가 아니다 — 어느 패거리에 속하는지·
  // 서로 같은 패거리인지 판정은 전적으로 주입된 checkWarResult(check_war)에 있다. family-ID 동일성을
  // 주장하는 이름을 피한다(미래 유지보수자가 family 매칭을 추가해 포팅을 깨지 않도록).
  const bothInFamily = F_ISSET(attacker.flags, PFAMIL) && F_ISSET(defender.flags, PFAMIL)
  const consentApplies = !bothInFamily || checkWarResult

  if (consentApplies) {
    // 오라클: 두 선악 검사 모두 attacker.level(<128) + 비 RSUVIV 방을 공유 조건으로 쓴다.
    const alignmentGateActive = attacker.level < 128 && !hasFlag(room.flags, RSUVIV)
    if (alignmentGateActive && !F_ISSET(attacker.flags, PCHAOS)) {
      return { ok: false, reason: '당신은 선하다는걸 아세요.' }
    }
    if (alignmentGateActive && !F_ISSET(defender.flags, PCHAOS)) {
      return { ok: false, reason: '그 사용자는 선해서 공격할 수 없습니다.' }
    }
  }

  return { ok: true, cooldownIncrement: PVP_COOLDOWN_INCREMENT }
}
