import { proficDivisorOf, type CreatureInstance, type RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import { combatantHp, applyCombatantDamage, type Combatant } from './combatant.js'
import type { PlayerCombatState } from './playerState.js'
import type { DamageLedger } from './enmity.js'
import { accumulateDamage } from './enmity.js'
import { playerBaseDamage, monsterDamage, hitThreshold, applyPaladinAlignment } from './attackStats.js'
import { resolveSpecialAttack, type SpecialAttackResult } from './specialAttack.js'
import {
  HIT_ROLL_MAX_PLAYER,
  HIT_ROLL_MAX_MONSTER,
  CRIT_MULTIPLIER_MIN,
  CRIT_MULTIPLIER_MAX,
  PALADIN,
  INVINCIBLE,
} from './constants.js'
import { F_ISSET, PUPDMG, OALCRT, OCURSE, MBEFUD } from '../world/hexFlags.js'

/**
 * resolveAttack — 명중→피해→크리/불발→적용을 단일 파이프로 통합하고 HP<1이면 died=true를 반환하는(fire-free)
 * 오라클 충실 이식(플레이어 command5.c:207-345 / 몬스터 update.c:373-447, 플랜 G1/G5).
 *
 * Story 10(T10.1): death seam 발화는 호출자(initiateAttack/combatTick)가 소유한다 — 근접 라운드가
 * target death를 end-of-round로 지연해 "막타치면 target 생존"을 재현하려면 resolveAttack이 즉시
 * 발화하면 안 되기 때문이다. fireDeath·ResolveContext seam은 magic offensiveSpell 공유로 무변경이다.
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

/**
 * 단일 타격 결과(메시지 렌더링 입력). 무기 마모·낙하는 실제 오브젝트 이동 없이 플래그만 표면화한다.
 * specialAttack은 몬스터 명중 타격일 때만 non-null이다(플레이어·미명중은 null).
 */
export interface AttackDescriptor {
  readonly hit: boolean
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly durabilityHit: boolean
  readonly weaponDropped: boolean
  /**
   * 몬스터 특수공격(update.c:387~480) 결과 마커 — 브레스·에너지드레인·독·질병·실명·장비용해 서술.
   * 실 status 부여·exp 차감·장비용해 적용은 #99 유예(여기선 마커만 표면화). 플레이어·미명중은 null.
   */
  readonly specialAttack: SpecialAttackResult | null
}

/** 라운드 전체 결과. 필드는 다중공격 타격들의 집계(하나라도 명중/크리/불발)다. */
export interface AttackOutcome {
  readonly hit: boolean
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly died: boolean
  /** 몬스터 특수공격 마커 — 명중 타격 중 첫 non-null(몬스터 근접은 단타라 사실상 유일). 없으면 null. */
  readonly specialAttack: SpecialAttackResult | null
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
  specialAttack: null,
}

/** 크리/불발·몬스터 단타 공통 피해 코어 — resolveCritFumble이 반환하는 형태(특수공격 마커 제외). */
interface StrikeCore {
  readonly damage: number
  readonly critical: boolean
  readonly fumble: boolean
  readonly weaponDropped: boolean
}

/** 단일 타격의 피해 산출 결과 — 코어 + 몬스터 특수공격 마커(플레이어 경로는 null). */
interface StrikeDamage extends StrikeCore {
  readonly specialAttack: SpecialAttackResult | null
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
function resolveCritFumble(state: PlayerCombatState, n: number, rng: CombatRng): StrikeCore {
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
 * 단일 타격의 피해 산출. 플레이어는 base→max(1,n)→PALADIN 보정→크리/불발, 몬스터는 특수공격 게이트
 * → breath-replace ?? monsterDamage 순으로 산출한다(재클램프 없음).
 *
 * ## 몬스터 특수공격 배선 (update.c:387~480, Story 9)
 * 명중 직후 특수공격 6종(브레스·에너지드레인·독·질병·실명·장비용해) 게이트를 monsterDamage **전에**
 * 굴린다 — MBRETH 게이트가 먼저 굴려져야 breath-replace가 성립하기 때문이다. 그 뒤:
 *   - **breath-replace(`??` lazy)**: 브레스 발동 시 breath 데미지가 normal melee를 **대체**한다. `??`의
 *     지연 우변이라 monsterDamage는 breath 미발동 시에만 굴려진다. `||` 대신 `??`를 쓰는 이유는 breath
 *     0 데미지가 monsterDamage로 fall through되면 안 되기 때문이다(double-roll·오데미지 방지).
 *     T9.1 "명중 직후 additive"처럼 읽히나 오라클은 replace다 — 의식적 divergence(Story 7 "살해자" 선례).
 *   - **★ MBEFUD fork**: 오라클 `if(MBEFUD) n=n/3`은 breath/else 분기 **밖**이라 breath 데미지에도
 *     적용된다. monsterDamage는 MBEFUD를 melee path 내부에 이미 적용하므로, breath 발동 시(breathDamage
 *     !== null)에만 여기서 추가 보정해 breath가 MBEFUD를 우회하지 않게 한다(melee path 이중 적용 없음).
 *   - **rng 순서 divergence(inert)**: 특수공격 굴림 순서(MBRETH→breath|drain→MPOISS→MDISEA→MBLNDR
 *     →MDISIT)는 오라클 순서를 정확히 보존하나, monsterDamage(melee)는 오라클(중간)과 달리 `??` 지연으로
 *     post-status 게이트 **뒤**에 굴려진다. status 게이트가 melee 값과 독립이라 behaviorally inert다.
 *
 * ## substrate gap (#99 유예)
 * PlayerCombatState는 experience 필드가 없어 흡수 상한을 실효 무효화한다 — MAX_SAFE_INTEGER를 넘겨
 * pre-cap raw drain을 산출하고, 실 exp 대비 상한·차감은 #99 소관이다. status 부여·장비용해 적용도 #99로
 * 유예하며 여기선 SpecialAttackResult 마커만 표면화한다(AttackOutcome은 새 객체, HP·ledger만 in-place).
 */
function computeStrike(attacker: Combatant, defender: Combatant, rng: CombatRng): StrikeDamage {
  if (attacker.kind === 'creature') {
    // defender flags(PRCOLD/PRFIRE 저항 판독)는 Combatant 통합 flags 필드로 kind 비대칭을 흡수한다.
    const special = resolveSpecialAttack(
      attacker.instance,
      { flags: defender.flags, experience: Number.MAX_SAFE_INTEGER },
      { rng },
    )
    // breath-replace: breath 미발동 시에만 monsterDamage를 굴린다(?? lazy RHS). 재클램프 금지(MBEFUD 0 보존).
    let damage = special.breathDamage ?? monsterDamage(attacker, defender, rng)
    // ★ MBEFUD fork — breath 발동 시에만 추가 /3(melee path는 monsterDamage가 이미 적용).
    if (special.breathDamage !== null && F_ISSET(attacker.instance.flags, MBEFUD)) {
      damage = Math.trunc(damage / 3)
    }
    return { damage, critical: false, fumble: false, weaponDropped: false, specialAttack: special }
  }

  // 플레이어 경로 — 특수공격 미호출(몬스터 한정, criterion 2). specialAttack=null.
  const { state } = attacker
  let n = playerBaseDamage(attacker, rng)
  n = Math.max(1, n) // command5.c:266 클램프(플레이어 정상타 min-1).
  if (state.class === PALADIN) n = applyPaladinAlignment(n, state.alignment, rng)
  return { ...resolveCritFumble(state, n, rng), specialAttack: null }
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

  const hpBefore = combatantHp(defender)
  const m = Math.max(0, Math.min(hpBefore, n)) // 오버킬 캡(ledger용, command5.c:320) + 음수 하한 방어.
  applyCombatantDamage(defender, n)

  // ledger 누적 — defender가 몬스터(비플레이어)일 때만(command5.c:322).
  if (defender.kind === 'creature') accumulateDamage(ctx.ledger, attackerId(attacker), m)

  return {
    hit: true,
    damage: n,
    critical: strike.critical,
    fumble: strike.fumble,
    durabilityHit,
    weaponDropped: strike.weaponDropped,
    specialAttack: strike.specialAttack,
  }
}

/**
 * defender 사망 seam을 kind별로 발화한다(command5.c:341). resolveAttack은 fire-free이므로(Story 10)
 * 이 함수를 호출자가 소비한다 — 근접은 initiateAttack(오프너 킬)·combatTick(end-of-round·counter 킬),
 * 주문은 offensiveSpell이 직접 발화한다. CastContext가 ResolveContext를 확장하므로 주문 경로도 동일
 * 시그니처로 공유한다. seam·시그니처 무변경(magic 공유).
 */
export function fireDeath(defender: Combatant, ctx: ResolveContext): void {
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
  specialAttack: null,
  messageInputs: { attacks: [] },
}

/**
 * 공격 해석 진입점 — 다중공격 count만큼 타격을 반복하되, defender HP<1이면 died=true를 세우고 break한다
 * (fire-free — death seam은 호출자가 발화, 오라클 die() 지연 재현). 집계 AttackOutcome을 새 객체로 반환한다.
 *
 * 진입 가드: 이미 사망한(HP<1) defender에 대한 stale/재진입 공격은 no-op한다. 오라클은 die()가 대상을
 * 즉시 free/제거해 재공격이 구조적으로 불가능하나, 이 포트는 사망 제거를 커넥션 계층으로 유예하므로
 * (D2 레지스트리 remove·방 occupants 제거가 별도) 사망 후에도 combatTick 근접 target·stale 참조로
 * resolveAttack이 재호출될 여지가 있다. 가드 없이 진입하면 오버킬로 음수가 된 HP에서 death seam이
 * 재발화(#83 소환·분배 중복)되고 음수 ledger가 누적된다 — 진입 시 HP<1이면 굴림 전에 차단한다.
 */
export function resolveAttack(attacker: Combatant, defender: Combatant, ctx: ResolveContext): AttackOutcome {
  if (combatantHp(defender) < 1) return DEAD_DEFENDER_NOOP

  const count = attacker.kind === 'player' ? multiAttackCount(attacker.state, ctx.rng) : 1
  const attacks: AttackDescriptor[] = []
  let died = false

  for (let j = 0; j < count; j += 1) {
    const descriptor = performStrike(attacker, defender, ctx)
    attacks.push(descriptor)

    // 사망 판정은 오라클처럼 명중 타격 내부에서만 수행한다(빗나감은 HP 불변이라 진입 불가·불발은
    // hit=true라 포함). command5.c:341이 명중 블록 안에 위치.
    //
    // ★ Story 10(T10.1): resolveAttack는 fire-free다. HP<1을 감지하면 died=true·break만 하고 death
    // seam을 발화하지 않는다 — 발화 책임은 호출자(initiateAttack/combatTick)로 이양한다. 근거:
    // 오라클 update.c:501~530 근접 라운드는 target death를 end-of-round로 지연해야 counter가 target을
    // 구할 수 있다("막타치면 target 생존"). resolveAttack이 근접 중 즉시 발화하면 이 지연이 불가능하다.
    // fireDeath·ResolveContext seam은 magic offensiveSpell 공유로 무변경이며, 여기선 호출만 제거한다.
    if (descriptor.hit && combatantHp(defender) < 1) {
      died = true
      break
    }
  }

  return {
    hit: attacks.some((a) => a.hit),
    damage: attacks.reduce((sum, a) => sum + a.damage, 0),
    critical: attacks.some((a) => a.critical),
    fumble: attacks.some((a) => a.fumble),
    died,
    // 명중 타격 중 첫 non-null 특수공격 마커(몬스터 근접은 count=1이라 사실상 유일, 플레이어는 전부 null).
    specialAttack: attacks.find((a) => a.specialAttack !== null)?.specialAttack ?? null,
    messageInputs: { attacks },
  }
}
