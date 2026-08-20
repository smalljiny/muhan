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
  MONSTER_SPELL_CAST_CHANCE,
  ATTACK_COOLDOWN_INTERVAL,
  ATTACK_COOLDOWN_BLIND,
} from './constants.js'
export { toPlayerCombatState } from './playerState.js'
export type { PlayerCombatState, WeaponDamage } from './playerState.js'
export { assemblePlayerCombatState } from './assemblePlayerCombatState.js'
export type { CombatStateCarry } from './assemblePlayerCombatState.js'
export { createCombatRegistry } from './combatRegistry.js'
export type { CombatRegistry } from './combatRegistry.js'
export { toCombatant } from './combatant.js'
export type { Combatant, PlayerCombatant, CreatureCombatant } from './combatant.js'
export {
  hitThreshold,
  playerBaseDamage,
  monsterDamage,
  applyPaladinAlignment,
} from './attackStats.js'
export { checkTargetImmunityPre, checkTargetImmunityPost, checkPvpGate } from './pvp.js'
export type { CombatGateResult, TargetImmunityInput, PvpGateInput } from './pvp.js'
export { registerEnemy, createDamageLedger, accumulateDamage } from './enmity.js'
export type { DamageLedger } from './enmity.js'
export { createCreatureLedgers } from './creatureLedgers.js'
export type { CreatureLedgers } from './creatureLedgers.js'
export { resolveAttack } from './resolveAttack.js'
export type { ResolveContext, AttackOutcome } from './resolveAttack.js'
export { createCombatTick } from './combatTick.js'
export type { CombatTickDeps, CastSpellSeam, SpellCastResult } from './combatTick.js'
export { initiateAttack } from './initiateAttack.js'
export type { InitiateContext, InitiateResult } from './initiateAttack.js'
