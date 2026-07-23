import type { CreatureInstance, RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import type { CombatRegistry } from './combatRegistry.js'
import type { DamageLedger } from './enmity.js'
import type { PlayerCombatState } from './playerState.js'
import { resolveAttack, fireDeath, type ResolveContext, type AttackOutcome } from './resolveAttack.js'
import { toCombatant } from './combatant.js'
import type { OnCombatTick } from '../world/creatureTick.js'
import { F_ISSET, MMAGIC, MCHARM, PBLIND } from '../world/hexFlags.js'
import {
  MONSTER_SPELL_CAST_CHANCE,
  ATTACK_COOLDOWN_INTERVAL,
  ATTACK_COOLDOWN_BLIND,
} from './constants.js'

/**
 * createCombatTick — deps를 클로저 바인딩해 몬스터 근접 + 적 플레이어 반격을 실행하는 OnCombatTick
 * 핸들러를 만드는 팩토리(오라클 update.c §1·§3, 반격 command5.c). creatureTick 슬롯이 §3.5 게이트를
 * 통과시킨 크리처마다 이 핸들러를 호출한다.
 *
 * 라운드 모델: 몬스터가 첫 present 적을 근접(또는 MMAGIC 주문으로 대체)하고, 그 몬스터의 적 리스트에
 * 오른 present 플레이어들이 각자 LT_ATTCK 쿨다운(nextAttackAt) 게이트를 통과할 때만 자동 반격한다.
 * 오프너·능동 공격 루프는 없다 — 플레이어 피해는 전부 이 몬스터 틱에 접힌 반격이다.
 *
 * criterion 5(케이던스 재구현 없음): 이 핸들러는 `creature.nextActionAt`을 절대 읽거나 쓰지 않는다.
 * 몬스터 행동 케이던스(민첩 기반 2~3초 재스케줄)는 creatureTick 슬롯이 소유하며, 여기서는 이번 틱의
 * 근접·반격 실행만 담당한다. 플레이어 반격 쿨다운은 별도 필드 `nextAttackAt`으로만 관리한다.
 *
 * ## 오라클 충실 라운드 순서 (#91, update.c:501~530)
 * resolveAttack가 fire-free가 되면서(Story 10 T10.1) 오라클 근접 라운드를 충실히 재현한다:
 *   (a) counter 역순 — OTHER enemies(presentEnemies[1..]) 먼저, TARGET(presentEnemies[0]) 마지막
 *       (오라클 first_enm->next_tag 루프 뒤 att_ptr 반격 last).
 *   (b) attack_crt에 attacker-HP 가드가 없어 근접에 죽어가는 target도 마지막에 반격을 날린다.
 *   (c) counter가 몬스터를 죽이면(goto crt_died; if(rtn) continue) target 사망 체크를 스킵 →
 *       "막타치면 target 생존"(target pending death 취소).
 *   (d) target 사망 판정을 end-of-round로 지연한다(att_ptr->hpcur<1이면 die) — 몬스터 생존 시에만.
 * death seam은 이제 combatTick이 발화한다(resolveAttack fire-free) — 몬스터 death는 이를 죽인 counter가
 * 1회, target death는 end-of-round 1회(취소 안 됐을 때). 근접이 target을 HP<1로 떨어뜨려도 즉시
 * 발화하지 않고 pending으로 남긴다. flee 실 배선(update.c:526 PWIMPY/PFEARS)은 범위 밖(Story 8 순수 함수만).
 */

/** 주문 시전 결과 — 'cast'=주문이 그 라운드 근접을 대체(근접 스킵), 'none'=근접 진행(update.c:348 return 1/0). */
export type SpellCastResult = 'cast' | 'none'

/**
 * 주문 시전 seam — MMAGIC 몬스터가 target에게 주문을 시전한다(A6 소관). 반환값이 근접 진행 여부를 정한다.
 * update.c:348 return 2(라운드 재시작)는 #84 범위 밖이라 이식하지 않는다. 기본 seam은 'none'을 반환한다.
 */
export type CastSpellSeam = (
  caster: CreatureInstance,
  target: PlayerCombatState,
  ctx: ResolveContext,
) => SpellCastResult

/** 기본 주문 seam — 항상 'none'(근접 진행). A6 마법 배선이 대체한다. */
const defaultCastSpell: CastSpellSeam = () => 'none'

/** createCombatTick 의존성 — 팩토리가 클로저로 바인딩한다. */
export interface CombatTickDeps {
  /** 전투 굴림 seam(주입 CombatRng) — MMAGIC 시전·근접·반격이 공유한다. */
  readonly rng: CombatRng
  /** present 적 플레이어 해소 — characterId로 라이브 전투상태 조회. */
  readonly registry: Pick<CombatRegistry, 'get'>
  /** 데미지 원장 — resolveAttack ctx가 누적(deps 주입 단일 인스턴스). */
  readonly ledger: DamageLedger
  /** 크리처 사망 seam — resolveAttack이 (dead, room, now)로 발화. */
  readonly fireCreatureDeath: (dead: CreatureInstance, room: RoomNode, now: number) => void
  /** 플레이어 사망 seam — resolveAttack이 (dead, room, now)로 발화. */
  readonly firePlayerDeath: (dead: PlayerCombatState, room: RoomNode, now: number) => void
  /**
   * tick 소스 공급자 — 실 배선에서 반드시 WorldClock/creatureTick 슬롯이 쓰는 동일 monotonic tick
   * 소스(tickSec)를 읽어야 한다. Date.now 등 다른 시계에 물리면 player nextAttackAt 쿨다운이 몬스터
   * 케이던스와 어긋나 반격 빈도가 밸런스에서 이탈한다.
   */
  readonly now: () => number
  /** MMAGIC 주문 시전 seam(옵셔널). 미주입이면 기본 no-op('none' → 근접 진행). */
  readonly castSpell?: CastSpellSeam
}

/**
 * 몬스터 근접 + 적 플레이어 반격 핸들러를 만든다. deps를 클로저로 바인딩한 순수 seam이다
 * (resolveAttack ctx는 매 호출마다 새로 조립).
 */
export function createCombatTick(deps: CombatTickDeps): OnCombatTick {
  const castSpell = deps.castSpell ?? defaultCastSpell

  return (creature: CreatureInstance, room: RoomNode): void => {
    // #83 aggro 경계 — 적 없으면 즉시 종료(선공 타깃 선정은 타깃 관리 #83 소관).
    if (creature.enemies.length === 0) return

    // stale-dead 가드 — 이미 사망(hpcur<1)한 몬스터는 이번 틱에 행동하지 않는다. 사망 제거가 커넥션
    // 계층으로 유예돼(D2/#99, deathDistribution) creatureTick이 HP 가드 없이 재디스패치할 수 있으므로,
    // 근접·counter 진입 전 차단한다(resolveAttack DEAD_DEFENDER_NOOP 선례). 없으면 counter의 NOOP 뒤
    // `creature.hpcur<1` 관찰이 fireCreatureDeath를 재발화해 exactly-once를 깨고 정당한 target death까지
    // 취소한다. 오라클도 die()가 크리처를 즉시 제거해 재행동이 구조적으로 불가능하다.
    if (creature.hpcur < 1) return

    const now = deps.now()

    // present 적 플레이어 해소 — enemies 순서를 보존하며 방에 있고 레지스트리에 등록된 것만 수집한다.
    // "첫 적"은 enemies[0]이 아니라 이 리스트의 [0](= enemies 중 첫 present 플레이어)이다 — enemies[0]이
    // 미해소(퇴장·미등록)면 다음 present 적으로 넘어간다.
    const presentEnemies: PlayerCombatState[] = []
    for (const id of creature.enemies) {
      if (!room.occupants.has(id)) continue
      const state = deps.registry.get(id)
      if (state === undefined) continue
      presentEnemies.push(state)
    }
    if (presentEnemies.length === 0) return

    const target = presentEnemies[0]!

    // stale-dead 플레이어 가드 — 틱 시작(근접 전) 생존을 스냅샷해 counter 자격을 스코핑한다. 오라클은
    // die()가 죽은 플레이어를 즉시 제거해 반격이 구조적으로 불가능하나, 이 포트는 사망 제거를 #99로
    // 유예하므로 이전 틱 사망(stale-dead) 플레이어가 occupants/registry에 잔존해 반격할 수 있다. counter는
    // resolveAttack(player→monster)를 굴리는데 DEAD_DEFENDER_NOOP는 defender(몬스터)만 검사하므로,
    // 죽은 플레이어가 몬스터에 데미지·ledger 크레딧·심지어 킬까지 하는 결함이 생긴다. 틱 시작 생존
    // 스냅샷으로 이번 라운드 근접에 죽는 target(시작 시 생존 → 반격 유지, attack_crt attacker-HP 가드
    // 없음)과 stale-dead(시작 시 사망 → 반격 자격 박탈)를 구분한다.
    const aliveAtStart = new Map<PlayerCombatState, boolean>(
      presentEnemies.map((p) => [p, p.hpCurrent >= 1]),
    )

    // 이번 틱의 ResolveContext를 조립한다 — deps만 바인딩하고 death seam은 커링하지 않는다(사전
    // 바인딩 금지, resolveAttack.ts:37). resolveAttack이 ctx를 read-only로 취급하므로(유일 변형은
    // 공유 참조 ledger 누적) 틱당 1개 인스턴스를 근접·반격에서 공유한다.
    const ctx: ResolveContext = {
      rng: deps.rng,
      room,
      now,
      fireCreatureDeath: deps.fireCreatureDeath,
      firePlayerDeath: deps.firePlayerDeath,
      ledger: deps.ledger,
    }

    // MMAGIC 주문 분기 — 시전 성공('cast')이면 그 라운드 근접만 스킵한다(update.c:348).
    // MCHARM 단순화: 오라클 p는 is_charm_crt(name, target) && MCHARM(시전자 특정)이고 시전 확률 굴림
    // 뒤에 !p로 억제하나(굴림 소비), 여기서는 MCHARM을 blanket no-cast로 근사한다(굴림 미소비, charmer
    // 특정·charm 전반은 A2/A7 범위 밖). 반격은 주문과 무관하게 항상 유지한다.
    let doMelee = true
    if (F_ISSET(creature.flags, MMAGIC) && !F_ISSET(creature.flags, MCHARM)) {
      if (deps.rng(1, 100) <= MONSTER_SPELL_CAST_CHANCE) {
        if (castSpell(creature, target, ctx) === 'cast') doMelee = false
      }
    }

    // 몬스터 근접(target melee) — fire-free. target이 HP<1로 떨어져도 즉시 발화하지 않고 pending으로
    // 남긴다(end-of-round 지연). meleeOutcome.died가 "이번 라운드에 target이 근접으로 죽었는가"의
    // 신호다 — stale-dead(이전 틱 사망) target은 resolveAttack DEAD_DEFENDER_NOOP로 died=false라
    // end-of-round에서 재발화되지 않고, spell-kill(doMelee=false)은 offensiveSpell이 즉시 발화하므로
    // meleeOutcome=null이라 여기서 중복 발화하지 않는다.
    let meleeOutcome: AttackOutcome | null = null
    if (doMelee) {
      meleeOutcome = resolveAttack(toCombatant(creature), toCombatant(target), ctx)
    }

    // counter 역순(update.c:501~530): OTHER enemies(presentEnemies[1..]) 먼저, TARGET(presentEnemies[0])
    // 마지막. attack_crt엔 attacker-HP 가드가 없으므로 근접에 죽어가는 target도 last에 반격을 날린다.
    // 단, live HP 가드 대신 틱 시작 생존 스냅샷(aliveAtStart)으로 stale-dead만 배제한다 — 이번 라운드
    // 근접에 죽는 target은 시작 시 생존이라 자격을 유지하고, 이전 틱 사망 잔존자만 걸러진다.
    const counterOrder = [...presentEnemies.slice(1), target]

    let monsterDied = false
    for (const player of counterOrder) {
      // stale-dead(틱 시작 시 이미 사망) 플레이어는 반격 자격 없음 — 오라클 die() 즉시 제거 근사.
      if (!aliveAtStart.get(player)) continue
      // LT_ATTCK 쿨다운 미도래 → 이 반격만 스킵.
      if (player.nextAttackAt > now) continue

      resolveAttack(toCombatant(player), toCombatant(creature), ctx)
      // 쿨다운 재설정 — 반격 대상이 몬스터라 PvP +3 미적용(command5.c:131/135).
      player.nextAttackAt = now + (F_ISSET(player.flags, PBLIND) ? ATTACK_COOLDOWN_BLIND : ATTACK_COOLDOWN_INTERVAL)

      // 몬스터가 이 counter에 사망 → death 1회 발화(fire-free 이양) + target pending death 취소 후 중단.
      // 오라클 goto crt_died; if(rtn){ continue }로 target 사망 체크를 스킵 → "막타치면 target 생존".
      if (creature.hpcur < 1) {
        fireDeath(toCombatant(creature), ctx)
        monsterDied = true
        break
      }
    }

    // end-of-round target 사망 판정(update.c:522 att_ptr->hpcur<1 → die) — 몬스터가 counter에 죽지
    // 않았고(취소 안 됨) target이 이번 라운드 근접으로 죽었을 때만 1회 발화한다.
    if (!monsterDied && meleeOutcome?.died === true) {
      fireDeath(toCombatant(target), ctx)
    }
  }
}
