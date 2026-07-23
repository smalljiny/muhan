import type { CreatureInstance, ItemInstance, RoomNode } from 'shared'
import type { DamageLedger } from './enmity.js'
import { F_ISSET, MTRADE } from '../world/hexFlags.js'

/**
 * deathDistribution.ts — 몬스터 사망 exp 분배·전리품 드롭 resolver(creature.c:274~341 MONSTER 분기 이식).
 *
 * 순수·반환 기반·무변형. 데미지비례 exp 분배·멤버십 게이트·그룹킬 보너스·전리품/골드 드롭을 계산해
 * `{ awards, drops }`로 **반환만** 한다 — dead·room·ledger·inventory를 변형하지 않는다. exp/alignment
 * 실 누적·클램프·drops의 room.items push·라이브 조립은 #99 소관이다(applyPlayerDeath·resolvePlayerDot의
 * 반환/불변 선례).
 *
 * ── 오라클 분배 루프(B 블록, creature.c:287~311) ─────────────────────────────
 * 기여자(적 리스트 멤버 && 데미지>0)마다:
 *   expdiv   = crt->experience * ep->damage / MAX(hpmax, 1)     (정수 절삭)
 *   expgroup = 그룹킬 ? expdiv + experience/10 : expdiv         (정수 절삭)
 *   expgroup = MIN(expgroup, experience)                        (몬스터 exp 캡)
 *   ply->experience += expgroup
 *   ply->alignment  -= crt->alignment/5                         (★ 루프 내부 — 기여자마다)
 *
 * ## 이식 결정
 *  1. exp/align 폴백: experience/alignment는 CreatureInstance 선택 필드(Story 6) → `?? 0`.
 *  2. 그룹킬 = 기여자 2명+(결정론). 오라클 `cp`는 die_crt 선언(creature.c:267) 후 `if(cp)`(:292)
 *     사용 전 미할당인 **미초기화 포인터 버그**다 — 재현하지 않고 `contributors.length >= 2`로 대체,
 *     각 기여자에 loop-invariant로 동일 적용한다.
 *  3. contributor 정의: `enemies` 멤버 AND `ledger.get(id) > 0`. 이 집합이 awards와 groupkill 카운트를
 *     둘 다 구동한다. 순서는 **enemies 배열 순서**(오라클 first_enm 순회 충실 — ledger Map 순서 아님).
 *  4. ★ 이중 divergence: (a) alignment 페널티를 **기여자마다** 적용한다(오라클 루프 내부). 플랜 T7.2
 *     "살해자"는 오라클과 충돌하므로 오라클(behavioral truth, CLAUDE.md 포팅 원칙)로 이식한다.
 *     (b) **기여자 축 divergence(오라클 대비 축소)**: 오라클 루프 게이트는 `find_who(ep->enemy)`
 *     (플레이어 present/해소 여부, 데미지 무관)라, present인 0-데미지 적(빗나간 오프너가 resolveAttack
 *     전 registerEnemy로 등록한 경우 등)도 exp(절삭 0)·alignment 페널티·groupkill 카운트를 받는다.
 *     이 포트는 기여자를 `damage > 0`으로 좁혀(#3) 그런 적을 셋 다에서 제외한다 — awards·groupkill·
 *     alignment가 present 축이 아닌 damage 축으로 게이팅된다. 여기서 "exp 0 기여자"는 damage>0이나
 *     절삭 0인 경우만 가리키며, 진짜 0-데미지 present 적은 제외된다. 라이브 조립(#99)이 기여자 축을
 *     present 기준으로 재검토할지 결정한다(이 resolver는 반환만). alignment 클램프 ±1000도 #99 소유
 *     (delta만 반환, 무클램프).
 *  5. levels 루프 미이식: 오라클 A 블록(creature.c:278~285, `levels`·첫 `expdiv=exp/levels`)은
 *     B 블록이 덮어쓰는 사장 코드 → 이식하지 않는다.
 *  6. MTRADE 게이트는 인벤토리만, 골드는 무게이트: MTRADE면 인벤토리 드롭 없음(creature.c:311). 골드
 *     블록(creature.c:325)은 루프 밖·무게이트라 MTRADE와 무관하게 항상 드롭한다.
 *  7. 골드 ItemInstance: id=`${dead.instanceId}:gold`(결정적 파생 — rng·카운터 없음), name=`${gold}냥`
 *     (오라클 "%d냥"), value=gold, description=''·flags=''·contains=[].
 *  8. 인벤토리 드롭: dead.inventory의 각 ItemInstance를 기존 instanceId 유지한 채 담는다(MTRADE면 제외).
 *
 * ## 유예(Non-goal)
 *  - MPERMT 리스폰·MSUMMO 소환은 world/creatureDeath.ts onCreatureDeath 소관(중복 구현 금지).
 *  - exp/alignment 실 누적·±1000 클램프·drops의 room.items push·라이브 조립은 #99.
 */

/** 개별 기여자 exp/alignment 보상(누적 미적용 — delta만). */
export interface DeathAward {
  /** 기여자 식별자(enemies 멤버 = characterId/instanceId seam). */
  readonly playerId: string
  /** 획득 경험치(MIN(expgroup, 몬스터 exp) 캡 적용). */
  readonly exp: number
  /** 정렬 변동 delta(-trunc(dead.alignment/5)). 누적·클램프는 #99. */
  readonly alignmentDelta: number
}

/** distributeCreatureDeath 반환 — 기여자 보상·방 바닥 드롭. 어느 것도 변형 아님(반환 기반). */
export interface DeathDistribution {
  /** 기여자별 exp/alignment 보상(enemies 순서). */
  readonly awards: DeathAward[]
  /** 방 바닥에 떨어질 아이템(인벤토리 + 골드). room.items push는 #99. */
  readonly drops: ItemInstance[]
}

/**
 * 사망 분배 의존성. 골드 id는 `dead.instanceId` 파생이라 상태·rng가 불필요하다 — 시그니처 슬롯만
 * 유지하고 내부는 빈 인터페이스다(플랜 명시).
 */
export type DeathDistributionDeps = Record<string, never>

/** 골드 전리품 ItemInstance를 만든다(결정적 — id는 dead.instanceId 파생, rng·카운터 없음). */
function makeGoldDrop(dead: CreatureInstance): ItemInstance {
  return {
    instanceId: `${dead.instanceId}:gold`,
    name: `${dead.gold}냥`, // 오라클 "%d냥"(creature.c:326).
    description: '',
    value: dead.gold,
    flags: '',
    contains: [],
  }
}

/**
 * 몬스터 사망 시 exp 분배·전리품 드롭을 계산해 반환한다(무변형). ledger는 명시 파라미터로 수령하며
 * fireCreatureDeath 시그니처는 무변경이다(Q2 — 라이브 조립 #99 유예).
 *
 * room은 파라미터로 유지하되 읽지도 변형하지도 않는다(#99 조립·MPERMT 컨텍스트용 시그니처 슬롯).
 * deps도 현재 미사용(골드 id가 결정적 파생이라 상태 불필요) — 플랜 명시 슬롯이다.
 */
export function distributeCreatureDeath(
  dead: CreatureInstance,
  _room: RoomNode,
  ledger: DamageLedger,
  _deps: DeathDistributionDeps,
): DeathDistribution {
  const exp = dead.experience ?? 0 // Story 6 선택 필드 폴백.
  const alignment = dead.alignment ?? 0
  const hpmax = Math.max(dead.hpmax, 1) // 오라클 MAX(hpmax, 1) 0분모 가드.
  // ★ 기여자마다(오라클 루프 내부). 무클램프(#99). `0 - x`로 음수 0(-0) 산출을 피한다(toEqual가 -0≠0 구분).
  const alignmentDelta = 0 - Math.trunc(alignment / 5)

  // 기여자 집합: enemies 멤버 AND ledger 데미지>0. enemies 배열 순서 유지(오라클 first_enm 충실).
  const contributors = dead.enemies.filter((id) => (ledger.get(id) ?? 0) > 0)
  const groupKill = contributors.length >= 2 // cp 미초기화 버그 비재현 — 결정적 게이트.

  const awards: DeathAward[] = contributors.map((playerId) => {
    const dmg = ledger.get(playerId) ?? 0 // 위 filter가 >0 보장.
    const expdiv = Math.trunc((exp * dmg) / hpmax)
    const rawGroup = groupKill ? expdiv + Math.trunc(exp / 10) : expdiv
    const expgroup = Math.min(rawGroup, exp) // 몬스터 exp 캡.
    return { playerId, exp: expgroup, alignmentDelta }
  })

  // 드롭은 기여자와 독립(오라클 드롭 루프는 enmity 루프 밖). 인벤토리는 MTRADE 게이트, 골드는 무게이트.
  const drops: ItemInstance[] = []
  if (!F_ISSET(dead.flags, MTRADE)) {
    for (const item of dead.inventory) drops.push(item) // instanceId 유지, 참조 보존.
  }
  if (dead.gold > 0) drops.push(makeGoldDrop(dead)) // 골드는 MTRADE 무관 항상 드롭.

  return { awards, drops }
}
