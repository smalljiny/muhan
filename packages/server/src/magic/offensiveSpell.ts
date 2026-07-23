import { REALM, OSPELL_GRID, type OspellEntry } from 'shared'
import { dice } from '../combat/dice.js'
import { accumulateDamage } from '../combat/enmity.js'
import { combatantHp, applyCombatantDamage, type Combatant } from '../combat/combatant.js'
import { fireDeath } from '../combat/resolveAttack.js'
import { hasFlag } from '../world/door.js'
import { F_ISSET, MRMAGI } from '../world/hexFlags.js'
import type { Caster } from './caster.js'
import type { CastContext } from './castContext.js'
import type { SpellDispatch } from './dispatch.js'
import { mprofic } from './mprofic.js'

/**
 * offensiveSpell — 공격 주문 20종의 데미지 산술·방상성·마법저항·사망 발화 이식(magic1.c:820-1236, offensive_spell).
 *
 * ## 범위 경계 (데미지 전용 — 게이트 분리)
 * 오라클 offensive_spell은 마나 소비(`mpcur -= osp->mp`)·spell_fail 굴림·knowledge 게이트를 함수 안에
 * 인터리브하지만, 이 포트는 마나·클래스·knowledge 게이트를 S4 시전 게이트(gate.ts)로 분리했다 —
 * offensiveSpell은 게이트 통과 **이후**의 데미지 산술만 담당한다(마나를 여기서 다시 소비하지 않는다).
 * 시전 진입 경로(S6 crtSpell)가 `applyCastGate`로 게이트를 먼저 통과시킨 뒤 이 함수를 호출한다.
 *
 * ## spell_fail 미배선(#84 defer)
 * 오라클은 offensive_spell 안에서 `spell_fail(ply_ptr)`를 굴리지만(magic1.c:1089, 마나 소비 後·데미지 前),
 * 이 포트의 시전 경로(crtSpell→applyCastGate→offensiveSpell)는 spell_fail을 **굴리지 않는다**. spell_fail은
 * S4가 standalone 모듈(`spellFail.ts`)로 fixture-lock했고(gate.ts에는 없다), 호출 조건 predicate(`rollsSpellFail`,
 * 전사계 한정)도 거기 있다. #84 라이브 몬스터 시전(주로 class 0/default·MAGE·CLERIC — spell_fail default=무실패)은
 * fizzle이 관측되지 않으나, 전사계 MMAGIC 몬스터의 fizzle-after-consume은 미재현이다 — 실 배선(offensive
 * 시전 진입에 rollsSpellFail 굴림 삽입)은 후속 토픽 소관.
 *
 * ## tier-5 도술사 전용 제약 (S6 crtSpell이 게이트로 배선)
 * 오라클은 tier-5 공격 주문 4종(SICEBL=14·STHUND=38·SEQUAK=39·SFLFIL=40)을 함수 중간에서
 * `if(class != MAGE && class < INVINCIBLE) return(0)`로 차단한다(magic1.c:900·1085, "도술사만이 쓸 수 있는 마법").
 * 이 per-spell 클래스 제약은 게이트 성격이라 offensiveSpell(데미지 전용)이 아닌 시전 진입 게이트 소관이다 —
 * S6 crtSpell이 tier-5 pick에 `requiredClasses=[MAGE]`를 실어 `applyCastGate`로 차단한다(비-MAGE·비-INVINCIBLE
 * 몬스터 88종이 tier-5를 알아 라이브 도달, 오라클 `return 0`↔'none' 재현). offensiveSpell은 여기서 재판정하지 않는다.
 *
 * ## PINVIS 해제 미이식(defer)
 * 오라클은 시전 시 caster PINVIS(은둔)를 해제하지만(magic1.c:845), #84 caster는 몬스터(S6)이고 flags가
 * immutable hex라 cosmetic no-op다 — 무기 낙하 플래그 defer와 동류로 이식하지 않는다(#85 소관).
 *
 * ## in-place carve-out
 * target hp 차감·ledger 누적·death 발화는 순수-함수 원칙의 승인된 combat carve-out이다(resolveAttack 선례).
 * hp는 Combatant 스냅샷(target.hpCurrent)이 아니라 **원본 참조**(instance.hpcur/state.hpCurrent)로 읽고 쓴다 —
 * 스냅샷은 adapt 시점 뷰라 차감이 desync되기 때문이다.
 */

// ── 방 상성 플래그 비트(room.flags number[], hasFlag) — world/roomFlags.ts 정본 ─
// 중복 정의 제거: realm 4종은 world/roomFlags.ts가 소유한다. 여기서는 import 후 배럴 호환을
// 위해 그대로 재노출한다(magic/index.ts가 이 심볼들을 re-export).
export { REARTH, RWINDR, RFIRER, RWATER } from '../world/roomFlags.js'
import { REARTH, RWINDR, RFIRER, RWATER } from '../world/roomFlags.js'

/** bonusType → mprofic 나눗수 K(magic1.c:853-865). 1→10, 2→6, 3→4. */
const BNS_DIVISOR: Record<number, number> = { 1: 10, 2: 6, 3: 4 }

/** 데미지 적용 결과 — 적용 피해(저항 後)와 사망 여부. no-op(이미 사망)은 dmg=0·died=false. */
export interface SpellDamageOutcome {
  readonly dmg: number
  readonly died: boolean
}

/** offensiveSpell 요청 — caster(bns 입력)·casterId(ledger 키)·target(Combatant)·ctx. */
export interface OffensiveSpellRequest {
  readonly caster: Caster
  readonly casterId: string
  readonly target: Combatant
  readonly ctx: CastContext
}

/** 디스패치 핸들러 형태 — 등록 시 osp를 캡처하고 요청만 받는다. */
export type OffensiveSpellHandler = (req: OffensiveSpellRequest) => SpellDamageOutcome

/**
 * 방 상성 보정 — osp.realm과 방 realm 플래그를 대조해 bns를 강화(×2)·약화(min(-bns,-5))한다.
 * else-if 체인(한 방에 한 realm 플래그, magic1.c:867-895). 상극: 물↔불, 바람↔땅.
 */
function applyRoomAffinity(bns: number, realm: number, roomFlags: number[]): number {
  if (hasFlag(roomFlags, RWATER)) {
    if (realm === REALM.WATER) return bns * 2
    if (realm === REALM.FIRE) return Math.min(-bns, -5)
  } else if (hasFlag(roomFlags, RFIRER)) {
    if (realm === REALM.FIRE) return bns * 2
    if (realm === REALM.WATER) return Math.min(-bns, -5)
  } else if (hasFlag(roomFlags, RWINDR)) {
    if (realm === REALM.WIND) return bns * 2
    if (realm === REALM.EARTH) return Math.min(-bns, -5)
  } else if (hasFlag(roomFlags, REARTH)) {
    if (realm === REALM.EARTH) return bns * 2
    if (realm === REALM.WIND) return Math.min(-bns, -5)
  }
  return bns
}

/**
 * bns 계산 — `intBonus + trunc(mprofic(class, realm, osp.realm) / K)` 뒤 방 상성 보정(T5.2·T5.3).
 *
 * ## gated 한정 (오라클 divergence 명시)
 * 오라클은 bns 산술만 `if(how==CAST)`로 게이팅하고 방 상성 블록은 게이트 **밖**이라 아이템 경로에도
 * 상성 약화(-5)를 적용한다(magic1.c:867). 이 포트는 상성까지 gated로 접는다 — gated=false는 #86
 * 아이템-delivery seam이고 #84엔 아이템 caster가 없어 그 -5 edge는 관측 불가하다(caster.ts realm=[0,0,0,0]
 * seam과 동류의 유예). 아이템-경로 상성은 #86이 실 delivery와 함께 정밀화한다.
 */
export function computeBns(caster: Caster, osp: OspellEntry, ctx: CastContext): number {
  // gated=false(아이템 경로): mprofic·상성 없이 bns=0.
  if (!ctx.gated) return 0

  const k = BNS_DIVISOR[osp.bonusType] ?? 1
  const bns = caster.intBonus + Math.trunc(mprofic(caster.class, caster.realm, osp.realm) / k)
  return applyRoomAffinity(bns, osp.realm, ctx.room.flags)
}

/**
 * applySpellDamage — 데미지 순서를 정확히 이 순서로 적용한다(T5.5, magic1.c:1096-1170):
 *   1. dmg = max(1, dice(ndice, sdice, pdice+bns))         — max(1)은 저항 前
 *   2. 저항 감산(creature 대상 + MRMAGI만) — dmg 0까지, 재-clamp 금지(0 데미지 보존)
 *   3. hpBefore 판독; hp<1이면 no-op(재진입 death 재발화 방지, resolveAttack DEAD_DEFENDER_NOOP 선례)
 *   4. m = min(hpBefore, dmg)                              — 오버킬 캡(저항 後·차감 前)
 *   5. ledger 누적 accumulateDamage(casterId, m)           — creature 대상만(magic1.c:1131)
 *   6. hp -= dmg (원본 ref in-place)
 *   7. hp<1이면 death seam 정확히 1회(auto-hit — 다중공격·hit 굴림 없음, #82 seam 재사용)
 */
function applySpellDamage(
  casterId: string,
  target: Combatant,
  osp: OspellEntry,
  bns: number,
  ctx: CastContext,
): SpellDamageOutcome {
  // 1. dmg 굴림 + max(1) 저항 前 clamp.
  let dmg = Math.max(1, dice(osp.ndice, osp.sdice, osp.pdice + bns, ctx.rng))

  // 2. 마법저항 — creature 대상 + MRMAGI만. player 대상은 piety store가 없어 미발동(#85 소관, dead branch 회피).
  if (target.kind === 'creature' && F_ISSET(target.instance.flags, MRMAGI)) {
    const inst = target.instance
    // dmg -= trunc(dmg*2*min(50, piety+int)/100). piety+int>=50이면 완전 무효(dmg 0). 재-clamp 금지.
    dmg -= Math.trunc((dmg * 2 * Math.min(50, inst.piety + inst.intelligence)) / 100)
  }

  // 3. no-op 가드 — 이미 사망(hp<1)한 대상엔 차감·death·ledger 없이 반환.
  const hpBefore = combatantHp(target)
  if (hpBefore < 1) return { dmg: 0, died: false }

  // 4. 오버킬 캡(저항 後, 차감 前).
  const m = Math.min(hpBefore, dmg)

  // 5. ledger 누적 — creature 대상만.
  if (target.kind === 'creature') accumulateDamage(ctx.ledger, casterId, m)

  // 6. hp 차감(원본 ref).
  applyCombatantDamage(target, dmg)

  // 7. 사망 발화 — 정확히 1회(auto-hit, 근접과 공유하는 #82 death seam). CastContext는 ResolveContext 확장.
  const died = hpBefore - dmg < 1
  if (died) fireDeath(target, ctx)

  return { dmg, died }
}

/**
 * offensiveSpell — bns 계산 → 데미지 적용. 공격 주문 20종 공통 effect(osp가 tier·realm·주사위를 담는다).
 * casterId는 caster가 creature면 instanceId, player면 characterId(ledger 키). realm 성장(addrealm)은 #85 소관 미이식.
 */
export function offensiveSpell(req: OffensiveSpellRequest, osp: OspellEntry): SpellDamageOutcome {
  const bns = computeBns(req.caster, osp, req.ctx)
  return applySpellDamage(req.casterId, req.target, osp, bns, req.ctx)
}

/**
 * S3 디스패치에 공격 주문 20종을 등록한다. OSPELL_GRID(20 엔트리 단일 출처)를 순회해 각 spellNo에
 * 해당 osp를 캡처한 offensiveSpell 핸들러를 배선한다. dispatch.register가 비-offensive·카탈로그 밖을
 * 거부하므로 격자 20종만 안착한다.
 */
export function registerOffensiveSpells(dispatch: SpellDispatch<OffensiveSpellHandler>): void {
  for (const osp of OSPELL_GRID) {
    dispatch.register(osp.spellNo, (req) => offensiveSpell(req, osp))
  }
}
