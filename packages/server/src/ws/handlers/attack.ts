import type { Character, ClientCommand, RoomNode, ServerEvent } from 'shared'
import type { CommandHandler } from '../router.js'
import type { ActorContext } from '../actorContext.js'
import type { LiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../../world/markCharacterDirty.js'
import type { ObjectTemplateIndex } from '../../items/objectTemplate.js'
import type {
  ResolveCharacterName,
  RoomCreatureResolver,
  RoomPlayerResolver,
} from '../../world/roomTargetResolvers.js'
import { projectRoomView } from '../../world/roomView.js'
import { F_ISSET, PBLIND } from '../../world/hexFlags.js'
import { composeCharacterFlags } from '../../character/flags.js'
import type { CombatRegistry } from '../../combat/combatRegistry.js'
import type { CreatureLedgers } from '../../combat/creatureLedgers.js'
import type { CombatRng } from '../../combat/dice.js'
import type { AttackDescriptor } from '../../combat/resolveAttack.js'
import { ATTACK_COOLDOWN_BLIND, ATTACK_COOLDOWN_INTERVAL } from '../../combat/constants.js'
import { assemblePlayerCombatState } from '../../combat/assemblePlayerCombatState.js'
import { toCombatant } from '../../combat/combatant.js'
import { initiateAttack } from '../../combat/initiateAttack.js'
import type { DeathSeams } from '../assembleDeathSeams.js'
import { characterStatsEvent } from '../characterStatsEvent.js'
import { makeErrorEvent } from '../serverEvent.js'

/**
 * attack 핸들러 의존성 seam(전역 금지 — 인자 주입).
 *
 * 사망 seam 두 개(`fireCreatureDeath`·`firePlayerDeath`)는 시그니처를 다시 적지 않고 `DeathSeams`를
 * 확장해 받는다 — 사본을 두면 `ResolveContext`의 seam에 인자가 붙어도 타입 에러 없이 통과해(인자 적은
 * 함수는 인자 많은 함수 타입에 할당 가능) 새 인자를 조용히 무시하는 사본이 남는다.
 *
 * `liveRegistry`는 라이브 캐릭터 단일 출처로, 소비하는 두 메서드만 요구한다(최소 표면). `combatRegistry`는
 * 라이브 전투상태(hp·mp·쿨다운)의 단일 출처다. `resolveRoom`은 actor가 있는 방 노드 해소 seam이고,
 * `resolveRoomCreature`·`resolveRoomPlayer`는 방 스코프 대상 지목자다(질의 전처리·서수 규칙은 그들이 소유).
 * `resolveCharacterName`은 방 뷰 투영과 플레이어 해소가 **같은 인스턴스**를 공유해야 한다
 * (liveWorldWiring 불변식 #3). `now`는 현재 절대 틱 seam으로 `worldClock.currentTick()` 도메인이며,
 * 쿨다운 상수 단위(초)와 1Hz 틱이 일치한다. `rng`는 굴림 seam으로 프로덕션 배선이 `defaultCombatRng`를
 * 꽂는다(전투 모듈은 순수 함수로 남는다). `ledgers`는 크리처별 데미지 원장 라우터로, 사망 seam에 준 것과
 * **같은 인스턴스**여야 보상이 0이 되지 않는다. `markCharacterDirty`는 write-behind 영속화 seam이다.
 */
export interface AttackHandlerDeps extends DeathSeams {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  readonly combatRegistry: Pick<CombatRegistry, 'get' | 'register'>
  readonly objectTemplates: ObjectTemplateIndex
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
  readonly resolveRoomCreature: RoomCreatureResolver
  readonly resolveRoomPlayer: RoomPlayerResolver
  readonly resolveCharacterName: ResolveCharacterName
  readonly now: () => number
  readonly rng: CombatRng
  readonly ledgers: CreatureLedgers
  readonly markCharacterDirty: MarkCharacterDirty
}

/**
 * 거부 사유의 사람용 한국어 message — 이 핸들러가 직접 짓는 거부 2종이다(무적·PvP 게이트 문구는
 * `combat/pvp.ts`가 소유하고 `initiateAttack`이 `reason`으로 돌려주므로 여기서 다시 짓지 않는다).
 *
 * `Record`가 누락을 컴파일에서 막는다(train·study 핸들러 선례).
 */
const REJECT_MESSAGES: Record<'cooldown' | 'player-target' | 'not-found', string> = {
  // 쿨다운 미도래(D13 — 대기열 없이 즉시 거부).
  //
  // ⚠ **의도된 divergence** — 오라클은 이 게이트에서 메시지 없이 조용히 드롭한다
  // (`command5.c:119` `if(t < i) return(0);`). telnet에서는 무응답이 곧 "아직 안 됐다"는 신호였지만,
  // 구조화 프로토콜에서는 클라이언트가 보낸 명령에 아무 응답도 오지 않는 것과 구분되지 않는다
  // (프레임 유실인지 규칙 거부인지 알 수 없다). 그래서 문구를 새로 짓고 error 이벤트로 답한다.
  cooldown: '아직 공격할 준비가 되지 않았습니다',
  // PvP 범위 밖(D5) — 사람이 지목되면 `checkPvpGate`에 닿기 전에 여기서 끊는다.
  'player-target': '아직 사람은 공격할 수 없습니다',
  // 크리처·플레이어 2단 탐색이 모두 빈손일 때(오라클 command5.c:71,76 순서).
  'not-found': '그런 것이 여기에 없습니다',
}

/** 와이어 `combat:attacked.attacks` 원소 — 스키마에서 파생한다(형상을 손으로 다시 적지 않는다). */
type WireAttack = Extract<ServerEvent, { type: 'combat:attacked' }>['attacks'][number]

/**
 * `AttackDescriptor`(7필드) → 와이어 원소(6필드). `specialAttack`은 와이어 계약에 없다(D11 — #99 소관).
 *
 * 반환 타입을 명시하는 것이 load-bearing이다. 추론에 맡기면 이 함수가 무엇을 내보내는지 **여기서는**
 * 아무도 검사하지 않고, `serverEventSchema`가 strict라 필드가 하나 새는 순간 런타임에 프레임 전체가
 * 거부된다(예외 없이 이벤트가 사라지는 형태). 명시하면 그 드리프트가 이 줄에서 컴파일 에러가 된다.
 *
 * 다만 이 방어는 **required 필드**만 잡는다 — `AttackDescriptor`에 optional 필드가 붙으면 rest
 * 구조분해가 그것을 실어 보내도 타입은 통과한다. 그 갈래의 실질 방어는 `attack.test.ts`의
 * `Object.keys(attack).sort()` 완전 일치 단언이다.
 */
function toWireAttack(descriptor: AttackDescriptor): WireAttack {
  const { specialAttack: _specialAttack, ...wire } = descriptor
  return wire
}

/**
 * `combat:attack{target, ordinal?, id?}` 명령을 실 전투 개시로 배선하는 핸들러 팩토리.
 *
 * 게임 규칙 판정(무적 게이트·명중·피해·크리/불발·사망 발화·적대 등록)은 전부 `combat/initiateAttack`이,
 * 대상 지목(가시성 게이트·서수)은 `world/roomTargetResolvers`가, 보상 분배·방 제거는 사망 seam이
 * 소유한다 — 핸들러는 라이브 상태 조회·flags 합성·쿨다운 강제·결과 사상·되쓰기만 한다.
 *
 * ## 관찰자 flags는 **1회만** 합성한다
 * `composeCharacterFlags(live.character, now)`의 결과를 대상 해소자·전투상태 조립기·쿨다운 실명 판정
 * 세 곳에 같은 스냅샷으로 넘긴다. 두 번 합성하면 두 `now()` 사이에 타이머 효과가 만료돼 가시성 판정과
 * 실명 판정이 서로 다른 시점을 보게 된다(study 핸들러 선례). `now()`도 1회만 부른다.
 *
 * ## ★ 공격 뒤 라이브 엔트리를 **다시 읽는다** (이 순서가 load-bearing이다)
 * `initiateAttack`은 대상이 죽으면 그 안에서 사망 seam을 발화하고, 그 seam은 기여자 경험치를 올린
 * **새 `LiveCharacter`를 `liveRegistry.register`한다**(`ws/assembleDeathSeams.ts` 헤더 경고). 따라서
 * 공격 시작 시점에 읽어 둔 `live` 참조로 hp·mp를 되쓰면 방금 오른 경험치가 조용히 사라진다 —
 * 예외도 로그도 없이 "몹을 잡았는데 경험치가 안 오른다"로만 드러난다. 되쓰기 직전에 레지스트리를
 * 다시 읽어 그 최신 문서에 hp·mp만 얹고, `character:stats`도 **그 문서에서** 투영한다.
 *
 * ## 사람 대상은 PvP 게이트에 닿기 전에 거부한다 (D5)
 * `checkPvpGate`가 읽는 `PCHAOS`·`PFAMIL`은 `composeCharacterFlags`가 영원히 0을 돌려주는 비트라
 * (`character/flags.ts` 파티션 표), 연결하면 동의 관문이 영구 거부되면서도 회귀 테스트에는 잡히지
 * 않는다. 그래서 사람이 지목되면 `initiateAttack`을 아예 부르지 않는다. 자기 자신 지목·짧은 질의
 * 게이트는 따로 두지 않는다 — 자기 지목은 이 플레이어 거부 분기로 떨어진다.
 *
 * ## 영속화 빈도 판정 (save-policy 대조)
 * `markCharacterDirty`는 `Map<"collection:id">`에 **last-write-wins**로 스냅샷을 기록하고, 주기 flush
 * 기본값은 120초다(`docs/specs/save-policy.md` — "한 flush 주기 내 HP가 10번 바뀌어도 upsert 1회").
 * 쿨다운 1초 전투에서 초당 1회 마킹은 한 주기에 최대 120회지만 같은 키라 upsert 1회로 접힌다 —
 * **흡수된다. 마킹 호출 지점을 성공 경로 1회로 두고 조정하지 않는다.** 같은 문서의 호출 계약("라이브
 * 참조가 아니라 그 시점 스냅샷을 넘긴다")도 지킨다 — 이 핸들러는 병합해 만든 **새 문서**를 넘긴다
 * (study 핸들러와 같은 쪽). 관측 사실 하나를 남긴다: 기존 `ws/handlers/move.ts`는 `live.character`
 * 라이브 참조를 넘긴다. 이 토픽은 그 관례를 따르지 않는다.
 *
 * 반환:
 *   - 성공 → `[combat:attacked, character:stats]`. 대상이 죽었으면 `world:room`을 세 번째로 덧붙인다
 *     (D14 — 이벤트 추가가 아니라 발화 지점 추가. 안 보내면 클라 방 목록에 죽은 몬스터가 남는다).
 *     셋 다 상태 이벤트라 correlationId를 싣지 않는다(progress:trained 선례).
 *   - 쿨다운·대상 미해소·사람 지목·무적 게이트 실패 → `error{rule_rejected, message}`(id 있으면 반향).
 *   - 라이브 미등록 actor·방 미해소·되쓰기 직전 재조회 실패 → `error{internal}`(배선 격리).
 */
export function createAttackHandler(deps: AttackHandlerDeps): CommandHandler {
  return (command: ClientCommand, actor: ActorContext): ServerEvent | readonly ServerEvent[] => {
    // (1) defensive narrow — router는 combat:attack type에만 이 핸들러를 배선하므로 false 갈래는
    //     구조적으로 도달 불가한 방어선이다.
    if (command.type !== 'combat:attack') return []

    // (2) 시각을 1회만 읽는다 — 쿨다운 비교·flags 만료·전투 컨텍스트가 같은 시점을 봐야 한다.
    const now = deps.now()

    // (3) 라이브 캐릭터 단일 출처 조회. 미등록 actor는 공격 불가 — internal로 격리한다.
    const live = deps.liveRegistry.get(actor.characterId)
    if (live === undefined) {
      return makeErrorEvent('internal', '캐릭터 라이브 상태를 찾을 수 없습니다', command.id)
    }

    // (4) 관찰자 P-flag를 1회 합성해 해소자·조립기·실명 판정에 같은 스냅샷을 넘긴다(위 헤더 참조).
    const flags = composeCharacterFlags(live.character, now)

    // (5) 방 노드 해소. 세션 액터는 항상 방 안에 있으므로 미해소는 배선 오류다.
    const room = deps.resolveRoom(actor.characterId)
    if (room === undefined) {
      return makeErrorEvent('internal', '현재 방을 찾을 수 없습니다', command.id)
    }

    // (6) 쿨다운 게이트 — 등록 상태가 있고 아직 도래하지 않았으면 거부한다(D13). 미등록(첫 공격·
    //     세션 진입 직후)은 게이트가 없다. 이 갈래는 `initiateAttack`을 부르지 않는다.
    const registered = deps.combatRegistry.get(actor.characterId)
    if (registered !== undefined && now < registered.nextAttackAt) {
      return makeErrorEvent('rule_rejected', REJECT_MESSAGES.cooldown, command.id)
    }

    // (7) 대상 지목 2단 — 크리처 **먼저**, 못 찾으면 플레이어(오라클 command5.c:71,76 순서).
    //     `ordinal` 미지정은 해소자 기본값 1로 떨어진다(와이어 스키마가 하한 1을 강제).
    const creature = deps.resolveRoomCreature(room, command.target, flags, command.ordinal)
    if (creature === undefined) {
      const playerId = deps.resolveRoomPlayer(room, command.target, command.ordinal)
      const reason = playerId === undefined ? 'not-found' : 'player-target'
      return makeErrorEvent('rule_rejected', REJECT_MESSAGES[reason], command.id)
    }

    // (8) 전투상태 재조립 + 교체 등록(D4) — 레벨업·장비 변경이 다음 공격에 자동 반영되고,
    //     진행 중 전투의 hp·mp·쿨다운만 등록 상태에서 이어받는다(carry). 미등록이면 carry 없이
    //     캐릭터 문서 값으로 시작한다.
    const carry =
      registered === undefined
        ? undefined
        : {
            hpCurrent: registered.hpCurrent,
            mpCurrent: registered.mpCurrent,
            nextAttackAt: registered.nextAttackAt,
          }
    const state = assemblePlayerCombatState(live, deps.objectTemplates, flags, carry)
    deps.combatRegistry.register(state)

    // (9) 쿨다운 베이스를 **오프너 앞에서** 소모한다 — 오라클 순서다(`command5.c:138`이 타이머를
    //     세팅하고 `:147` MUNKIL 게이트가 그 뒤에 온다). 즉 게이트에 막힌 공격도 1초(실명 6초)를
    //     먹는다. 뒤로 미루면 무적 몬스터 대상 공격이 공짜가 되어 이 명령의 유일한 유량 제한이
    //     사라진다 — 명령마다 장비 페어링·스탯 투영이 돌고 MMGONL/MENONL 경로는 적대 등록까지 간다.
    //     등록된 상태 객체를 in-place로 갱신한다(라이브 가변 필드 carve-out — combatTick:173 관용).
    const base = F_ISSET(flags, PBLIND) ? ATTACK_COOLDOWN_BLIND : ATTACK_COOLDOWN_INTERVAL
    state.nextAttackAt = now + base

    // (10) 공격 판정 일체를 오프너에 위임한다. 원장은 이 크리처 전용이어야 한다 — 단일 원장을 쓰면
    //     다른 몬스터에 준 데미지가 합산돼 사망 보상이 부풀려진다(creatureLedgers.ts 헤더).
    const result = initiateAttack(toCombatant(state), toCombatant(creature), {
      rng: deps.rng,
      room,
      now,
      fireCreatureDeath: deps.fireCreatureDeath,
      firePlayerDeath: deps.firePlayerDeath,
      ledger: deps.ledgers.for(creature.instanceId),
    })
    if (!result.ok) {
      // 게이트 실패 — 문구는 게이트가 소유한다(여기서 다시 짓지 않는다). hp·경험치는 불변이고
      // 쿨다운은 (9)에서 **이미 소모됐다**(오라클 순서 — 위 참조).
      return makeErrorEvent('rule_rejected', result.reason, command.id)
    }

    // (11) 게이트가 계산한 증분을 더한다 — 오라클도 PvP 분기에서 `interval += 3`으로 뒤에 더한다
    //      (`command5.c:201`). 증분이 0이 아닌 경로는 `checkPvpGate`(+3) 하나뿐인데 D5가 사람 대상을
    //      그 앞에서 거부하므로 이 토픽에서는 항상 0이다. 그래도 항을 남긴다 — PvP가 배선되는 시점에
    //      이 자리가 이미 맞아 있어야 한다.
    state.nextAttackAt += result.cooldownIncrement

    // (12) ★ 되쓰기 직전 재조회 — 공격 도중 사망 seam이 엔트리를 교체했을 수 있다(위 헤더 참조).
    //      미등록은 이 토픽에 없는 상태이므로 배선 오류로 격리한다.
    const relive = deps.liveRegistry.get(actor.characterId)
    if (relive === undefined) {
      return makeErrorEvent('internal', '캐릭터 라이브 상태를 찾을 수 없습니다', command.id)
    }
    // 최신 문서에 hp·mp만 얹는다. `{ ...relive }`로 나머지(인벤토리)를 그대로 옮긴다 — 새 엔트리를
    // 통째로 지으면 진입에서 1회 적재한 인벤이 조용히 사라지고 되돌릴 경로가 없다.
    //
    // 하한 0으로 클램프한다. `combat/combatant.ts`의 피해 차감에는 클램프가 없어 hp가 음수가 될 수
    // 있는데, 받는 쪽 두 계약이 모두 `min(0)`이다 — `characterSchema.hpCurrent`와 와이어
    // `character:stats.hpCurrent`. 음수가 나가면 (a) 클라이언트가 프레임을 통째로 거부하고
    // (b) 스키마를 위반한 문서가 flush 대상이 된다. 둘 다 예외 없이 조용히 실패한다.
    // 이 토픽에서는 플레이어가 방어자가 되는 경로가 없어 도달 불가지만, 여기가 hp가 캐릭터 문서로
    // 나가는 **유일한 지점**이고 #99가 몬스터 반격을 잇는 순간 도달한다.
    // 사망 판정은 `state.hpCurrent < 1`을 보는 전투 규칙이 이미 끝냈으므로 클램프가 판정을 바꾸지 않는다.
    const character: Character = {
      ...relive.character,
      hpCurrent: Math.max(0, state.hpCurrent),
      mpCurrent: Math.max(0, state.mpCurrent),
    }
    deps.liveRegistry.register({ ...relive, character })
    deps.markCharacterDirty(actor.characterId, character)

    const { outcome } = result
    const events: ServerEvent[] = [
      {
        type: 'combat:attacked',
        // 대상이 죽었어도 그 시점 값을 싣는다 — 조회용 키가 아니라 "방금 지목했던 그 개체"의 식별자다.
        targetInstanceId: creature.instanceId,
        targetName: creature.name,
        hit: outcome.hit,
        damage: outcome.damage,
        critical: outcome.critical,
        fumble: outcome.fumble,
        died: outcome.died,
        attacks: outcome.messageInputs.attacks.map(toWireAttack),
      },
      // 되쓰기 후 문서에서 투영한다 — 공격 시작 스냅샷을 쓰면 사망 보상 경험치가 한 박자 늦는다.
      characterStatsEvent(character),
    ]
    if (outcome.died) {
      // 사망 seam이 이미 방 creatures[]에서 제거한 뒤라, 이 투영에는 죽은 개체가 없다(D14).
      events.push({ type: 'world:room', ...projectRoomView(room, deps.resolveCharacterName) })
    }
    return events
  }
}
