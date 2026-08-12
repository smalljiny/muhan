import type { ObjectInstance } from 'shared'
import type { EquippedPair } from './equipStats.js'
import type { ObjectTemplateIndex } from './objectTemplate.js'

/**
 * 인스턴스↔템플릿 결합 — `EquippedPair`를 만드는 단일 출처.
 *
 * ## 소유권 경계 (스펙 §3.2)
 *
 * 인스턴스는 **런타임 가변값만**(`shotscur`·`slot`·`equipped`·`owner`) 담고, 불변 스탯·이름·별칭은
 * 템플릿이 소유한다. 결합은 두 참조를 한 쌍으로 묶을 뿐 **템플릿 값을 인스턴스에 복사하지 않는다** —
 * 복사하면 같은 값의 출처가 인스턴스와 템플릿 둘로 갈리고, 이후 템플릿 데이터가 바뀔 때 이미 저장된
 * 인스턴스 문서가 조용히 stale이 된다. 인덱스 조회는 `Map.get` 한 번이라 필요할 때 붙이면 된다.
 *
 * 그래서 두 함수 모두 입력 인스턴스·템플릿의 **동일 참조**를 그대로 실어 반환한다(새 쌍 객체만 만든다).
 *
 * ## 미해소 처리 — 두 함수의 정책이 다르다
 *
 * `pairObject`(단수)만 판단을 위임한다 — `undefined`를 돌려 호출자가 의미를 정한다.
 * `pairObjects`(복수)는 **조용히 드롭하는 정책을 이미 고정한다**. 따라서 복수형을 쓰는 경로에서는
 * "템플릿 미해소"가 호출자에게 보이지 않고 후보 부재와 구분되지 않는다 — 미해소를 데이터 정합
 * 실패로 따로 보고하려는 호출자는 단수형을 쓰거나 결합 전에 직접 검사해야 한다.
 *
 * 착용 여부(`instance.equipped`) 필터는 여기서 하지 않는다 — 결합은 착용·미착용을 구분하지 않는
 * 순수 조회이고, 필터는 소비자(`projectEquipStats`) 책임이다.
 */

/**
 * 인스턴스 하나를 `objnum`으로 템플릿과 짝짓는다. 템플릿 미해소면 `undefined`.
 *
 * 입력을 변형하지 않고 새 쌍 객체를 반환한다.
 */
export function pairObject(
  instance: ObjectInstance,
  index: ObjectTemplateIndex,
): EquippedPair | undefined {
  const template = index.get(instance.objnum)
  if (template === undefined) return undefined
  return { instance, template }
}

/**
 * 인스턴스 배열을 결합해 쌍 배열로 만든다. 템플릿 미해소 원소만 빠지고 **입력 순서는 보존**된다.
 *
 * 입력 배열을 변형하지 않고 새 배열을 반환한다.
 */
export function pairObjects(
  instances: readonly ObjectInstance[],
  index: ObjectTemplateIndex,
): readonly EquippedPair[] {
  const paired: EquippedPair[] = []
  for (const instance of instances) {
    const pair = pairObject(instance, index)
    if (pair !== undefined) paired.push(pair)
  }
  return paired
}
