import { proficDivisorOf, type CreatureInstance, type RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import type { Combatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'
import type { DamageLedger } from './enmity.js'
import { accumulateDamage } from './enmity.js'
import { playerBaseDamage, monsterDamage, hitThreshold, applyPaladinAlignment } from './attackStats.js'
import {
  HIT_ROLL_MAX_PLAYER,
  HIT_ROLL_MAX_MONSTER,
  CRIT_MULTIPLIER_MIN,
  CRIT_MULTIPLIER_MAX,
  PALADIN,
  INVINCIBLE,
} from './constants.js'
import { F_ISSET, PUPDMG, OALCRT, OCURSE } from '../world/hexFlags.js'

/**
 * resolveAttack — 명중→피해→크리/불발→적용을 단일 파이프로 통합하고 HP<1 시 death seam을 발화하는
 * 오라클 충실 이식(플레이어 command5.c:207-345 / 몬스터 update.c:373-447, 플랜 G1/G5).
 *
 * 순수 함수: 전역 상태·Date.now·Math.random 없이 모든 랜덤을 ctx.rng(주입 CombatRng)로만 굴린다.
 * 유일한 in-place 변형은 defender HP 차감(worldGraph 승인 carve-out)·ledger 누적이며 AttackOutcome은
 * 매번 새 객체다.
 *
 * byte-fidelity 함정:
 *   - 모든 `/`는 C 정수 나눗셈 = Math.trunc(다중공격 count의 (level-97)/10, mod_profic 나눗수).
 *   - 플레이어 정상타만 max(1,n)(command5.c:266). 몬스터 경로는 monsterDamage 반환값을 재클램프하지
 *     않는다 — MBEFUD 약한 몬스터의 합법적 0 피해를 1로 되돌리지 않기 위함.
 *   - 크리 굴림 `mrand(1,100)`은 오라클 `||` 좌변이라 항상 소비된다(OALCRT 자동크리에도). 불발 굴림은
 *     크리 미발동 & 무기 착용 시에만 소비한다.
 *   - 의도적 미이식: 크리 시 무기 파괴 굴림 `mrand(1,100)<3`(command5.c:290)·불발 시 compute_thaco
 *     재계산·`if(crt->class>=DM)n=0`(command5.c:263, 무적 게이트는 Story 6)·숙련 XP 적립은 범위 밖.
 *     무기 오브젝트 이동(낙하·마모 shotscur)은 플래그로만 표면화한다.
 */

/** 사망 seam은 (dead, room, now)를 인자로 받는다(사전 바인딩 금지). Story 9가 deps만 바인딩한다. */
export interface ResolveContext {
  readonly rng: CombatRng
  readonly room: RoomNode
  readonly now: number
  readonly fireCreatureDeath: (dead: CreatureInstance, room: RoomNode, now: number) => void
  readonly firePlayerDeath: (dead: PlayerCombatState, room: RoomNode, now: number) => void
  readonly ledger: DamageLedger
}

/** 단일 타격 결과(메시지 렌더링 입력). 무기 마모·낙하는 실제 오브젝트 이동 없이 플래그만 표면화한다. */
interface AttackDescriptor {
  readonly hit: boolean
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly durabilityHit: boolean
  readonly weaponDropped: boolean
}

/** 라운드 전체 결과. 필드는 다중공격 타격들의 집계(하나라도 명중/크리/불발)다. */
export interface AttackOutcome {
  readonly hit: boolean
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly died: boolean
  readonly messageInputs: {
    readonly attacks: ReadonlyArray<AttackDescriptor>
  }
}

/** 미명중 타격 서술자 — 피해·후속 굴림 없이 hit 굴림만 소비한 결과. */
const MISS: AttackDescriptor = {
  hit: false,
  damage: 0,
  critical: false,
  fumble: false,
  durabilityHit: false,
  weaponDropped: false,
}

/** 단일 타격의 피해 산출 결과 — 조정된 피해와 상태 플래그(크리/불발·몬스터 단타 공통). */
interface StrikeDamage {
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly weaponDropped: boolean
}

/**
 * 다중공격 count — 초인 전용, 플레이어 attacker 한정(command5.c:207-215). PUPDMG 미보유·몬스터는 1.
 * count 굴림(rng(0,3)·rng(1,4))은 타격 루프 이전에 소비된다(오라클 순서).
 */
function multiAttackCount(state: PlayerCombatState, rng: CombatRng): number {
  let count = 1
  if (!F_ISSET(state.flags, PUPDMG)) return count
  if ((state.class === INVINCIBLE && state.level > 100) || state.class > INVINCIBLE) {
    if (Math.trunc((state.level - 97) / 10) + rng(0, 3) > 2) count += 1
  }
  if (state.class > INVINCIBLE && rng(1, 4) === 1) count += 1
  return count
}

/** mod_profic 파생값 — 무기 착용 시 trunc(proficiency / 나눗수(class)), 맨손이면 0(command5.c:279). */
function modProfic(state: PlayerCombatState): number {
  if (state.weapon === null) return 0
  return Math.trunc(state.weapon.proficiency / proficDivisorOf(state.class))
}

/**
 * 크리티컬·불발 판정(command5.c:279-306, 플레이어 한정).
 *
 * 크리 굴림 `rng(1,100)`은 항상 소비된다(오라클 `mrand(1,100)<=p || OALCRT`의 `||` 좌변). 크리면
 * `n *= rng(3,6)`. 미크리 & 무기 착용이면 불발 굴림 `rng(1,100)`을 소비하고 `<=(5-p) & !OCURSE`이면
 * n=0·무기 낙하. OCURSE 무기·미착용은 불발하지 않는다.
 */
function resolveCritFumble(state: PlayerCombatState, n: number, rng: CombatRng): StrikeDamage {
  const p = modProfic(state)
  const weapon = state.weapon
  const critRoll = rng(1, 100) // || 좌변 — 항상 소비(OALCRT 자동크리에도).
  const autoCrit = weapon !== null && F_ISSET(weapon.flags ?? '', OALCRT)

  if (critRoll <= p || autoCrit) {
    const mult = rng(CRIT_MULTIPLIER_MIN, CRIT_MULTIPLIER_MAX)
    // 크리 시 무기 파괴 굴림 mrand(1,100)<3(command5.c:290)은 이식 생략 — 무기 오브젝트 모델 범위 밖.
    return { damage: n * mult, critical: true, fumble: false, weaponDropped: false }
  }

  if (weapon !== null) {
    const fumbleRoll = rng(1, 100)
    if (fumbleRoll <= 5 - p && !F_ISSET(weapon.flags ?? '', OCURSE)) {
      // 무기 낙하·compute_thaco 재계산은 범위 밖 — 낙하 플래그만 표면화.
      return { damage: 0, critical: false, fumble: true, weaponDropped: true }
    }
  }

  return { damage: n, critical: false, fumble: false, weaponDropped: false }
}

/**
 * 단일 타격의 피해 산출. 플레이어는 base→max(1,n)→PALADIN 보정→크리/불발, 몬스터는 monsterDamage
 * 반환값을 재클램프 없이 그대로 쓴다.
 */
function computeStrike(attacker: Combatant, defender: Combatant, rng: CombatRng): StrikeDamage {
  if (attacker.kind === 'creature') {
    // 몬스터 경로 — 재클램프 금지(MBEFUD 0 피해 보존).
    return { damage: monsterDamage(attacker, defender, rng), critical: false, fumble: false, weaponDropped: false }
  }

  const { state } = attacker
  let n = playerBaseDamage(attacker, rng)
  n = Math.max(1, n) // command5.c:266 클램프(플레이어 정상타 min-1).
  if (state.class === PALADIN) n = applyPaladinAlignment(n, state.alignment, rng)
  return resolveCritFumble(state, n, rng)
}

/** defender 원본 참조의 현재 HP를 읽는다(Combatant.hpCurrent는 스냅샷 뷰이므로 원본에서 판독). */
function defenderHp(defender: Combatant): number {
  return defender.kind === 'player' ? defender.state.hpCurrent : defender.instance.hpcur
}

/** defender 원본 참조에 피해를 in-place 차감한다(worldGraph 승인 carve-out). */
function applyDamage(defender: Combatant, n: number): void {
  if (defender.kind === 'player') {
    defender.state.hpCurrent -= n
  } else {
    defender.instance.hpcur -= n
  }
}

/** attacker 식별자 — 플레이어=characterId, 몬스터=instanceId(ledger 키). */
function attackerId(attacker: Combatant): string {
  return attacker.kind === 'player' ? attacker.state.characterId : attacker.instance.instanceId
}

/** 명중 굴림 상한 — 플레이어 d30, 몬스터 d20(command5.c:236 / update.c:383). */
function hitRollMax(attacker: Combatant): number {
  return attacker.kind === 'player' ? HIT_ROLL_MAX_PLAYER : HIT_ROLL_MAX_MONSTER
}

/**
 * 단일 타격 처리 — 명중 판정 → 피해 산출 → 내구도 → in-place 차감 → ledger 누적. 사망은 상위 루프가
 * HP 판독으로 감지한다(내구도 굴림은 사망 판정보다 먼저, command5.c:308<341).
 */
function performStrike(attacker: Combatant, defender: Combatant, ctx: ResolveContext): AttackDescriptor {
  const { rng } = ctx
  const threshold = hitThreshold(attacker, defender)
  if (rng(1, hitRollMax(attacker)) < threshold) return MISS

  const strike = computeStrike(attacker, defender, rng)
  const n = strike.damage

  // 내구도 — 플레이어 & 무기 착용 & 불발 아님(불발은 무기가 이미 낙하해 굴림 대상 없음, command5.c:308).
  let durabilityHit = false
  if (attacker.kind === 'player' && attacker.state.weapon !== null && !strike.weaponDropped) {
    durabilityHit = rng(0, 3) === 0
  }

  const hpBefore = defenderHp(defender)
  const m = Math.max(0, Math.min(hpBefore, n)) // 오버킬 캡(ledger용, command5.c:320) + 음수 하한 방어.
  applyDamage(defender, n)

  // ledger 누적 — defender가 몬스터(비플레이어)일 때만(command5.c:322).
  if (defender.kind === 'creature') accumulateDamage(ctx.ledger, attackerId(attacker), m)

  return {
    hit: true,
    damage: n,
    critical: strike.critical,
    fumble: strike.fumble,
    durabilityHit,
    weaponDropped: strike.weaponDropped,
  }
}

/** defender 사망 seam을 kind별로 정확히 1회 발화한다(command5.c:341). */
function fireDeath(defender: Combatant, ctx: ResolveContext): void {
  if (defender.kind === 'creature') {
    ctx.fireCreatureDeath(defender.instance, ctx.room, ctx.now)
  } else {
    ctx.firePlayerDeath(defender.state, ctx.room, ctx.now)
  }
}

/** 이미 사망한 defender에 대한 no-op 결과 — 굴림·피해·death seam·ledger 누적 없이 즉시 반환. */
const DEAD_DEFENDER_NOOP: AttackOutcome = {
  hit: false,
  damage: 0,
  critical: false,
  fumble: false,
  died: false,
  messageInputs: { attacks: [] },
}

/**
 * 공격 해석 진입점 — 다중공격 count만큼 타격을 반복하되, defender HP<1이면 death seam 발화 후 break한다
 * (오라클 die() 후 return). 집계 AttackOutcome을 새 객체로 반환한다.
 *
 * 진입 가드: 이미 사망한(HP<1) defender에 대한 stale/재진입 공격은 no-op한다. 오라클은 die()가 대상을
 * 즉시 free/제거해 재공격이 구조적으로 불가능하나, 이 포트는 사망 제거를 커넥션 계층으로 유예하므로
 * (D2 레지스트리 remove·방 occupants 제거가 별도) 사망 후에도 combatTick 근접 target·stale 참조로
 * resolveAttack이 재호출될 여지가 있다. 가드 없이 진입하면 오버킬로 음수가 된 HP에서 death seam이
 * 재발화(#83 소환·분배 중복)되고 음수 ledger가 누적된다 — 진입 시 HP<1이면 굴림 전에 차단한다.
 */
export function resolveAttack(attacker: Combatant, defender: Combatant, ctx: ResolveContext): AttackOutcome {
  if (defenderHp(defender) < 1) return DEAD_DEFENDER_NOOP

  const count = attacker.kind === 'player' ? multiAttackCount(attacker.state, ctx.rng) : 1
  const attacks: AttackDescriptor[] = []
  let died = false

  for (let j = 0; j < count; j += 1) {
    const descriptor = performStrike(attacker, defender, ctx)
    attacks.push(descriptor)

    // 사망 판정은 오라클처럼 명중 타격 내부에서만 수행한다(빗나감은 HP 불변이라 진입 불가·불발은
    // hit=true라 포함). command5.c:341이 명중 블록 안에 위치.
    if (descriptor.hit && defenderHp(defender) < 1) {
      died = true
      fireDeath(defender, ctx)
      break
    }
  }

  return {
    hit: attacks.some((a) => a.hit),
    damage: attacks.reduce((sum, a) => sum + a.damage, 0),
    critical: attacks.some((a) => a.critical),
    fumble: attacks.some((a) => a.fumble),
    died,
    messageInputs: { attacks },
  }
}
