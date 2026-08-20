import type { ObjectInstance, EffectiveStatContext } from 'shared'
import type { ObjectTemplate } from './objectTemplate.js'
import { WIELD_SLOT } from './taxonomy.js'

/**
 * 착용 장비 파생 스탯 투영 — 착용 객체 집합을 `EffectiveStatContext` 기여 필드로 compute-on-read 투영한다.
 *
 * stats-core(computeAc·computeThaco)를 재구현하지 않는다. 여기서는 투영값만 산출하고,
 * stats-core resolver가 이 값을 판독한다. equipArmor는 computeAc가, weaponAdjustment·
 * weaponProficiency는 computeThaco가 소비한다.
 */

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
 * - **착용 판정**: `instance.equipped === true`인 쌍만 집계한다. 오라클 compute_ac(player.c:980)는
 *   `ready[]`(착용 슬롯 배열)만 순회하므로 미착용(equipped=false)·stale slot 인벤 아이템은 스탯에
 *   기여하지 않는다. 호출자가 전 인벤을 join해 넘겨도(예 ObjectRepository.findByOwner) 미착용
 *   아이템이 AC/THAC0를 오염시키지 못하게 seam이 방어한다(defense-in-depth).
 * - equipArmor = Σ template.armor (부호 유지 — 저주 장비 음수 armor·방패 포함, 착용 아이템 합).
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
  const worn = equipped.filter((e) => e.instance.equipped === true)
  const equipArmor = worn.reduce((sum, e) => sum + e.template.armor, 0)
  const weaponAdjustment = findWieldedPair(equipped)?.template.adjustment ?? 0
  return { equipArmor, weaponAdjustment, weaponProficiency }
}

/**
 * 착용 중인 WIELD 슬롯 무기 쌍을 고른다. 미착용이면 `undefined`.
 *
 * **무기를 보는 모든 소비처가 이 함수를 거쳐야 한다**는 것이 이 export의 존재 이유다. 지금
 * `weaponAdjustment`(명중 보정)와 `combat`의 무기 데미지 서술자는 서로 다른 모듈에서 만들어지는데,
 * 둘이 **같은 아이템**을 설명하지 않으면 명중은 A 무기로, 피해는 B 무기로 계산된다. 각자 판정을
 * 복제해 두면 그 일치가 두 구현의 우연한 동형성에 기대게 되고 — 한쪽에 조건이 하나 붙는 날
 * (부서진 무기 제외, 정렬 변경 등) 조용히 갈린다. 두 모듈 각자는 자기 안에서 일관되므로
 * 어느 테스트도 그 갈라짐을 잡지 못한다.
 *
 * 후보가 여럿이면 입력 순서상 첫 매치다(`pairObjects`가 인벤 순서를 보존한다).
 */
export function findWieldedPair(equipped: ReadonlyArray<EquippedPair>): EquippedPair | undefined {
  return equipped.find((e) => e.instance.equipped === true && e.instance.slot === WIELD_SLOT)
}
