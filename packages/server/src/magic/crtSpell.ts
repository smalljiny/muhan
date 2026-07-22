import { ospellOf, type CreatureInstance } from 'shared'
import type { CombatRng } from '../combat/dice.js'
import type { ResolveContext } from '../combat/resolveAttack.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import type { SpellCastResult } from '../combat/combatTick.js'
import { toCombatant } from '../combat/combatant.js'
import { MAGE } from '../combat/constants.js'
import { F_ISSET } from '../world/hexFlags.js'
import { toCaster } from './caster.js'
import { applyCastGate } from './gate.js'
import { SpellDispatch } from './dispatch.js'
import { registerOffensiveSpells, type OffensiveSpellHandler } from './offensiveSpell.js'
import type { CastContext } from './castContext.js'

/**
 * crtSpell — MMAGIC 몬스터의 시전 seam(update.c:654-701 crt_spell). CastSpellSeam 시그니처
 * `(caster, target, ctx) => 'cast'|'none'`를 **직접** 만족해 createCombatTick의 castSpell 의존에
 * 그대로 주입된다. 반환값의 의미는 오라클 라운드 재현이다:
 *   - 'cast' = 이번 라운드 근접을 주문이 대체한다(combatTick doMelee=false, update.c:348 return 1).
 *   - 'none' = 주문이 발동하지 않아 근접이 진행된다(return 0).
 *
 * ## 게이트가 곧 라운드 분기 (magic1.c:820-841 offensive_spell CAST 게이트)
 * 오라클 offensive_spell은 how==CAST일 때 함수 진입부에서 mana(`mpcur<mp`)·knowledge(`!S_ISSET`)를
 * 검사해 실패 시 return(0)한다. 이 포트는 그 게이트를 S4 applyCastGate(mana→class→knowledge)로 분리
 * 배선하고, 통과(마나 소비 발생) 시에만 S5 offensiveSpell(데미지 전용)을 호출한다. 게이트 실패는 곧
 * 'none'(근접 진행)이라 mana·class·knowledge 어느 게이트가 막든 오라클 return(0)과 동일하게 접힌다.
 *
 * ## 한 pick 규칙 (재추첨 금지, update.c:672-680)
 * 아는 주문에서 **한 번만** 선택한다. 선택된 주문이 비-offensive여도 재추첨하지 않는다 — 오라클은
 * 한 pick → cast 또는 return(0)이다. selectSpell을 순수 헬퍼로 분리해 이 규칙을 단일 지점에 고정한다.
 *
 * ## 비-offensive 폴백 (#85 유예 경계)
 * offensive 20종만 S5 본체가 있고 비-offensive 36종(치유 포함)은 #85가 채운다. 비-offensive 선택 시
 * 게이트 진입 없이 'none'(근접 진행)으로 접는다 — #84엔 self-target 치유 본체가 없어 실제 시전되지
 * 않는다(forward-compat 구조만 isSelfTargetSpell로 남긴다).
 */

// ── 주문번호 상수(mtype.h:233-289) ──────────────────────────────────────────
/** 회복(healing, self) — 비-offensive. */
const SVIGOR = 0
/** 삭풍(offensive tier1 WIND) — 빈 spells 폴백 기본값(update.c:673). */
const SHURTS = 1
/** 동설주(offensive tier5 WATER) — MAGE 전용. */
const SICEBL = 14
/** 원기회복(healing, self) — 비-offensive. */
const SMENDW = 18
/** 완치(healing, self) — 비-offensive. */
const SFHEAL = 19
/** 파천풍(offensive tier5 WIND) — MAGE 전용. */
const STHUND = 38
/** 지옥패(offensive tier5 EARTH) — MAGE 전용. */
const SEQUAK = 39
/** 태양안(offensive tier5 FIRE) — MAGE 전용. */
const SFLFIL = 40

/** spells 비트셋 폭 — 16바이트 = 128비트(update.c:663 for i<16, j<i*8+8). */
const SPELLS_BIT_WIDTH = 128
/** 아는 주문 후보 상한 — 오라클 known[10](update.c:661). */
const KNOWN_CAP = 10

/**
 * MAGE 전용 tier5 공격주문 4종(SICEBL·STHUND·SEQUAK·SFLFIL). 오라클 offensive_spell은 이 4종을
 * `if(class != MAGE && class < INVINCIBLE) return(0)`로 차단한다(magic1.c:900·1085, "도술사만이 쓸 수
 * 있는 마법"). A6 §3 · 검증: 88개 비-MAGE·비-INVINCIBLE 몬스터(구리 용 class0·황금 용 class2·사악한
 * 여사제 class3 등)가 이 tier5 주문을 오탑재하므로, 게이트로 라우팅해 근접 진행으로 접어야 한다.
 */
const TIER5_MAGE_ONLY: ReadonlySet<number> = new Set([SICEBL, STHUND, SEQUAK, SFLFIL])

/** tier5 게이트에 넘길 requiredClasses — 모듈 상수로 hoist(per-call 배열 할당 회피, cast hot path). */
const MAGE_ONLY: readonly number[] = [MAGE]

/** self 대상 치유 3종(update.c:681-684, cmnd.num==2). 전부 비-offensive라 #84 offensive 경로엔 미도달. */
const SELF_TARGET_SPELLS: ReadonlySet<number> = new Set([SVIGOR, SMENDW, SFHEAL])

/**
 * 공격주문 디스패치 — OSPELL_GRID 20종을 모듈 로드 시 1회 등록한다(정적 격자, per-round hot path는
 * O(1) 조회). spellNo → offensiveSpell 핸들러 해소로 dispatch seam(S3)을 실사용 검증한다.
 */
const offensiveDispatch = new SpellDispatch<OffensiveSpellHandler>()
registerOffensiveSpells(offensiveDispatch)

/**
 * tier5 MAGE 전용 여부를 requiredClasses로 매핑한다. tier5 4종이면 [MAGE](비-MAGE·비-INVINCIBLE 차단),
 * 아니면 undefined(클래스 무제한). 게이트는 이 값으로 오라클 per-spell 클래스 제약을 재현한다.
 */
function mageOnly(spellNo: number): readonly number[] | undefined {
  return TIER5_MAGE_ONLY.has(spellNo) ? MAGE_ONLY : undefined
}

/**
 * 아는 주문을 비트 순서로 최대 10개 수집해 한 번만 선택한다(update.c:663-680). 순수 함수 —
 * 부수효과·게이트 없이 spellNo만 반환한다.
 *   - 빈 경우(아는 주문 없음): SHURTS(1) 폴백. rng를 호출하지 않는다(재추첨·랜덤 pick 없음).
 *   - 있는 경우: rng(1, knowctr)로 랜덤 인덱스 → known[i-1].
 */
export function selectSpell(spells: string, rng: CombatRng): number {
  const known: number[] = []
  for (let bit = 0; bit < SPELLS_BIT_WIDTH && known.length < KNOWN_CAP; bit += 1) {
    if (F_ISSET(spells, bit)) known.push(bit)
  }
  // 빈 경우 SHURTS 폴백 — 오라클: knowctr==0 → spl=1. 단 몬스터가 SHURTS를 아는 게 아니라 상수라
  // knowledge 게이트가 이후 막는다(빈 spells는 항상 'none'로 접힌다).
  if (known.length === 0) return SHURTS
  return known[rng(1, known.length) - 1]!
}

/**
 * self 대상 치유 주문 여부(update.c:681-687 cmnd.num). 이 3종은 전부 비-offensive라 #84 offensive
 * 시전 경로엔 도달하지 못한다 — self-target 실제 시전은 #85 비-offensive 본체가 채운다(forward-compat).
 */
export function isSelfTargetSpell(spellNo: number): boolean {
  return SELF_TARGET_SPELLS.has(spellNo)
}

/**
 * crtSpell — MMAGIC 몬스터의 시전 seam. CastSpellSeam(`(caster, target, ctx) => 'cast'|'none'`)을
 * 직접 만족한다. 한 pick → offensive면 게이트 후 시전('cast'), 비-offensive·게이트 실패면 'none'.
 */
export function crtSpell(
  caster: CreatureInstance,
  target: PlayerCombatState,
  ctx: ResolveContext,
): SpellCastResult {
  // 1. 한 번만 선택(재추첨 없음).
  const spellNo = selectSpell(caster.spells, ctx.rng)

  // 2. offensive 판정 — ospellOf가 곧 offensive 게이트다. 카탈로그 offensive 집합 === OSPELL_GRID 집합이
  //    테스트로 고정돼(catalog.test.ts) ospellOf===undefined는 !offensive와 동치다. 비-offensive(치유 self
  //    3종 포함)는 여기서 'none'(근접 진행)으로 접힌다 — 본체는 #85 유예, self-target 시전도 #85 소관.
  const osp = ospellOf(spellNo)
  if (osp === undefined) return 'none'

  // 3. 시전 게이트 — mana → class(tier5 MAGE 전용) → knowledge. 통과 시에만 마나 소비.
  //    실패는 곧 근접 진행('none') — 오라클 offensive_spell CAST 게이트 return(0)과 동치.
  const spellCaster = toCaster(caster)
  const gate = applyCastGate(
    spellCaster,
    { manaCost: osp.mp, requiredClasses: mageOnly(spellNo), spellNo },
    true,
  )
  if (!gate.passed) return 'none'

  // 4. offensive 시전 — dispatch로 spellNo→핸들러 해소(dispatch seam 검증). CAST 경로는 gated=true.
  const handler = offensiveDispatch.resolve(spellNo)
  if (typeof handler !== 'function') return 'none' // offensive 20종은 전부 등록(방어적 가드).

  const castContext: CastContext = { ...ctx, gated: true }
  handler({
    caster: spellCaster,
    casterId: caster.instanceId,
    target: toCombatant(target),
    ctx: castContext,
  })
  // 시전 성공 → 이번 라운드 근접을 대체한다(update.c:348 return 1).
  return 'cast'
}
