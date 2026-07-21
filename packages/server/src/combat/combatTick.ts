import type { CreatureInstance, RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import type { CombatRegistry } from './combatRegistry.js'
import type { DamageLedger } from './enmity.js'
import type { PlayerCombatState } from './playerState.js'
import { resolveAttack, type ResolveContext } from './resolveAttack.js'
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
 * 의도적 단순화(D7 / #91 — 별도 패치로 재현): 오라클 update.c 라운드는 (a) 다른 적 반격 → target 반격
 * last, (b) `attack_crt`에 attacker-HP 가드가 없어 근접에 죽어가는 target도 마지막에 반격을 날림,
 * (c) 반격이 몬스터를 죽이면 `die(att_ptr)`를 스킵해 "막타치면 target 생존", (d) target 사망 판정을
 * end-of-round로 지연한다. 현재 구현은 Story 8의 `resolveAttack` 내부 즉시 death 발화 위에 서므로
 * target-first 순서 + 근접 즉시 사망(막타 생존 미재현)으로 근사한다. death seam은 어느 쪽이든 정확히
 * 1회 발화하므로 이번 슬라이스에서는 무해하며, 오라클 충실 라운드 순서·막타 생존은 #91 후속 패치가 다룬다.
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

    if (doMelee) {
      resolveAttack(toCombatant(creature), toCombatant(target), ctx)
    }

    // 반격 — present 적마다 독립 반응. 주문=근접 대체이나 반격은 플레이어 독립 반응이라 항상 진행한다.
    for (const player of presentEnemies) {
      // 몬스터가 이전 반격에 사망하면 후속 반격을 중단한다(death seam 중복 방지 — resolveAttack이
      // 이미 발화했고, break가 둘째 resolveAttack 진입 자체를 막는다).
      if (creature.hpcur < 1) break
      // 몬스터 근접에 사망한 플레이어는 반격 불가(의도적 단순화 — 오라클은 죽어가는 target도 last에
      // 반격, D7 / #91 후속 패치).
      if (player.hpCurrent < 1) continue
      // LT_ATTCK 쿨다운 미도래.
      if (player.nextAttackAt > now) continue

      resolveAttack(toCombatant(player), toCombatant(creature), ctx)
      // 쿨다운 재설정 — 반격 대상이 몬스터라 PvP +3 미적용(command5.c:131/135).
      player.nextAttackAt = now + (F_ISSET(player.flags, PBLIND) ? ATTACK_COOLDOWN_BLIND : ATTACK_COOLDOWN_INTERVAL)
    }
  }
}
