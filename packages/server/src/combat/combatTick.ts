import type { CreatureInstance, RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import type { CombatRegistry } from './combatRegistry.js'
import type { CreatureLedgers } from './creatureLedgers.js'
import type { PlayerCombatState } from './playerState.js'
import {
  resolveAttack,
  rollHit,
  noDamageOutcome,
  fireDeath,
  type ResolveContext,
  type AttackOutcome,
} from './resolveAttack.js'
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
 * 통과시킨 몬스터마다 이 핸들러를 호출한다.
 *
 * 라운드 모델: 몬스터가 첫 present 적을 근접(또는 MMAGIC 주문으로 대체)하고, 그 몬스터의 적 리스트에
 * 오른 present 플레이어들이 각자 LT_ATTCK 쿨다운(nextAttackAt) 게이트를 통과할 때만 자동 반격한다.
 * 오프너·능동 공격 루프는 없다 — 플레이어 피해는 전부 이 몬스터 틱에 접힌 반격이다.
 *
 * criterion 5(케이던스 재구현 없음): 이 핸들러는 `creature.nextActionAt`을 절대 읽거나 쓰지 않는다.
 * 몬스터 행동 케이던스(민첩 기반 2~3초 재스케줄)는 creatureTick 슬롯이 담당하며, 여기서는 이번 틱의
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
 * death seam은 이제 combatTick이 실행한다(resolveAttack fire-free) — 몬스터 death는 이를 죽인 counter가
 * 1회, target death는 end-of-round 1회(취소 안 됐을 때). 근접이 target을 HP<1로 떨어뜨려도 즉시
 * 발생시키지 않고 pending으로 남긴다. flee 실 연결(update.c:526 PWIMPY/PFEARS)은 범위 밖(Story 8 순수 함수만).
 *
 * ## 라운드 보고 seam (§3.2)
 * `deps.onRoundResolved`(옵셔널)는 몬스터가 표적에게 시전이나 근접으로 행동한 라운드마다 정확히 1회
 * `CombatRoundReport`를 받는다. 행동 전에 끝나는 경로(적 없음·몬스터 사망·present 적 없음)는 보고하지
 * 않는다. 보고는 모든 상태 변경(end-of-round 사망 실행 포함) 뒤에 하므로 콜백은 확정된 결과만 본다.
 * 콜백 주입 여부는 라운드 진행에 영향을 주지 않는다 — 보고서 조립만 달라진다.
 *
 * ## 시전 치사 라운드 종료 (D7)
 * `castSpell` 안에서 표적의 사망 seam이 실행되면(offensiveSpell 치사 경로) 근접·반격 없이 라운드를
 * 끝낸다. 다른 적의 반격도 없다(오라클 update.c: crt_spell 뒤 표적 재조회 실패 → end_enm_crt 후 continue).
 * 시전 피해는 castSpell 전후 표적 전투상태 객체의 hpCurrent 차이다(D5 — 사망 seam은 옛 객체를 바꾸지
 * 않으므로 시전 치사여도 실제 차감량과 같다).
 *
 * ## 사망 취소 상태 표적 (D8)
 * 반격으로 몬스터가 죽어 사망이 취소된 표적은 HP<1인 채 생존한다. 라운드 시작 hpCurrent<1인 표적에게는
 * 근접 대신 명중 판정(rollHit) 굴림 1개만 소비한다 — 피해 차감·원장 누적 없음, resolveAttack의
 * DEAD_DEFENDER_NOOP 가드는 그대로다. 명중했고 몬스터가 반격으로 죽지 않았을 때만 라운드 끝에 사망
 * seam을 1회 실행한다(반격 처치 시 다시 취소). MMAGIC 'cast'면 근접이 없어 그 라운드엔 사망하지 않는다.
 * 이 표적은 반격하지 않는다(aliveAtStart). 오라클 사망 판정(update.c `if(att_ptr->hpcur < 1) die()`)이
 * 명중 분기 안에 있는 것을 따른다.
 */

/** 주문 시전 결과 — 'cast'=주문이 그 라운드 근접을 대체(근접 스킵), 'none'=근접 진행(update.c:348 return 1/0). */
export type SpellCastResult = 'cast' | 'none'

/**
 * 주문 시전 seam — MMAGIC 몬스터가 target에게 주문을 시전한다(A6 담당). 반환값이 근접 진행 여부를 정한다.
 * update.c:348 return 2(라운드 재시작)는 #84 범위 밖이라 이식하지 않는다. 기본 seam은 'none'을 반환한다.
 */
export type CastSpellSeam = (
  caster: CreatureInstance,
  target: PlayerCombatState,
  ctx: ResolveContext,
) => SpellCastResult

/**
 * 표적에 대한 몬스터 행동 — 근접이면 집계 AttackOutcome, 시전이면 시전 전후 표적 HP 차이(D5).
 * 표적 외 대상 시전(자기 회복 등)은 damage 0이다.
 */
export type IncomingAction =
  | { readonly kind: 'melee'; readonly outcome: AttackOutcome }
  | { readonly kind: 'cast'; readonly damage: number }

/** 몬스터가 행동한 라운드 1회의 결과 보고서(§3.2) — 메시지·상태 송신 계층의 입력. */
export interface CombatRoundReport {
  /** 이번 라운드의 몬스터. */
  readonly creature: CreatureInstance
  /** 이번 라운드의 방. */
  readonly room: RoomNode
  /** 표적 플레이어(presentEnemies[0])의 characterId. */
  readonly targetId: string
  /** 표적에 대한 몬스터 행동. */
  readonly incoming: IncomingAction
  /** 실제로 굴린 반격만, 굴린 순서대로(쿨다운 미도래·stale-dead는 빠진다). */
  readonly counters: ReadonlyArray<{
    readonly characterId: string
    readonly outcome: AttackOutcome
  }>
  /** 이번 라운드 반격으로 몬스터가 죽었는가. */
  readonly monsterDied: boolean
  /** 이번 라운드에 사망 seam이 실행된 플레이어의 characterId(실행 순서). */
  readonly playerDeaths: readonly string[]
  /** 라운드 시작 시 presentEnemies 전원의 hp·mp 스냅샷(상태 변경자 판정용). */
  readonly statsBefore: ReadonlyMap<
    string,
    { readonly hpCurrent: number; readonly mpCurrent: number }
  >
}

/** 기본 주문 seam — 항상 'none'(근접 진행). A6 마법 연결이 대체한다. */
const defaultCastSpell: CastSpellSeam = () => 'none'

/** 표적에 대한 몬스터 행동 결과 + 라운드 끝 표적 사망 대기 여부. */
interface TargetAction {
  readonly incoming: IncomingAction
  readonly pendingTargetDeath: boolean
}

/**
 * 표적 근접 단계 — 시전했으면 그대로 넘기고(근접 없음, 사망 대기 없음), 아니면 근접을 굴린다.
 * 사망 취소 상태 표적(D8)은 resolveAttack 대신 rollHit 굴림 1개만 소비해 피해 0 결과를 만들고, 명중이
 * 곧 사망 대기다. 일반 표적은 resolveAttack(fire-free)의 died가 사망 대기다. 굴림 위치는 기존 근접과 같다.
 */
function targetAction(
  castIncoming: IncomingAction | null,
  creature: CreatureInstance,
  target: PlayerCombatState,
  ctx: ResolveContext,
  deathCancelled: boolean,
): TargetAction {
  if (castIncoming !== null) return { incoming: castIncoming, pendingTargetDeath: false }
  if (deathCancelled) {
    const hit = rollHit(toCombatant(creature), toCombatant(target), ctx.rng)
    return { incoming: { kind: 'melee', outcome: noDamageOutcome(hit) }, pendingTargetDeath: hit }
  }
  const outcome = resolveAttack(toCombatant(creature), toCombatant(target), ctx)
  return { incoming: { kind: 'melee', outcome }, pendingTargetDeath: outcome.died }
}

/** createCombatTick 의존성 — 팩토리가 클로저로 바인딩한다. */
export interface CombatTickDeps {
  /** 전투 굴림 seam(주입 CombatRng) — MMAGIC 시전·근접·반격이 공유한다. */
  readonly rng: CombatRng
  /** present 적 플레이어 해석 — characterId로 라이브 전투상태 조회. */
  readonly registry: Pick<CombatRegistry, 'get'>
  /**
   * 몬스터별 데미지 원장 라우터 — 라운드마다 `for(creature.instanceId)`로 이번 몬스터의 원장을 얻는다.
   * 공격 핸들러와 같은 인스턴스를 주입한다(몬스터별로 나누는 근거는 `creatureLedgers.ts` 헤더).
   */
  readonly ledgers: Pick<CreatureLedgers, 'for'>
  /** 몬스터 사망 seam — resolveAttack이 (dead, room, now)로 실행. */
  readonly fireCreatureDeath: (dead: CreatureInstance, room: RoomNode, now: number) => void
  /** 플레이어 사망 seam — resolveAttack이 (dead, room, now)로 실행. */
  readonly firePlayerDeath: (dead: PlayerCombatState, room: RoomNode, now: number) => void
  /**
   * tick 소스 공급자 — 실 연결에서 반드시 WorldClock/creatureTick 슬롯이 쓰는 동일 monotonic tick
   * 소스(tickSec)를 읽어야 한다. Date.now 등 다른 시계에 물리면 player nextAttackAt 쿨다운이 몬스터
   * 케이던스와 어긋나 반격 빈도가 밸런스에서 이탈한다.
   */
  readonly now: () => number
  /** MMAGIC 주문 시전 seam(옵셔널). 미주입이면 기본 no-op('none' → 근접 진행). */
  readonly castSpell?: CastSpellSeam
  /**
   * 라운드 보고 seam(옵셔널) — 몬스터가 행동한 라운드마다 모든 상태 변경 뒤 1회 호출된다.
   * 미주입이어도 라운드 진행(D7 포함)은 같다. 콜백은 throw하지 않아야 한다(계약 — 전송 실패는 콜백 안에서
   * 격리한다). creatureTick은 try/catch 없이 호출하지만 프로덕션 조립(`liveWorldWiring`의 전투 tick 래퍼)이
   * 몬스터 단위로 잡아 로그를 남기므로, 계약 위반은 그 몬스터의 라운드만 끊고 나머지 몬스터는 진행한다.
   * 다만 콜백은 모든 상태 변경 뒤에 불리므로 그때의 예외는 통지 누락으로만 나타난다.
   */
  readonly onRoundResolved?: (report: CombatRoundReport) => void
}

/**
 * 몬스터 근접 + 적 플레이어 반격 핸들러를 만든다. deps를 클로저로 바인딩한 순수 seam이다
 * (resolveAttack ctx는 매 호출마다 새로 조립).
 */
export function createCombatTick(deps: CombatTickDeps): OnCombatTick {
  const castSpell = deps.castSpell ?? defaultCastSpell

  return (creature: CreatureInstance, room: RoomNode): void => {
    // #83 aggro 경계 — 적 없으면 즉시 종료(선공 타깃 선정은 타깃 관리 #83 담당).
    if (creature.enemies.length === 0) return

    // stale-dead 가드 — 이미 사망(hpcur<1)한 몬스터는 이번 틱에 행동하지 않는다. 사망 제거가 커넥션
    // 계층으로 보류돼(D2/#99, deathDistribution) creatureTick이 HP 가드 없이 재디스패치할 수 있으므로,
    // 근접·counter 진입 전 차단한다(resolveAttack DEAD_DEFENDER_NOOP 선례). 없으면 counter의 NOOP 뒤
    // `creature.hpcur<1` 관찰이 fireCreatureDeath를 재실행해 exactly-once를 깨고 정당한 target death까지
    // 취소한다. 오라클도 die()가 몬스터를 즉시 제거해 재행동이 구조적으로 불가능하다.
    if (creature.hpcur < 1) return

    const now = deps.now()

    // present 적 플레이어 해석 — enemies 순서를 보존하며 방에 있고 레지스트리에 등록된 것만 수집한다.
    // "첫 적"은 enemies[0]이 아니라 이 리스트의 [0](= enemies 중 첫 present 플레이어)이다 — enemies[0]이
    // 미해석(퇴장·미등록)면 다음 present 적으로 넘어간다.
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
    // 보류하므로 이전 틱 사망(stale-dead) 플레이어가 occupants/registry에 잔존해 반격할 수 있다. counter는
    // resolveAttack(player→monster)를 굴리는데 DEAD_DEFENDER_NOOP는 defender(몬스터)만 검사하므로,
    // 죽은 플레이어가 몬스터에 데미지·ledger 크레딧·심지어 킬까지 하는 결함이 생긴다. 틱 시작 생존
    // 스냅샷으로 이번 라운드 근접에 죽는 target(시작 시 생존 → 반격 유지, attack_crt attacker-HP 가드
    // 없음)과 stale-dead(시작 시 사망 → 반격 자격 박탈)를 구분한다. 사망 seam이 부활 처리를 끝내므로
    // stale-dead 대상은 사망 취소 상태(D8 — 반격 처치로 사망이 취소돼 HP<1인 채 생존) 하나만 남는다.
    const aliveAtStart = new Map<PlayerCombatState, boolean>(
      presentEnemies.map((p) => [p, p.hpCurrent >= 1]),
    )

    // 보고서용 라운드 시작 스냅샷 — 근접·시전 차감 이전 값. 보고 콜백이 없으면 만들지 않는다(핫 패스).
    const onReport = deps.onRoundResolved
    const statsBefore =
      onReport === undefined
        ? undefined
        : new Map(
            presentEnemies.map((p) => [
              p.characterId,
              { hpCurrent: p.hpCurrent, mpCurrent: p.mpCurrent },
            ]),
          )

    // 플레이어 사망 seam 라운드 로컬 래퍼 — 실행된 characterId를 기록한 뒤 deps에 위임한다. 시전 치사
    // 판정(D7)과 보고서 playerDeaths가 이 기록을 쓴다. 사망 1회 실행 규칙은 기존 호출 지점 그대로다.
    const playerDeaths: string[] = []
    const firePlayerDeath: ResolveContext['firePlayerDeath'] = (dead, deathRoom, deathNow) => {
      playerDeaths.push(dead.characterId)
      deps.firePlayerDeath(dead, deathRoom, deathNow)
    }
    const counters: { characterId: string; outcome: AttackOutcome }[] = []
    const report = (incoming: IncomingAction, monsterDied: boolean): void => {
      if (onReport === undefined || statsBefore === undefined) return
      onReport({
        creature,
        room,
        targetId: target.characterId,
        incoming,
        counters,
        monsterDied,
        playerDeaths,
        statsBefore,
      })
    }

    // 이번 틱의 ResolveContext를 조립한다 — deps만 바인딩하고 death seam은 커링하지 않는다(사전
    // 바인딩 금지, resolveAttack.ts:37). resolveAttack이 ctx를 read-only로 취급하므로(유일 변형은
    // 공유 참조 ledger 누적) 틱당 1개 인스턴스를 근접·반격에서 공유한다.
    // 원장 라우팅은 조기 반환 뒤에서 한다 — 행동하지 않는 몬스터에 빈 원장 캐시를 만들지 않는다.
    const ctx: ResolveContext = {
      rng: deps.rng,
      room,
      now,
      fireCreatureDeath: deps.fireCreatureDeath,
      firePlayerDeath,
      ledger: deps.ledgers.for(creature.instanceId),
    }

    // MMAGIC 주문 분기 — 시전 성공('cast')이면 그 라운드 근접만 스킵한다(update.c:348).
    // MCHARM 단순화: 오라클 p는 is_charm_crt(name, target) && MCHARM(시전자 특정)이고 시전 확률 굴림
    // 뒤에 !p로 억제하나(굴림 소비), 여기서는 MCHARM을 blanket no-cast로 근사한다(굴림 미소비, charmer
    // 특정·charm 전반은 A2/A7 범위 밖). 시전 치사(D7)를 제외하면 반격은 주문과 무관하게 유지한다.
    let castIncoming: IncomingAction | null = null
    if (F_ISSET(creature.flags, MMAGIC) && !F_ISSET(creature.flags, MCHARM)) {
      if (deps.rng(1, 100) <= MONSTER_SPELL_CAST_CHANCE) {
        const hpBeforeCast = target.hpCurrent
        if (castSpell(creature, target, ctx) === 'cast') {
          castIncoming = { kind: 'cast', damage: hpBeforeCast - target.hpCurrent }
        }
      }
    }

    // 시전 치사(D7) — 시전 안에서 표적 사망 seam이 실행됐으면 근접·반격 없이 보고하고 라운드를 끝낸다.
    if (castIncoming !== null && playerDeaths.includes(target.characterId)) {
      report(castIncoming, false)
      return
    }

    // 몬스터 근접(target melee) — fire-free. target이 HP<1로 떨어져도 즉시 발생시키지 않고 pending으로
    // 남긴다(end-of-round 지연). action.pendingTargetDeath가 "이번 라운드 끝에 target이 죽는가"의 신호다 —
    // 일반 target은 근접 died, 사망 취소 상태 target(D8, 라운드 시작 HP<1)은 rollHit 명중이다.
    // 시전 치사는 위 D7 분기에서 이미 끝났으므로 여기 오는 'cast'는 비치사 시전뿐이고, 그때 근접이
    // 없어 end-of-round 사망도 없다.
    const deathCancelled = aliveAtStart.get(target) !== true // 라운드 시작(시전 전) HP<1
    const action = targetAction(castIncoming, creature, target, ctx, deathCancelled)

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

      counters.push({
        characterId: player.characterId,
        outcome: resolveAttack(toCombatant(player), toCombatant(creature), ctx),
      })
      // 쿨다운 재설정 — 반격 대상이 몬스터라 PvP +3 미적용(command5.c:131/135).
      player.nextAttackAt =
        now + (F_ISSET(player.flags, PBLIND) ? ATTACK_COOLDOWN_BLIND : ATTACK_COOLDOWN_INTERVAL)

      // 몬스터가 이 counter에 사망 → death 1회 발생(fire-free 이양) + target pending death 취소 후 중단.
      // 오라클 goto crt_died; if(rtn){ continue }로 target 사망 체크를 스킵 → "막타치면 target 생존".
      if (creature.hpcur < 1) {
        fireDeath(toCombatant(creature), ctx)
        monsterDied = true
        break
      }
    }

    // end-of-round target 사망 판정(update.c:522 att_ptr->hpcur<1 → die) — 몬스터가 counter에 죽지
    // 않았고(취소 안 됨) target이 이번 라운드 근접으로 죽었을 때만 1회 발생시킨다(D8 명중 포함).
    if (!monsterDied && action.pendingTargetDeath) {
      fireDeath(toCombatant(target), ctx)
    }

    // 모든 상태 변경(end-of-round 사망 실행 포함) 뒤 보고 1회.
    report(action.incoming, monsterDied)
  }
}
