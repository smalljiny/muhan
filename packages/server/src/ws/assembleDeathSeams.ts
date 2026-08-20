import type { CreatureLedgers } from '../combat/creatureLedgers.js'
import type { ResolveContext } from '../combat/resolveAttack.js'
import { distributeCreatureDeath } from '../combat/deathDistribution.js'
import { onCreatureDeath, type CreatureDeathDeps } from '../world/creatureDeath.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../world/markCharacterDirty.js'

/**
 * assembleDeathSeams — `ResolveContext`의 사망 seam 두 개(`fireCreatureDeath`·`firePlayerDeath`)를
 * 라이브 상태에 연결해 만들어 준다. `initiateAttack`이 HP<1을 판정한 뒤 `fireDeath`로 부르는 지점이
 * 여기로 들어온다.
 *
 * 이 모듈은 보상 산술도 방 처리도 소유하지 않는다. `distributeCreatureDeath`(exp 분배·전리품 계산)와
 * `onCreatureDeath`(perm 리스폰 타이머·MSUMMO 소환·방 제거)가 각각 소유하고, 여기서는 **둘을 어떤
 * 순서로 잇고 결과를 라이브 레지스트리에 어떻게 반영하는지**만 정한다.
 *
 * ## 처리 순서가 load-bearing이다
 * `fireCreatureDeath`는 다음 순서를 지킨다:
 *   1. `ledgers.for(dead.instanceId)`로 이 크리처 원장을 읽어 `distributeCreatureDeath`에 넘긴다.
 *   2. 기여자 경험치를 라이브 레지스트리에 적립한다.
 *   3. `onCreatureDeath`로 방에서 제거하고 리스폰 타이머를 리셋한다.
 *   4. `ledgers.discard(dead.instanceId)`로 원장을 버린다.
 *
 * ## 이 seam은 턴 도중에 레지스트리 엔트리를 교체한다
 * 경험치 적립은 새 `LiveCharacter`를 `liveRegistry.register`한다. 따라서 `initiateAttack`을 부른
 * 호출자가 그 호출을 가로질러 예전 `live` 참조를 들고 있다가 그것으로 되쓰면, 여기서 올린 경험치가
 * 조용히 사라진다. **호출자는 `initiateAttack` 뒤에 반드시 레지스트리를 다시 읽어야 한다.**
 *
 * **원장을 먼저 읽고 나중에 버려야 한다.** 순서를 뒤집으면 `discard` 뒤의 `for()`가 빈 원장을 새로
 * 만들어 주므로(`creatureLedgers.ts` 계약) 기여자 집합이 통째로 비고 — `distributeCreatureDeath`의
 * 기여자 게이트가 `ledger.get(id) > 0`이다 — 보상이 조용히 0이 된다. 예외도 로그도 남지 않아
 * "경험치가 안 오른다"는 증상으로만 드러나므로, 이 순서를 테스트로 고정한다.
 *
 * ## alignmentDelta를 적용하지 않는다 (D7)
 * `DeathAward.alignmentDelta`는 계산해 받지만 캐릭터에 더하지 않는다. 오라클의 alignment 값역은
 * `-1000..+1000`인데 현 구현의 `Character.alignment`는 `[0,2]`이고(#123), 학습 게이트 등이 그 1|2
 * 인코딩을 읽는다. 값역이 다른 델타를 더하면 인코딩이 깨져 무관한 규칙이 조용히 오작동한다. 값역
 * 정정(#123)이 먼저이고, 그 뒤에 이 적립을 켠다.
 *
 * ## drops를 방에 넣지 않는다 (D8)
 * `DeathDistribution.drops`(인벤토리 + 골드)도 받기만 하고 `room.items`에 넣지 않는다. 지금 명령
 * 어휘에 방 바닥 아이템을 줍는 수단이 없어서, 넣으면 아무도 회수할 수 없는 아이템만 방마다 쌓인다.
 * 줍기 명령이 배선되는 시점에 이 지점에서 투입한다.
 *
 * ## firePlayerDeath는 로그만 남긴다
 * 이 토픽에서는 구조적으로 도달 불가하다 — 몬스터가 반격하지 않고(몬스터 전투 tick 미배선) PvP도
 * 배선돼 있지 않다. 그래서 호출되면 그 자체가 배선 오류다. 흔적만 남기고 상태는 건드리지 않는다.
 *
 * ⚠ **규칙은 이미 이식돼 있다 — 다시 만들지 마라.** `progression/death.ts`의 `applyPlayerDeath`가
 * exp 손실(레벨대별 공식·하한 클램프)·부활 방 이동·hp/mp 풀회복을 순수 함수로 갖고 있고 단위
 * 테스트도 붙어 있다(non-test caller 0건). 아직 없는 것은 **장비 낙하** 하나다. 여기서 지금 그것을
 * 부르지 않는 이유는 규칙이 없어서가 아니라 이 토픽 범위(스펙 §5)가 아니어서다 — 배선은 #99가 한다.
 */

/** 배선 오류를 기록하는 최소 logger seam(console 금지 — save/logger·EntryLogger 관례 미러). */
export interface DeathSeamLogger {
  error(context: Record<string, unknown>, message: string): void
}

/**
 * 사망 seam 조립 의존성(전역 금지 — 인자 주입).
 *
 * `liveRegistry`는 기여자 조회·교체 등록에 쓰는 두 메서드만 요구한다(최소 표면). `ledgers`는 크리처별
 * 원장 라우터로, 공격 누적에 쓴 것과 **같은 인스턴스**여야 한다 — 다른 인스턴스를 주면 원장이 비어
 * 보상이 0이 된다. `creatureDeathDeps`는 `onCreatureDeath`가 소유하는 템플릿·id 발급기·rng seam이다.
 */
export interface DeathSeamDeps {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  readonly ledgers: CreatureLedgers
  readonly markCharacterDirty: MarkCharacterDirty
  readonly creatureDeathDeps: CreatureDeathDeps
  readonly logger: DeathSeamLogger
}

/**
 * `ResolveContext`가 요구하는 사망 seam 쌍 — 시그니처를 다시 적지 않고 소비처에서 파생한다.
 *
 * 파생이 load-bearing이다. 시그니처를 복사해 두면 나중에 `ResolveContext`의 seam에 인자가 하나 붙어도
 * (예: killer) 이 조립기는 **타입 에러 없이 통과한다** — TypeScript가 인자 적은 함수를 인자 많은
 * 함수 타입에 할당하도록 허용하기 때문이다. 그러면 새 인자를 조용히 무시하는 사본이 남는다.
 */
export type DeathSeams = Pick<ResolveContext, 'fireCreatureDeath' | 'firePlayerDeath'>

/** 사망 seam 쌍을 조립한다. 반환 seam은 deps만 클로저로 쥐고 전역을 조회하지 않는다. */
export function assembleDeathSeams(deps: DeathSeamDeps): DeathSeams {
  /**
   * 기여자 한 명에게 경험치를 적립한다. 라이브 미등록(접속 종료·캐릭터 전환)이면 조용히 건너뛴다 —
   * 죽은 몬스터의 적 리스트는 세션 수명과 무관하게 남으므로 미등록은 정상 상태이지 오류가 아니다.
   *
   * 라이브 문서를 in-place로 고치지 않고 새 `LiveCharacter`·새 `Character`를 만들어 교체 등록한다
   * (immutability 규칙). markDirty 스냅샷 복사는 `markCharacterDirty`가 단독으로 소유하므로 여기서
   * 다시 복사하지 않는다.
   */
  function creditExperience(playerId: string, exp: number): void {
    const live = deps.liveRegistry.get(playerId)
    if (live === undefined) return

    const merged = {
      ...live,
      character: { ...live.character, experience: live.character.experience + exp },
      // alignmentDelta는 싣지 않는다(D7 — 파일 상단 참조).
    }
    deps.liveRegistry.register(merged)
    deps.markCharacterDirty(merged.character._id, merged.character)
  }

  return {
    fireCreatureDeath(dead, room, now) {
      // (1) 이 크리처에 스코핑된 원장으로 보상을 계산한다. deps 슬롯이 빈 인터페이스라 `{}`를 넘긴다.
      const distribution = distributeCreatureDeath(
        dead,
        room,
        deps.ledgers.for(dead.instanceId),
        {},
      )

      // (2) 기여자 적립. drops는 소비하지 않는다(D8 — 파일 상단 참조).
      for (const award of distribution.awards) creditExperience(award.playerId, award.exp)

      // (3) perm 리스폰 타이머 리셋 → MSUMMO 소환 → 방 creatures[] 제거.
      onCreatureDeath(dead, room, now, deps.creatureDeathDeps)

      // (4) 원장 폐기 — 반드시 (1) 이후다(파일 상단 "처리 순서가 load-bearing이다" 참조).
      deps.ledgers.discard(dead.instanceId)
    },

    firePlayerDeath(dead, room, now) {
      // 도달 불가 경로 — 상태를 바꾸지 않고 흔적만 남긴다(파일 상단 참조, 실 처리는 #99).
      deps.logger.error(
        { characterId: dead.characterId, roomId: room.roomId, now },
        'firePlayerDeath: 플레이어 사망 처리는 아직 이식되지 않았다(배선 오류)',
      )
    },
  }
}
