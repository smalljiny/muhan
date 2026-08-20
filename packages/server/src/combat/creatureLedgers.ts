import type { DamageLedger } from './enmity.js'
import { createDamageLedger } from './enmity.js'

/**
 * creatureLedgers.ts — 크리처(defender)별 데미지 원장 라우터.
 *
 * ## 왜 필요한가
 * `DamageLedger`(enmity.ts)는 `Map<attackerId, number>`라 **defender를 키에 담지 않는다**.
 * `resolveAttack`이 모든 크리처 defender에 대해 하나의 원장에 누적하면, 플레이어가 몬스터 B에 준
 * 데미지가 attackerId 단일 키로 합산돼 몬스터 A 사망 보상(exp·alignment·groupkill)을 부풀린다.
 * `distributeCreatureDeath`(deathDistribution.ts)는 건네받은 원장을 "이 크리처에 가해진 데미지"로
 * **검증 없이 신뢰**하므로, 원장을 크리처별로 갈라 주는 책임은 호출자에게 있다. 이 모듈이 그
 * 라우터다 — 라이브 배선은 단일 원장 대신 이 객체를 쥐고 `for(defender.instanceId)`로 얻은 원장에
 * 누적하고, 같은 원장을 사망 분배에 넘긴다.
 *
 * 원장 타입 자체를 defender-scoped(`Map<defenderId, Map<attackerId, number>>` 등)로 바꾸는 것은
 * enmity.ts·resolveAttack·combatTick에 파급되는 인프라 변경이라 여기 범위 밖이다(#99). 이 모듈은
 * `DamageLedger` 타입을 그대로 두고 바깥에서 라우팅만 한다.
 *
 * 팩토리가 Map을 클로저로 소유하며 전역 싱글턴을 조회하지 않는다(createDamageLedger·
 * createCombatRegistry 선례) — 인스턴스 간 상태를 공유하지 않아 테스트마다 격리된다.
 */
export interface CreatureLedgers {
  /** instanceId의 원장을 돌려준다. 없으면 만들어 캐시한다(같은 id에는 항상 같은 참조). */
  for(instanceId: string): DamageLedger
  /** 죽은 크리처의 원장을 버린다. 이후 같은 id로 for()를 부르면 빈 원장이다. */
  discard(instanceId: string): void
}

/** 크리처별 원장 라우터를 만든다. 반환 객체가 Map을 클로저로 소유한다(전역 싱글턴 미조회). */
export function createCreatureLedgers(): CreatureLedgers {
  const ledgers = new Map<string, DamageLedger>()

  return {
    for(instanceId) {
      // 캐시된 참조를 그대로 돌려줘야 누적이 유지된다 — 매번 새 Map을 만들면 직전 라운드
      // 데미지가 사라져 사망 분배에서 기여자가 통째로 빠진다.
      const existing = ledgers.get(instanceId)
      if (existing !== undefined) return existing

      const created = createDamageLedger()
      ledgers.set(instanceId, created)
      return created
    },
    discard(instanceId) {
      // 크리처 사망 시 해제한다. instanceId는 방별 monotonic 발급이라 재사용되지 않지만, 버리지
      // 않으면 죽은 크리처 원장이 프로세스 수명 내내 쌓여 누수가 된다(스폰이 반복되는 월드 틱에서
      // 단조 증가). 삭제 후 같은 id를 다시 조회하면 빈 원장이 새로 만들어진다.
      //
      // ⚠ **사망 경로만 이 함수를 부른다.** 배회로 방을 떠나는 크리처(`world/creatureTick.ts`의
      // wanderOut splice)는 사망 seam을 타지 않아 원장이 남는다. "죽으면 다 정리된다"고 읽으면
      // 안 된다 — 공격받다 배회로 사라진 크리처만큼 누수가 가동 시간에 비례해 늘어난다.
      // 지금 닫지 못하는 이유는 `world/`가 `combat/`을 import하지 않는 규약이라 creatureTick이
      // 직접 부를 수 없고, 비사망 소멸을 바깥에 알리는 seam이 아직 없어서다. 그 seam은 **#147**이 소유한다.
      ledgers.delete(instanceId)
    },
  }
}
