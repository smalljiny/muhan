/**
 * stats/context — 파생 스탯 resolver 5종의 공통 입력 타입.
 *
 * `EffectiveStatContext`는 computeAc·computeThaco·maxWeight·computeHpMax·computeMpMax
 * 5개 resolver가 읽는 필드의 합집합이다(Open Q #1). 각 필드는 이미 합성된 유효값
 * (effective*) 또는 순수 입력이며, resolver는 자신이 필요한 필드만 골라 읽는다. 능력치
 * 합성(base + modifier)은 stats/effectiveStat이 선행 처리하고, 이 컨텍스트에는 그 결과만
 * 담긴다 — resolver는 재합성하지 않는다.
 *
 * 이 타입은 5개 resolver 전 필드를 포함하지만, 본 계층에서 구현된 소비자는 computeAc뿐이다
 * (나머지 필드는 Story 4·5의 resolver가 소비).
 */
export type EffectiveStatContext = {
  /** 유효 민첩(base + modifier 합성 완료). 읽는 곳: computeAc. */
  effectiveDexterity: number
  /** 유효 힘(base + modifier 합성 완료). 읽는 곳: computeThaco, maxWeight. */
  effectiveStrength: number
  /** 착용 장비 armor 합(부호 있음 — 저주 장비면 음수 가능). 읽는 곳: computeAc. */
  equipArmor: number
  /** PPROTE(보호마법) 플래그. 읽는 곳: computeAc. */
  protection: boolean
  /** 클래스 인덱스(1-12). 읽는 곳: computeThaco, maxWeight, computeHpMax, computeMpMax. */
  characterClass: number
  /** 캐릭터 레벨. 읽는 곳: computeThaco, maxWeight, computeHpMax, computeMpMax. */
  level: number
  /** 무기 명중 보정치. 읽는 곳: computeThaco. */
  weaponAdjustment: number
  /** 무기 숙련도(0~100 정수 %). 읽는 곳: computeThaco. */
  weaponProficiency: number
}
