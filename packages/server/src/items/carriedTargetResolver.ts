import { matchTarget, type NameMatchable, type ObjectInstance } from 'shared'
import { F_ISSET, OINVIS, PDINVI } from '../world/hexFlags.js'
import type { EquippedPair } from './equipStats.js'
import { pairObjects } from './objectPairing.js'
import type { ObjectTemplateIndex } from './objectTemplate.js'
import { MAXWEAR } from './taxonomy.js'

/**
 * 인벤 스코프 대상 해소자 — 오라클 `study`(`legacy/muhan/src/magic1.c:279-293`)의 2단 탐색을 이식한다.
 * 1단은 `find_obj`(`object.c:134-161`)로 **미착용 인벤**을, 2단은 `ready[]` 배열로 **착용 슬롯**을 훑는다.
 * 매칭 규칙 자체(4필드 순수 접두 + 서수)는 순수 매처 `shared/naming/matchTarget`이 소유하고 이 모듈은
 * **후보 선별·순서 결정**만 한다(`world/roomTargetResolvers.ts` 관례 미러).
 *
 * ```c
 * // 1단 — find_obj (object.c:143-155)
 * op = first_ot;
 * while(op) {
 *     if(EQUAL(op->obj, str) &&
 *        (F_ISSET(ply_ptr, PDINVI) ? 1 : !F_ISSET(op->obj, OINVIS))) {
 *         match++;
 *         if(match == val) { found = 1; break; }
 *     }
 *     op = op->next_tag;
 * }
 *
 * // 2단 — study의 착용 슬롯 스캔 (magic1.c:279-293)
 * obj_ptr = find_obj(ply_ptr, ply_ptr->first_obj, cmnd->str[1], cmnd->val[1]);
 *
 * if(!obj_ptr || !cmnd->val[1]) {
 *     for(n=0; n<MAXWEAR; n++) {
 *         if(!ply_ptr->ready[n]) continue;
 *         if(EQUAL(ply_ptr->ready[n], cmnd->str[1]))
 *             match++;
 *         else continue;
 *         if(match == cmnd->val[1] || !cmnd->val[1]) {
 *             obj_ptr = ply_ptr->ready[n];
 *             break;
 *         }
 *     }
 * }
 * ```
 *
 * ## 게이트는 매칭 **앞**이다 (1단 한정)
 * 1단의 가시성 판정은 `match++` 앞에서 `EQUAL`과 AND로 결합돼 있으므로, 걸린 후보는 **서수 슬롯을
 * 소모하지 않는다**. 그래서 이 모듈은 후보 배열을 먼저 거른 뒤 `matchTarget`에 넘긴다(순서 보존).
 * 매칭 *후에* 거르면 투명 아이템이 인벤 앞에 있을 때 `비법서 2`가 엉뚱한 아이템을 고른다.
 *
 * **2단에는 가시성 게이트가 없다** — 오라클 `ready[]` 루프의 조건은 `EQUAL` 하나뿐이라 `OINVIS` 착용
 * 아이템도 그대로 지목된다. 1단과의 이 비대칭은 오라클 그대로이며 여기서 맞추지 않는다.
 *
 * ## `match`는 2단에서 0부터 다시 센다
 * 오라클 2단의 `match`는 `study` 함수 지역 변수라 `find_obj` 내부의 `match`와 별개다. 즉 1단에서 몇 개가
 * 매치했든 2단 서수는 착용 후보 안에서만 계산된다. 이 포트는 두 단계에 각각 `matchTarget`을 호출해
 * 그 분리를 구조로 얻는다.
 *
 * ## 관찰자 flags는 인자다
 * 해소자가 `composeCharacterFlags`를 호출하지 않는다 — 호출부(배선 계층)가 합성한 16자 P-flag hex를
 * 넘긴다(`world/roomTargetResolvers.ts`·`combat/playerState.ts` 선례). `now` 의존성을 순수 해소자 밖에
 * 두어 이 모듈이 시간에 무관한 순수 함수로 남는다.
 *
 * ## 템플릿 미해소는 별도 결과로 보고하지 않는다
 * `ObjectInstance`에 `name`·`keys`가 없어 템플릿 미해소 인스턴스는 **원리적으로 이름이 없다**. 따라서
 * 질의 시점에 "템플릿 미해소"와 "미소지"를 구분할 수단이 없고, 해소자는 미해소를 별도 결과로 보고하지
 * 않는다 — 데이터 정합 실패를 관측하려면 결합 시점(hydrate·pairing)의 로그가 맞는 자리다.
 * 미해소 인스턴스는 후보에서 빠지며 서수 슬롯도 소모하지 않는다.
 *
 * ## ⚠ 알려진 divergence — 1단 서수 기준 순서
 * 이 모듈은 인벤 배열 순서를 **서수 기준으로 처음 소비하는 코드**다. 그 순서는 오라클과 다르다 —
 * 오라클 `first_obj`는 이름 정렬 삽입 리스트(`add_obj_crt`, `player.c:857-898`)라 서수가 사전순인데,
 * 이 포트는 `ObjectRepository.findByOwner`의 `_id` 오름차순을 쓴다. 이식하지 않는 이유(EUC-KR
 * collation 재현 불가)와 영향 범위는 `world/liveCharacterEntry.ts` 헤더의 같은 절에 있다.
 * 2단(착용)은 해당 없다 — `ready[]` 인덱스가 곧 순서라 `slot` 오름차순으로 정확히 재현된다.
 * <!-- 추적 이슈: #142 (방 스코프 자매 이슈 #137 — `world/roomTargetResolvers.ts` 헤더) -->
 *
 * 순수 함수다 — 입력 배열·객체를 변형하지 않고 새 배열만 만든다.
 */

/**
 * 소지품 해소자 계약 — 배선 계층이 `typeof` 구현 종속 없이 잡을 수 있는 명시 타입
 * (`world/roomTargetResolvers.ts`의 `RoomCreatureResolver` 선례).
 */
export type CarriedObjectResolver = (
  inventory: readonly ObjectInstance[],
  index: ObjectTemplateIndex,
  query: string,
  observerFlags: string,
  ordinal?: number,
) => EquippedPair | undefined

/**
 * `matchTarget`에 넘길 중간 후보 — 이름·별칭은 템플릿이 소유하므로 쌍에서 끌어올려 붙인다.
 * `NameMatchable`을 확장해 매처 계약에 묶는다(`keys`는 템플릿이 항상 배열을 주므로 필수로 좁힌다).
 */
interface CarriedCandidate extends NameMatchable {
  readonly pair: EquippedPair
  readonly keys: readonly string[]
}

/**
 * `find_obj` 가시성 게이트 — 후보 자격이 있으면 true.
 *
 * 관찰자가 `PDINVI`(투명 감지)를 들면 무조건 통과, 아니면 아이템의 `OINVIS`가 없어야 한다.
 * 오라클은 `op->obj`(object 구조체)의 flags를 읽는데, 이 포트에서 flags는 템플릿이 소유하므로
 * 호출부가 쌍의 템플릿 쪽 flags를 넘긴다(인스턴스는 런타임 가변값만 담는다 — `objectPairing.ts` 헤더 참조).
 */
function isCarriedVisible(objectFlags: string, observerFlags: string): boolean {
  if (F_ISSET(observerFlags, PDINVI)) return true
  return !F_ISSET(objectFlags, OINVIS)
}

/**
 * 2단 스캔 자격 판정 — 착용 상태이면서 `ready[]`에 자리가 있는 슬롯 번호를 가진 인스턴스.
 *
 * 슬롯 범위를 `0 <= slot < MAXWEAR`로 제한하는 것은 오라클 루프 `for(n=0; n<MAXWEAR; n++)`가
 * 그 밖의 번호에 도달할 수 없기 때문이다. `objectSchema.slot`은 `z.int().nullable()`이라 음수·20 이상도
 * 통과하므로(현재 생산 경로 `wear.ts:resolveSlot`은 0..19만 낸다) `null`을 뺀 것과 같은 논리로 뺀다.
 *
 * 타입 술어를 쓰는 이유는 정렬 비교자에서 `slot`을 `number`로 좁히기 위해서다. 술어 없이
 * `.filter(...).sort((a, b) => (a.slot ?? 0) - ...)`로 쓰면 `?? 0`이 **도달 불가능한 죽은 분기**로
 * 남는다(직전 필터가 null을 이미 제거했다).
 *
 * ⚠ `equipped === true`인데 slot이 무효(`null`·음수·`>= MAXWEAR`)인 인스턴스는 여기서도 빠지고
 * 1단 스캔(`equipped === false` 필터)에서도 빠져 **이름으로 영구히 지목 불가**가 된다. 무로그라
 * 운영 중 추적 수단이 없다 — 정상 미착용 탈락과 구분해 경고를 내는 것이 후속 과제다.
 * <!-- 추적 이슈: #143 -->
 */
function isSlotted(instance: ObjectInstance): instance is ObjectInstance & { slot: number } {
  if (instance.equipped !== true || instance.slot === null) return false
  return instance.slot >= 0 && instance.slot < MAXWEAR
}

/**
 * 인스턴스 배열을 템플릿과 결합해 매처 후보로 만든다. 결합·미해소 드롭·순서 보존은 전부
 * `pairObjects`가 소유하고(같은 정책을 여기 다시 쓰지 않는다), 이 함수는 매처가 요구하는
 * `name`·`keys`를 템플릿에서 끌어올리기만 한다.
 */
function toCandidates(
  instances: readonly ObjectInstance[],
  index: ObjectTemplateIndex,
): readonly CarriedCandidate[] {
  return pairObjects(instances, index).map((pair) => ({
    pair,
    name: pair.template.name,
    keys: pair.template.keys,
  }))
}

/**
 * 소지품(인벤 → 착용 슬롯)에서 아이템을 이름(별칭 포함)·서수로 해소한다. 미달이면 `undefined`.
 *
 * @param inventory 소유자의 전 소지품(착용·미착용 혼재). 두 단계가 `equipped`로 스스로 갈라 쓴다
 * @param index objnum → 템플릿 인덱스(이름·별칭·flags의 출처)
 * @param query 사용자가 친 이름 접두(질의 전처리는 호출부 소유)
 * @param observerFlags 관찰자 P-flag hex 스냅샷. 호출부가 `composeCharacterFlags(character, now)`로 합성해 넘긴다
 * @param ordinal 몇 번째 매치를 고를지(1-base, 오라클 `cmnd->val[1]`)
 */
export const resolveCarriedObject: CarriedObjectResolver = (
  inventory,
  index,
  query,
  observerFlags,
  ordinal = 1,
) => {
  // ── 1단: 미착용 인벤(find_obj) ──────────────────────────────────────────────
  // 가시성 게이트를 `matchTarget` **호출 전** 필터로 둔다(서수 슬롯 보존).
  const unworn = inventory.filter((instance) => instance.equipped === false)
  const carried = toCandidates(unworn, index).filter((candidate) =>
    isCarriedVisible(candidate.pair.template.flags, observerFlags),
  )
  const carriedMatch = matchTarget(carried, query, ordinal)?.pair

  // 2단 진입 조건은 오라클 `if(!obj_ptr || !cmnd->val[1])` 그대로다.
  if (carriedMatch !== undefined && ordinal !== 0) return carriedMatch

  // ── 2단: 착용 슬롯(ready[]) ─────────────────────────────────────────────────
  // 오라클은 `ready[]`를 인덱스 오름차순으로 훑으므로 슬롯 번호가 곧 서수 기준이다(인벤 배열 순서가 아니다).
  // `slot`이 null이거나 `[0, MAXWEAR)` 밖인 착용 인스턴스는 `ready[]`에 자리가 없어 오라클 루프가
  // 도달할 수 없으므로 후보에서 뺀다(`isSlotted` 참조) — 착용 상태와 슬롯 번호가 어긋난 데이터 정합
  // 실패이지, 이름으로 지목 가능한 대상이 아니다.
  const wornSorted = inventory.filter(isSlotted).sort((a, b) => a.slot - b.slot)
  // 가시성 게이트를 두지 않는다 — 오라클 `ready[]` 루프 조건이 `EQUAL` 하나뿐이다(magic1.c:285).
  const worn = toCandidates(wornSorted, index)
  // ordinal 0의 선택 조건은 `match == val || !val`의 뒷항이라 **첫 매치**다 → 서수 1과 동치다.
  const wornMatch = matchTarget(worn, query, ordinal === 0 ? 1 : ordinal)?.pair

  // 오라클은 2단이 아무것도 못 찾으면 `obj_ptr`에 1단 결과를 그대로 남긴다. 다만 여기 도달했다는 것은
  // "1단 미해소" 또는 "ordinal === 0"이라는 뜻이고, `matchTarget`은 ordinal 0에서 `match++` 뒤에
  // `match === 0`을 비교하므로 구조적으로 항상 `undefined`다 — 즉 이 시점의 `carriedMatch`는 늘
  // `undefined`이며, 이 fallback은 오라클 형태를 보존할 뿐 값이 바뀌는 경로가 아니다.
  //
  // 덧붙여 ordinal 0 자체가 와이어에서는 도달 불가다. 오라클 `parse`(command1.c:505-580)는 토큰마다
  // `cmnd->val[m] = 1L`을 세팅하고 마지막에 `if(n > m) cmnd->val[m++] = 1L`로 남은 슬롯도 1로 채운다.
  // 숫자 토큰이 명시될 때만(`is_number` 분기, 562행) 그 숫자로 대체되므로 `비법서 연마` → `val[1]=1`,
  // `비법서 2 연마` → `val[1]=2`이고, `!val`이 참인 경우는 사용자가 `비법서 0 연마`처럼 0을 직접 친
  // 때뿐이다. 이 포트의 와이어 스키마는 `ordinal >= 1`을 강제하므로 0 갈래는 단위 테스트로만 고정한다.
  return wornMatch ?? carriedMatch
}
