import { bonusOf, resolveHpMax, type Character, type RoomNode } from 'shared'
import type { CombatRng } from './dice.js'
import { hasFlag } from '../world/door.js'
import { isPoisonActive, isDiseaseActive } from './statusEffects.js'
import {
  RPHARM,
  RPPOIS,
  RPMPDR,
  RPBEFU,
  REARTH,
  RWINDR,
  RFIRER,
  RWATER,
} from '../world/roomFlags.js'

/**
 * dot.ts — 플레이어 DoT resolver(player.c:578~730 damage-only 이식). 독·질병·위험방 DoT·mp
 * 드레인·만료·사망판정을 순수 함수로 계산하고, progression 재생과의 xor 상호배제 계약을
 * `dotApplied` 반환으로 확정한다.
 *
 * ## damage-only 범위(#99 유예 명시)
 * 오라클의 healing 분기(Branch A: 비-harm·비-ill 재생)와 각 tail의 `else if(!ill)` mp/hp 재생은
 * 미이식이다 — 재생은 progression 소관이고 xor는 health-pulse 조립부가 접합한다(#99). 아래도 유예:
 *   - realm 저항 게이트(PRFIRE/PBRWAT/PSSHLD/PRCOLD): 플레이어 combat-flag substrate이고 Character에
 *     없다. realm/무형 피해는 저항 게이트 없이 적용하고, 게이팅은 #99(PlayerCombatState 배선)로 유예.
 *   - RPBEFU·모든 LT_ATTCK 쿨다운(질병 dice(1,6,3) interval 포함): combat-state 소관. 질병은 hp 차감만 이식.
 *   - status until/interval 영속화(RPPOIS의 F_SET 지속): #99 유예. RPPOIS는 이번 틱 독 피해로만 취급한다.
 *   - 외부 타이머 게이트 `if(parent_rom && t>LT_HEALS)`: 미이식. 이 resolver는 호출 시마다 DoT를
 *     적용하고 cadence(호출 주기)는 health-pulse 호출자가 소유한다(#99).
 *
 * ## Branch 구조(player.c dangling-else 체인, C ⟺ RPHARM)
 *   - !RPHARM && !ill → Branch A(재생) : 미이식 no-op.
 *   - !RPHARM && ill  → Branch B(비-harm DoT).
 *   - RPHARM          → Branch C(위험방). realm·무형 피해는 이 분기 내부에만 존재한다.
 * (오라클 Branch A의 `!PPOISN` 조건은 ill=PPOISN||PDISEA에 이미 포함돼 redundant → C는 RPHARM 단독 게이트.)
 *
 * ## 독 공식 단일화(T5.1 — 의도된 divergence)
 * 오라클 harm-room 변형 `mrand(1,4)`를 축약해, 독 피해는 어느 분기든 `MAX(1, rng(1,trunc(hpmax/5)) - con)`
 * 단일 공식을 쓴다(이식 누락 아님). 질병은 `MAX(1, rng(1,6) - con)`.
 *
 * ## immutability
 * 입력 Character를 변형하지 않고 새 Character를 반환한다(applyPlayerDeath 선례). hpCurrent는 스키마
 * min(0) 정합을 위해 max(0)로 클램프하고, died는 클램프 전 raw hp<1(오라클 die 조건)로 판정한다.
 */

/** DoT resolver 컨텍스트 — 결정적 테스트를 위해 rng·now를 주입한다(Math.random/Date.now 금지). */
export interface PlayerDotContext {
  /** 피해 주사위 seam. 독은 rng(1,trunc(hpmax/5)), 질병은 rng(1,6)로 호출한다. */
  readonly rng: CombatRng
  /** 현재 절대 틱 — 독·질병 활성 판정(isPoisonActive/isDiseaseActive)에 쓴다. */
  readonly now: number
}

/** DoT resolver 반환 — 새 Character·사망 여부·xor 계약 입력(이번 틱 DoT 차감 발생 여부). */
export interface PlayerDotResult {
  /** DoT를 반영한 새 Character(입력 불변). hpCurrent는 0으로 클램프된다. */
  readonly character: Character
  /** raw hp<1이면 true. 사망 seam 발화는 미배선(반환만, #99). */
  readonly died: boolean
  /** 이번 틱에 hp/mp를 1건이라도 차감했으면 true. health-pulse가 재생을 skip하는 xor 계약 입력. */
  readonly dotApplied: boolean
}

/**
 * 플레이어 DoT를 계산한 결과를 반환한다(damage-only). 독·질병·위험방 hp DoT와 RPMPDR mp 드레인을
 * 오라클 공식으로 누적하고, died·dotApplied를 함께 반환한다. 입력 Character는 변형하지 않는다.
 */
export function resolvePlayerDot(
  character: Character,
  room: RoomNode,
  ctx: PlayerDotContext,
): PlayerDotResult {
  const { rng, now } = ctx
  const con = bonusOf(character.stats[2]) // stats[2]=체력(constitution) 보너스.
  const flags = room.flags

  const poisonActive = isPoisonActive(character, now)
  const diseaseActive = isDiseaseActive(character, now)
  const ill = poisonActive || diseaseActive
  const harm = hasFlag(flags, RPHARM)

  let hp = character.hpCurrent
  let mp = character.mpCurrent
  let dotApplied = false

  // 독 피해(단일 공식). Branch B는 활성 독, Branch C(harm)는 RPPOIS source도 이번 틱 독으로 취급.
  const poisonThisTick = harm ? poisonActive || hasFlag(flags, RPPOIS) : poisonActive
  const branchActive = harm || ill // A(비-harm·비-ill 재생)는 미이식이라 스킵.

  if (branchActive) {
    if (poisonThisTick) {
      const poisonMax = Math.trunc(resolveHpMax(character) / 5)
      hp -= Math.max(1, rng(1, poisonMax) - con)
      dotApplied = true
    }
    if (diseaseActive) {
      hp -= Math.max(1, rng(1, 6) - con) // 질병 dice(1,6,3) interval 쿨다운은 #99 유예.
      dotApplied = true
    }
  }

  if (harm) {
    // RPMPDR mp 드레인. 오라클의 `else if(!ill)` mp 재생은 미이식(#99). 실차감(>0)만 dotApplied 계상 —
    // 단, #99의 xor는 "RPMPDR 세팅 여부"로 재생 skip을 판정해야 할 수 있다(오라클은 drain=0이어도
    // 재생 else 분기를 막는다). 이 seam은 #99가 배선한다.
    if (hasFlag(flags, RPMPDR)) {
      const drain = Math.min(mp, 3)
      mp -= drain
      if (drain > 0) dotApplied = true
    }

    // realm/무형 생명력 흡수(8-MIN(con,2)) — Branch C 내부에만 존재. 저항 플래그는 전부 미보유로 간주
    // (게이팅 #99 유예)하므로, realm 플래그가 있으면 무저항 피해가 항상 발동한다.
    const anyRealm =
      hasFlag(flags, RFIRER) ||
      hasFlag(flags, RWATER) ||
      hasFlag(flags, REARTH) ||
      hasFlag(flags, RWINDR)
    // 무형 흡수는 realm·RPPOIS·RPBEFU·RPMPDR이 전부 없는 순수 RPHARM 방에서만 발동(오라클 else-if 말단).
    const bareHarm =
      !anyRealm &&
      !hasFlag(flags, RPPOIS) &&
      !hasFlag(flags, RPBEFU) &&
      !hasFlag(flags, RPMPDR)
    if (anyRealm || bareHarm) {
      hp -= 8 - Math.min(con, 2)
      dotApplied = true
    }
  }

  const died = hp < 1 // 오라클 die 조건(hpcur<1). 발화는 미배선(#99).
  const character2: Character = {
    ...character,
    hpCurrent: Math.max(0, hp), // 스키마 min(0) 정합. died는 클램프 전 raw로 이미 판정.
    mpCurrent: mp,
  }
  return { character: character2, died, dotApplied }
}
