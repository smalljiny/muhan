import type { RoomNode } from 'shared'
import type { CombatRegistry } from '../combat/combatRegistry.js'
import type { CreatureLedgers } from '../combat/creatureLedgers.js'
import type { ResolveContext } from '../combat/resolveAttack.js'
import { distributeCreatureDeath } from '../combat/deathDistribution.js'
import { removeEnemy } from '../combat/enmity.js'
import type { PlayerCombatState } from '../combat/playerState.js'
import { applyPlayerDeath, DEFAULT_REVIVE_ROOM } from '../progression/death.js'
import type { MoveActor, TryMoveDeps } from '../world/tryMove.js'
import { onCreatureDeath, type CreatureDeathDeps } from '../world/creatureDeath.js'
import type { LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../world/markCharacterDirty.js'

/**
 * assembleDeathSeams — `ResolveContext`의 사망 seam 두 개(`fireCreatureDeath`·`firePlayerDeath`)를
 * 라이브 상태에 연결해 만들어 준다. `initiateAttack`이 HP<1을 판정한 뒤 `fireDeath`로 부르는 지점이
 * 여기로 들어온다.
 *
 * 이 모듈은 보상 산술도 방 처리도 담당하지 않는다. `distributeCreatureDeath`(exp 분배·전리품 계산)와
 * `onCreatureDeath`(perm 리스폰 타이머·MSUMMO 소환·방 제거)가 각각 담당하고, 여기서는 **둘을 어떤
 * 순서로 잇고 결과를 라이브 레지스트리에 어떻게 반영하는지**만 정한다.
 *
 * ## 처리 순서가 load-bearing이다
 * `fireCreatureDeath`는 다음 순서를 지킨다:
 *   1. `ledgers.for(dead.instanceId)`로 이 몬스터 원장을 읽어 `distributeCreatureDeath`에 넘긴다.
 *   2. 기여자 경험치를 라이브 레지스트리에 적립하고, 관찰자가 있으면 수령자 목록을 알린다(D11).
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
 * ## 경험치 수령자 관찰자 (D11)
 * 선택 의존성 `onCreatureDeathAwards`를 주면 `fireCreatureDeath`가 (2) 적립 루프를 마친 직후 실제로
 * 적립된 **라이브** 플레이어 id 목록으로 관찰자를 사망 1건당 정확히 1회 부른다. 미등록 기여자는 적립되지
 * 않으므로 목록에 없다. 적립된 사람이 없어도 빈 목록으로 부른다 — "사망 1건 = 호출 1회" 불변식을
 * 지켜 수집 측이 분기 없이 합집합만 쌓으면 되게 한다. 관찰자가 불리는 시점에 수령자의 레지스트리
 * 경험치는 이미 올라가 있다. 이 seam은 여전히 아무것도 전송하지 않는다 — 수령자에게 스탯을 보내는
 * 일은 관찰자를 소비하는 쪽(라운드 통지기)이 맡는다. 관찰자를 주지 않으면 동작은 이전과 같다.
 *
 * 오프너(`ws/handlers/attack.ts`)와 combatTick은 **같은** seam 인스턴스를 쓰므로 오프너 처치에서도
 * 관찰자가 실행된다. 프로덕션 관찰자는 tick 범위 수집기(`ws/tickAwardCollector.ts`의 `record`)이고,
 * 수집기는 wiring의 combatTick 래퍼가 `begin()`~`end()`로 켠 동안에만 기록한다. 오프너 처치 시점에는
 * 수집기가 꺼져 있어 기록이 남지 않는다 — 다음 tick 라운드의 통지기가 오프너 수령자에게 `character:stats`를
 * 덧보내지 않는다. 오프너 처치의 통지는 지금처럼 공격 핸들러 반환이 맡는다(스펙 §3.4).
 *
 * ## alignmentDelta를 적용하지 않는다 (D7)
 * `DeathAward.alignmentDelta`는 계산해 받지만 캐릭터에 더하지 않는다. 오라클의 alignment 값 범위는
 * `-1000..+1000`인데 현 구현의 `Character.alignment`는 `[0,2]`이고(#123), 학습 게이트 등이 그 1|2
 * 인코딩을 읽는다. 값 범위가 다른 델타를 더하면 인코딩이 깨져 무관한 규칙이 조용히 오작동한다. 값 범위
 * 정정(#123)이 먼저이고, 그 뒤에 이 적립을 켠다.
 *
 * ## drops를 방에 넣지 않는다 (D8)
 * `DeathDistribution.drops`(인벤토리 + 골드)도 받기만 하고 `room.items`에 넣지 않는다. 지금 명령
 * 어휘에 방 바닥 아이템을 줍는 수단이 없어서, 넣으면 아무도 회수할 수 없는 아이템만 방마다 쌓인다.
 * 줍기 명령이 연결되는 시점에 이 지점에서 투입한다.
 *
 * ## firePlayerDeath는 상태만 바꾼다 (스펙 §3.5)
 * 몬스터 반격·시전으로 플레이어 HP가 1 미만이 되면 이 seam이 다음 순서로 상태를 바꾼다:
 *   0. 부활 방을 `resolveRoom`으로 **먼저** 조회한다. 부팅이 존재를 확인하므로(D9) 실패는 조립
 *      오류다 — `logger.error`만 남기고 아무것도 바꾸지 않는다. 문서의 방 번호와 점유가 갈라지지 않게
 *      하려는 선행 조건이다. 라이브 엔트리가 없을 때도 같은 이유로 로그만 남긴다.
 *   1. 방 안 모든 몬스터의 `enemies`에서 사망자를 뺀다(오라클 `del_enm_crt`). 원장은 그대로 둔다.
 *   2. 라이브 문서에 `applyPlayerDeath`(경험치 손실·부활 방·hp/mp 풀회복)를 적용한다.
 *   3. 출발 방과 부활 방이 다르면 점유를 옮기고 `onRoomLeft`·`onRoomEntered` 훅을 부른다.
 *   4. 풀회복 값으로 **새** 전투상태 객체를 등록한다. 인자 `dead`는 바꾸지 않는다 — 이번 라운드
 *      보고서의 시전 피해 산출(D5)과 반격 자격 판정이 옛 값을 계속 봐야 한다.
 *   5. 라이브 레지스트리에 재등록하고 `markCharacterDirty`를 1회 부른다.
 *
 * ## 전송하지 않는다 (D10)
 * 이 seam은 어떤 이벤트도 보내지 않는다 — deps에 전송 함수 자체가 없다. 시전 치사는 라운드 도중에
 * 이 seam을 실행하므로 여기서 보내면 `combat:round` → 스탯 → 방 뷰 → 이동 알림 순서가 뒤집힌다.
 * presence를 포함한 모든 전송은 라운드가 끝난 뒤 통지기가 몰아서 한다. 훅(`onRoomLeft`·
 * `onRoomEntered`)은 방 활성화·리스폰 같은 월드 상태 훅이지 전송 경로가 아니다.
 *
 * ## 장비 낙하·전체 방송은 옮기지 않는다 (D3)
 * 오라클 `creature.c` die의 장비 낙하는 줍기 명령이 없어 회수할 수 없고(D8과 같은 이유), 사망 전체
 * 방송은 전역 채널이 없다(E7 #37). 둘 다 알려진 차이로 남긴다.
 */

/** 조립 오류를 기록하는 최소 logger seam(console 금지 — save/logger·EntryLogger 관례 미러). */
export interface DeathSeamLogger {
  error(context: Record<string, unknown>, message: string): void
}

/**
 * 사망 seam 조립 의존성(전역 금지 — 인자 주입).
 *
 * `liveRegistry`는 기여자 조회·교체 등록에 쓰는 두 메서드만 요구한다(최소 인터페이스). `ledgers`는 몬스터별
 * 원장 라우터로, 공격 누적에 쓴 것과 **같은 인스턴스**여야 한다 — 다른 인스턴스를 주면 원장이 비어
 * 보상이 0이 된다. `creatureDeathDeps`는 `onCreatureDeath`가 소유하는 템플릿·id 발급기·rng seam이다.
 */
export interface DeathSeamDeps {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  readonly ledgers: CreatureLedgers
  readonly markCharacterDirty: MarkCharacterDirty
  readonly creatureDeathDeps: CreatureDeathDeps
  readonly logger: DeathSeamLogger
  /** 몬스터 사망 1건마다 실제로 경험치가 적립된 라이브 플레이어 id 목록을 받는 선택 관찰자(D11). */
  readonly onCreatureDeathAwards?: (awardedPlayerIds: readonly string[]) => void
  /** 플레이어 사망 처리 의존성(스펙 §3.5). 전송 함수는 의도적으로 없다(D10). */
  readonly playerDeathDeps: PlayerDeathDeps
}

/**
 * 플레이어 사망 seam 의존성. 점유 이동 훅은 `TryMoveDeps`에서 그대로 가져와 시그니처가 어긋나지 않게 한다
 * (프로덕션 묶음의 훅을 그대로 넘길 수 있다).
 */
export interface PlayerDeathDeps extends Pick<TryMoveDeps, 'onRoomEntered' | 'onRoomLeft'> {
  /** 방 번호 → 라이브 방 노드. 부활 방 조회에 쓴다. */
  readonly resolveRoom: (roomId: number) => RoomNode | undefined
  /** 새 전투상태를 등록할 레지스트리 — 공격 핸들러와 같은 인스턴스여야 한다. */
  readonly combatRegistry: Pick<CombatRegistry, 'register'>
  /** 부활 방 번호. 미지정 시 `DEFAULT_REVIVE_ROOM`(1008). */
  readonly reviveRoom?: number
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
   * (immutability 규칙). markDirty 스냅샷 복사는 `markCharacterDirty`가 단독으로 담당하므로 여기서
   * 다시 복사하지 않는다.
   *
   * @returns 실제로 적립했으면 `true`, 미등록이라 건너뛰었으면 `false`.
   */
  function creditExperience(playerId: string, exp: number): boolean {
    const live = deps.liveRegistry.get(playerId)
    if (live === undefined) return false

    const merged = {
      ...live,
      character: { ...live.character, experience: live.character.experience + exp },
      // alignmentDelta는 싣지 않는다(D7 — 파일 상단 참조).
    }
    deps.liveRegistry.register(merged)
    deps.markCharacterDirty(merged.character._id, merged.character)
    return true
  }

  return {
    fireCreatureDeath(dead, room, now) {
      // (1) 이 몬스터에 스코핑된 원장으로 보상을 계산한다. deps 슬롯이 빈 인터페이스라 `{}`를 넘긴다.
      const distribution = distributeCreatureDeath(
        dead,
        room,
        deps.ledgers.for(dead.instanceId),
        {},
      )

      // (2) 기여자 적립. drops는 소비하지 않는다(D8 — 파일 상단 참조).
      const awardedPlayerIds: string[] = []
      for (const award of distribution.awards) {
        if (creditExperience(award.playerId, award.exp)) awardedPlayerIds.push(award.playerId)
      }

      // (2') 적립을 마친 뒤 수령자 관찰자에 알린다(D11 — 파일 상단 참조). 전송은 하지 않는다.
      deps.onCreatureDeathAwards?.(awardedPlayerIds)

      // (3) perm 리스폰 타이머 리셋 → MSUMMO 소환 → 방 creatures[] 제거.
      onCreatureDeath(dead, room, now, deps.creatureDeathDeps)

      // (4) 원장 폐기 — 반드시 (1) 이후다(파일 상단 "처리 순서가 load-bearing이다" 참조).
      deps.ledgers.discard(dead.instanceId)
    },

    firePlayerDeath(dead, room, now) {
      firePlayerDeathImpl(deps, dead, room, now)
    },
  }
}

/** 플레이어 사망 seam 본체 — 단계 번호는 파일 상단 "firePlayerDeath는 상태만 바꾼다"와 같다. */
function firePlayerDeathImpl(
  deps: DeathSeamDeps,
  dead: PlayerCombatState,
  room: RoomNode,
  now: number,
): void {
  const { playerDeathDeps } = deps
  const reviveRoomId = playerDeathDeps.reviveRoom ?? DEFAULT_REVIVE_ROOM
  const characterId = dead.characterId

  // (0) 선행 조건 — 부활 방과 라이브 엔트리를 상태 변경 전에 확인한다. 실패하면 아무것도 바꾸지 않는다.
  const reviveRoom = playerDeathDeps.resolveRoom(reviveRoomId)
  if (reviveRoom === undefined) {
    deps.logger.error(
      { characterId, roomId: room.roomId, reviveRoomId, now },
      'firePlayerDeath: 부활 방을 찾을 수 없다(조립 오류)',
    )
    return
  }
  const live = deps.liveRegistry.get(characterId)
  if (live === undefined) {
    deps.logger.error(
      { characterId, roomId: room.roomId, now },
      'firePlayerDeath: 사망자의 라이브 엔트리가 없다(조립 오류)',
    )
    return
  }

  // (1) 방 안 몬스터 적 목록에서 사망자를 뺀다(del_enm_crt).
  room.creatures.forEach((creature) => removeEnemy(creature, characterId))

  // (2) 경험치 손실·부활 방·풀회복.
  const character = applyPlayerDeath(live.character, { reviveRoom: reviveRoomId })

  // (3) 점유 이동 — 같은 방이면 아무것도 하지 않는다.
  if (room.roomId !== reviveRoom.roomId) {
    movePlayerToReviveRoom(playerDeathDeps, room, reviveRoom, characterId)
  }

  // (4) 새 전투상태 — 인자 dead는 바꾸지 않는다(D5·반격 자격 판정이 옛 값을 본다).
  playerDeathDeps.combatRegistry.register({
    ...dead,
    hpCurrent: character.hpCurrent,
    mpCurrent: character.mpCurrent,
  })

  // (5) 라이브 재등록 + 영속 마킹. applyPlayerDeath가 최대치로 풀회복했으므로 applyVitals 클램프가 필요 없다.
  deps.liveRegistry.register({ ...live, character })
  deps.markCharacterDirty(character._id, character)
}

/**
 * 출발 방 점유 제거 → onRoomLeft → 부활 방 점유 추가 → onRoomEntered (점유 가변 carve-out).
 *
 * `tryMove`(5b~5d)와 같은 순서·같은 actor 관례를 따른다 — actor는 이동 전 위치(출발 방)를 싣고, 점유
 * 제거가 `onRoomLeft`보다 먼저여야 빈 방 비활성화가 성립한다.
 */
function movePlayerToReviveRoom(
  playerDeathDeps: PlayerDeathDeps,
  from: RoomNode,
  to: RoomNode,
  characterId: string,
): void {
  const actor: MoveActor = { characterId, currentRoomId: from.roomId }
  from.occupants.delete(characterId)
  playerDeathDeps.onRoomLeft(from, actor)
  to.occupants.add(characterId)
  playerDeathDeps.onRoomEntered(to, actor)
}
