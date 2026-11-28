import type { RoomNode, ServerEvent } from 'shared'
import { applyVitals } from '../combat/applyVitals.js'
import type { CombatRegistry } from '../combat/combatRegistry.js'
import type { CombatRoundReport } from '../combat/index.js'
import type { EntryLogger } from '../world/liveCharacterEntry.js'
import type { LiveCharacter, LiveCharacterRegistry } from '../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../world/markCharacterDirty.js'
import type { ResolveCharacterName } from '../world/roomTargetResolvers.js'
import { projectRoomView } from '../world/roomView.js'
import type { MoveActor } from '../world/tryMove.js'
import { characterStatsEvent } from './characterStatsEvent.js'
import { computeRoundAudience, projectCombatRound } from './combatRoundProjection.js'
import { safeLogError, type PresenceBroadcaster, type SafeLogError } from './presenceBroadcaster.js'

/**
 * 라운드 통지기 (스펙 §3.4) — combatTick의 `onRoundResolved` 보고서 하나를 받아 되쓰기와 전송을 한다.
 *
 * ## 전송은 통지기만 한다 (D10)
 * 사망 seam(`assembleDeathSeams`)은 상태만 바꾸고 아무것도 보내지 않는다. 시전 치사는 라운드 도중에
 * 사망 seam을 실행하므로 seam이 직접 보내면 순서가 뒤집힌다. 그래서 presence를 포함한 모든 전송을
 * 라운드가 끝난 뒤 여기서 다음 순서로 몰아서 한다:
 *   1. 생존한 상태 변경자 되쓰기(전송 없음)
 *   2. 라운드 수신자 각자에게 수신자별 투영 `combat:round`
 *   3. 상태 변경자 ∪ 경험치 수령자에게 `character:stats` 1건씩(최신 라이브 문서에서 변환)
 *   4. 몬스터가 죽었으면 방 뷰 갱신 대상에게 그 방의 `world:room`(사망 seam이 이미 몬스터를 뺐다)
 *   5. 사망자마다: 출발 방(`report.room`) ≠ 부활 방(라이브 문서 `currentRoom`)이면 출발 방 `exited` →
 *      부활 방 `entered` presence → 본인에게 부활 방 `world:room`. 같은 방이면 본인 `world:room`만.
 * 집합 계산은 `combatRoundProjection`의 순수 함수가, presence 이벤트 생성·점유자 순회는 기존
 * presence 방송기가 맡는다(OQ1 — `exited`는 와이어에서 항상 `announce:false`).
 *
 * ## ★ 되쓰기 직전 라이브 엔트리를 다시 읽는다 (attack.ts 관례)
 * 같은 tick 호출 안에서 사망 seam이 기여자 경험치를 올린 **새 `LiveCharacter`**를 등록했을 수 있다
 * (`ws/handlers/attack.ts` "★ 공격 뒤 라이브 엔트리를 다시 읽는다"와 같은 이유). 그래서 매번 레지스트리
 * 에서 최신 문서를 읽어 `applyVitals`로 hp·mp만 얹는다. 사망자는 사망 seam이 이미 되썼으므로 건너뛴다.
 *
 * ## 영속화 빈도 (OQ3)
 * 라운드마다 `markCharacterDirty`를 부르지만 `"collection:id"` 키 last-write-wins라 flush 주기(120초)당
 * upsert 1회로 접힌다(attack.ts "영속화 빈도 판정" 절과 같다). 연속 전투도 같은 키라 조정하지 않는다.
 *
 * ## 예외 계약 — 절대 던지지 않는다
 * combatTick의 `onRoundResolved`는 throw 금지 계약이다. 수신자 단위(전송·되쓰기·이동 알림)로 실패를
 * 격리해 `logger.error`만 남기고 나머지를 계속하며(presence 방송기 관례), 그 밖의 예외도 최후 방어선
 * 에서 삼킨다. 로깅 자체의 실패도 새지 않게 한다.
 */

/** 통지기 logger seam — presence 방송기와 같은 `EntryLogger['error']`(라이브 월드 묶음 logger와 호환). */
export type CombatRoundNotifierLogger = Pick<EntryLogger, 'error'>

export interface CombatRoundNotifierDeps {
  /** 라이브 캐릭터 단일 출처 — 되쓰기 직전·스탯 변환·이동 알림마다 최신 문서를 다시 읽는다. */
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  /** 라이브 전투상태 — 라운드 끝 hp·mp(상태 변경자 판정·되쓰기 값)의 출처. */
  readonly combatRegistry: Pick<CombatRegistry, 'get'>
  readonly markCharacterDirty: MarkCharacterDirty
  /** 한 캐릭터에게 이벤트 전송. presence 방송기에 준 것과 같은 함수여야 한다. */
  readonly sendToCharacter: (characterId: string, event: ServerEvent) => void
  /** 방 번호 → 라이브 방 노드(부활 방 해석). */
  readonly resolveRoomById: (roomId: number) => RoomNode | undefined
  /** 방 뷰 점유자 이름 — 공격 핸들러와 **같은 인스턴스**(liveWorldWiring 불변식 #3). */
  readonly resolveCharacterName: ResolveCharacterName
  /** 기존 presence 방송기(진입 코어·이동 seam과 같은 인스턴스). */
  readonly presence: PresenceBroadcaster
  /** 이번 tick 호출의 경험치 수령자(tick 범위 수집기의 `current`). */
  readonly awardedPlayerIds: () => ReadonlySet<string>
  readonly logger: CombatRoundNotifierLogger
}

/** 라운드 1건 처리 동안 단계 헬퍼가 공유하는 문맥. */
interface RoundContext {
  readonly deps: CombatRoundNotifierDeps
  readonly logError: SafeLogError
  /** 이번 라운드에서 "라이브 엔트리 없음"을 이미 남긴 id — 같은 원인을 단계마다 반복해 남기지 않는다. */
  readonly missingLogged: Set<string>
}

/** 수신자 단위 격리 — 한 사람의 실패가 나머지 수신자·단계를 끊지 않는다. */
function isolate(ctx: RoundContext, characterId: string, step: string, work: () => void): void {
  try {
    work()
  } catch (err) {
    ctx.logError({ err, characterId, step }, `라운드 통지 실패(${step}) — 이 수신자만 건너뛴다`)
  }
}

/** 최신 라이브 엔트리. 없으면 라운드당 1회만 흔적을 남기고 undefined. */
function readLive(ctx: RoundContext, characterId: string, step: string): LiveCharacter | undefined {
  const live = ctx.deps.liveRegistry.get(characterId)
  if (live === undefined && !ctx.missingLogged.has(characterId)) {
    ctx.missingLogged.add(characterId)
    ctx.logError({ characterId, step }, '라운드 통지 대상 라이브 엔트리 없음')
  }
  return live
}

/** (1) 최신 라이브 엔트리 재조회 → hp·mp만 얹어 재등록 + 영속 마킹(인벤토리 등 나머지는 그대로). */
function writeBack(ctx: RoundContext, characterId: string): void {
  const { deps } = ctx
  const live = readLive(ctx, characterId, 'write-back')
  if (live === undefined) return
  const state = deps.combatRegistry.get(characterId)
  if (state === undefined) {
    ctx.logError({ characterId, step: 'write-back' }, '되쓰기 대상 전투상태 없음')
    return
  }
  const character = applyVitals(live.character, state)
  deps.liveRegistry.register({ ...live, character })
  deps.markCharacterDirty(characterId, character)
}

/** (3) 되쓰기 뒤 최신 문서에서 변환한다 — 사망자는 부활 후 값이 나간다. */
function sendStats(ctx: RoundContext, characterId: string): void {
  const live = readLive(ctx, characterId, 'stats')
  if (live !== undefined) {
    ctx.deps.sendToCharacter(characterId, characterStatsEvent(live.character))
  }
}

function roomEvent(ctx: RoundContext, room: RoomNode): ServerEvent {
  return { type: 'world:room', ...projectRoomView(room, ctx.deps.resolveCharacterName) }
}

/**
 * (4) 몬스터가 죽었으면 그 방 뷰를 갱신 대상에게 보낸다. 뷰 생성 실패는 이 단계만 건너뛴다 — 5단계
 * 사망자 이동 알림이 반드시 실행돼야 한다.
 */
function sendRoomViews(ctx: RoundContext, room: RoomNode, recipients: ReadonlySet<string>): void {
  let view: ServerEvent
  try {
    view = roomEvent(ctx, room)
  } catch (err) {
    ctx.logError(
      { err, roomId: room.roomId, step: 'room' },
      '라운드 방 뷰 생성 실패 — 4단계를 건너뛴다',
    )
    return
  }
  for (const id of recipients) {
    isolate(ctx, id, 'room', () => ctx.deps.sendToCharacter(id, view))
  }
}

/**
 * (5) 사망자 이동 알림. 출발 방은 보고서의 방이다 — 사망 seam이 라이브 문서를 이미 부활 방으로
 * 옮겼으므로 도착 방은 라이브 문서의 `currentRoom`이다. 방송기는 호출 시점 점유자에서 이동자를 빼고
 * 보낸다(사망자는 이미 출발 방에 없고 부활 방에 있다).
 */
function notifyRevival(ctx: RoundContext, characterId: string, from: RoomNode): void {
  const { deps } = ctx
  const live = readLive(ctx, characterId, 'revival')
  if (live === undefined) return
  const to = deps.resolveRoomById(live.character.currentRoom)
  if (to === undefined) {
    ctx.logError({ characterId, roomId: live.character.currentRoom }, '부활 방을 찾을 수 없다')
    return
  }
  if (to.roomId !== from.roomId) {
    const actor: MoveActor = { characterId, currentRoomId: from.roomId }
    deps.presence.broadcastLeave(from, actor, { change: 'exited' })
    deps.presence.broadcastJoin(to, actor, { change: 'entered' })
  }
  deps.sendToCharacter(characterId, roomEvent(ctx, to))
}

/** §3.4 1~5단계를 순서대로 실행한다. 단계 안에서는 수신자 단위로 격리한다. */
function notifyRound(ctx: RoundContext, report: CombatRoundReport): void {
  const { deps } = ctx
  const audience = computeRoundAudience(
    report,
    (id) => deps.combatRegistry.get(id),
    deps.awardedPlayerIds(),
  )
  for (const id of audience.survivorsToWriteBack) {
    isolate(ctx, id, 'write-back', () => writeBack(ctx, id))
  }
  for (const id of audience.roundRecipients) {
    isolate(ctx, id, 'round', () => deps.sendToCharacter(id, projectCombatRound(report, id)))
  }
  for (const id of audience.statsRecipients) {
    isolate(ctx, id, 'stats', () => sendStats(ctx, id))
  }
  if (report.monsterDied) sendRoomViews(ctx, report.room, audience.roomViewRecipients)
  for (const id of report.playerDeaths) {
    isolate(ctx, id, 'revival', () => notifyRevival(ctx, id, report.room))
  }
}

/** 라운드 통지기를 만든다. 반환 함수는 combatTick `onRoundResolved`에 꽂으며 절대 던지지 않는다. */
export function createCombatRoundNotifier(
  deps: CombatRoundNotifierDeps,
): (report: CombatRoundReport) => void {
  const logError = safeLogError(deps.logger)
  return (report) => {
    try {
      notifyRound({ deps, logError, missingLogged: new Set() }, report)
    } catch (err) {
      // 최후 방어선 — 집합 계산·수집분 조회 등 수신자 단위 격리 밖에서 난 예외.
      logError(
        { err, creatureInstanceId: report.creature.instanceId, roomId: report.room.roomId },
        '라운드 통지 실패',
      )
    }
  }
}
