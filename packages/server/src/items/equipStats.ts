import type { ObjectInstance, EffectiveStatContext } from 'shared'
import type { ObjectTemplate } from './objectTemplate.js'
import { WIELD } from './taxonomy.js'

/**
 * 착용 장비 파생 스탯 투영 — 착용 객체 집합을 `EffectiveStatContext` 기여 필드로 compute-on-read 투영한다.
 *
 * stats-core(computeAc·computeThaco)를 재구현하지 않는다. 여기서는 투영값만 산출하고,
 * stats-core resolver가 이 값을 판독한다. equipArmor는 computeAc가, weaponAdjustment·
 * weaponProficiency는 computeThaco가 소비한다.
 */

/** WIELD 착용 슬롯(0-based) — taxonomy의 wearflag WIELD(20)에서 −1로 파생한다. */
const WIELD_SLOT = WIELD - 1

/** 착용 (인스턴스, 템플릿) 쌍 — slot은 인스턴스에만 있어 템플릿과 함께 넘겨 슬롯을 판정한다. */
export type EquippedPair = {
  readonly instance: ObjectInstance
  readonly template: ObjectTemplate
}

/** projectEquipStats 출력 — EffectiveStatContext 기여 부분집합. */
export type EquipStatContribution = Pick<
  EffectiveStatContext,
  'equipArmor' | 'weaponAdjustment' | 'weaponProficiency'
>

/**
 * 착용 쌍 집합과 명시 숙련값을 EffectiveStatContext 기여 필드로 투영한다.
 *
 * - equipArmor = Σ template.armor (부호 유지 — 저주 장비 음수 armor·방패 포함, 모든 착용 아이템 합).
 * - weaponAdjustment = WIELD 슬롯(0-based 19) 착용 아이템의 template.adjustment. 슬롯 번호로만
 *   판정한다 — HELD(16) 무기를 WIELD로 오인하지 않는다. WIELD 미착용이면 0.
 * - weaponProficiency = 명시 인자를 그대로 투영한다(Character.proficiency[5] 어댑터는 E6 유예).
 *
 * 입력을 변형하지 않고 새 객체를 반환한다.
 */
export function projectEquipStats(
  equipped: ReadonlyArray<EquippedPair>,
  weaponProficiency: number,
): EquipStatContribution {
  const equipArmor = equipped.reduce((sum, e) => sum + e.template.armor, 0)
  const wield = equipped.find((e) => e.instance.slot === WIELD_SLOT)
  const weaponAdjustment = wield?.template.adjustment ?? 0
  return { equipArmor, weaponAdjustment, weaponProficiency }
}
