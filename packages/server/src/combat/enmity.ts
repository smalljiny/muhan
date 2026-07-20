import type { CreatureInstance } from 'shared'

/**
 * 적대(enmity) 등록·데미지 원장 — 오라클 creature.c add_enm_crt(:70) / add_enm_dmg(:213) 대응.
 *
 * 원작은 enemy 태그(이름)와 damage를 한 struct(etag)에 담지만, 우리 스택은 둘을 분리한다(플랜 D5):
 *   - `CreatureInstance.enemies`(string[], creature-spawn 소유 필드)는 dedup 적 리스트로만 쓰인다
 *     — 인접·게이트 판정(`enemies.length`)이 이 배열을 읽는다. 타입은 불변(string[]).
 *   - per-attacker 데미지는 병렬 `Map<attackerId, number>` 원장(이 모듈 소유)에 누적한다.
 *
 * 이 모듈은 누적만 수행한다. 데미지 기반 분배·페널티는 #83 소관(non-goal)이다.
 */

/**
 * 적대 등록 — 오라클 add_enm_crt. 이미 리스트에 있으면(find_enm_crt > -1) 즉시 반환(재등록 없음),
 * 신규면 리스트에 추가한다.
 *
 * `creature.enemies`는 라이브 가변 배열(worldGraph 승인 in-place carve-out — tick/전투가 in-place
 * 갱신)이므로 새 배열을 만들지 않고 in-place push해 참조를 보존한다. 오라클도 in-place 리스트 끝에
 * append한다(creature.c:70 헤더 주석은 front-insert라 하나 실제 코드는 말단 append).
 *
 * 의도적 미이식: 오라클 신규-적 분기의 `if(n<0) crt_ptr->NUMHITS = 0`(creature.c:96) 다중공격 카운터
 * 리셋은 재현하지 않는다 — `CreatureInstance`에 NUMHITS 필드가 없고, Story 8 다중공격은 라운드당
 * 무상태 count 루프(초인 전용)라 지속 카운터 리셋 트리거가 불필요하다.
 */
export function registerEnemy(creature: CreatureInstance, attackerId: string): void {
  if (creature.enemies.includes(attackerId)) return
  creature.enemies.push(attackerId)
}

/** attackerId별 누적 데미지 원장. */
export type DamageLedger = Map<string, number>

/**
 * 새 데미지 원장을 만든다. 호출마다 독립 Map을 반환한다(전역 싱글턴 미조회 — Story 4 combatRegistry
 * 선례).
 */
export function createDamageLedger(): DamageLedger {
  return new Map<string, number>()
}

/**
 * 데미지 누적 — 오라클 add_enm_dmg `ep->damage += dmg`. attacker별로 amount를 합산한다(분배·페널티
 * 없음 — #83).
 *
 * 동작 divergence(D5 분리 설계): 오라클 add_enm_dmg는 적 리스트 멤버(strcmp 매칭)에만 누적하므로
 * 비-적 데미지 기록이 구조적으로 불가능하나, 병렬 원장 분리로 이 멤버십 게이트가 사라져 임의
 * attackerId에 무조건 누적한다. 실사용은 무해하다(Story 8 T8.4가 registerEnemy 후 누적) — 멤버십
 * 게이팅·분배는 #83 resolver 소관.
 */
export function accumulateDamage(ledger: DamageLedger, attackerId: string, amount: number): void {
  ledger.set(attackerId, (ledger.get(attackerId) ?? 0) + amount)
}
