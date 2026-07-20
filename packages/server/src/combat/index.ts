/**
 * combat 배럴 — dice 프리미티브·CombatRng seam·전투 튜닝 상수의 공개 표면.
 * 결정적 stub(dice.testutil.ts)은 test-only이므로 배럴에서 제외한다.
 */
export { dice, mdice } from './dice.js'
export type { CombatRng, DiceSpec } from './dice.js'
export {
  CRIT_MULTIPLIER_MIN,
  CRIT_MULTIPLIER_MAX,
  HIT_ROLL_MAX_PLAYER,
  HIT_ROLL_MAX_MONSTER,
  PVP_COOLDOWN_INCREMENT,
  BARBARIAN,
  CLERIC,
  MAGE,
  PALADIN,
  INVINCIBLE,
} from './constants.js'
export { toPlayerCombatState } from './playerState.js'
export type { PlayerCombatState, WeaponDamage } from './playerState.js'
export { createCombatRegistry } from './combatRegistry.js'
export type { CombatRegistry } from './combatRegistry.js'
export { toCombatant } from './combatant.js'
export type { Combatant, PlayerCombatant, CreatureCombatant } from './combatant.js'
export { hitThreshold, playerBaseDamage, monsterDamage, applyPaladinAlignment } from './attackStats.js'
export { checkTargetImmunity, checkPvpGate } from './pvp.js'
export type { CombatGateResult, TargetImmunityInput, PvpGateInput } from './pvp.js'
