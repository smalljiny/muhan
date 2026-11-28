import type { ServerEvent } from 'shared'
import type { AttackOutcome, CombatRoundReport, IncomingAction } from '../combat/index.js'

/** `combat:round` 이벤트 — 와이어 계약에서 파생한다(수기 재선언 금지, `characterStatsEvent` 선례). */
export type CombatRoundEvent = Extract<ServerEvent, { type: 'combat:round' }>

/** 현재 전투상태의 hp·mp 스냅샷 — 상태 변경자 판정 입력. */
export interface RoundVitals {
  readonly hpCurrent: number
  readonly mpCurrent: number
}

/**
 * 라운드 보고서에서 계산한 통지 대상 집합(스펙 §2 G2 표). 모든 집합은 새로 만든 것이며 삽입 순서가
 * 결정적이다(표적 → 반격 순서, statsBefore 순서 → playerDeaths 순서 → 경험치 수령자 순서).
 */
export interface RoundAudience {
  /** 라운드 수신자 — 표적 ∪ 반격을 굴린 플레이어(중복 제거). `combat:round` 1건씩. */
  readonly roundRecipients: ReadonlySet<string>
  /** 상태 변경자 — 라운드 시작 대비 hp·mp가 바뀐 플레이어 ∪ 사망 seam이 실행된 플레이어. */
  readonly statsChanged: ReadonlySet<string>
  /** 되쓰기 대상 — 상태 변경자 중 사망하지 않은 플레이어(사망자는 사망 seam이 이미 되썼다). */
  readonly survivorsToWriteBack: ReadonlySet<string>
  /** `character:stats` 수신자 — 상태 변경자 ∪ 경험치 수령자, 1인 1건. */
  readonly statsRecipients: ReadonlySet<string>
  /** `world:room` 갱신 대상 — 몬스터가 죽은 라운드에만, 그 방에 아직 있는 라운드 수신자. */
  readonly roomViewRecipients: ReadonlySet<string>
}

/** 와이어 타격 필드 — `combat:round`의 `counter`(= melee `received`) 형태에서 파생한다. */
type StrikeResult = NonNullable<CombatRoundEvent['counter']>

/** AttackOutcome에서 와이어 타격 필드 4개만 골라낸다(died·specialAttack·messageInputs는 싣지 않는다). */
function toStrike(outcome: AttackOutcome): StrikeResult {
  return {
    hit: outcome.hit,
    damage: outcome.damage,
    critical: outcome.critical,
    fumble: outcome.fumble,
  }
}

/** 표적에 대한 몬스터 행동을 `received` 와이어 값으로 바꾼다. */
function toReceived(incoming: IncomingAction): CombatRoundEvent['received'] {
  if (incoming.kind === 'cast') return { kind: 'cast', damage: incoming.damage }
  return { kind: 'melee', ...toStrike(incoming.outcome) }
}

/**
 * 라운드 보고서를 수신자 한 명의 `combat:round`로 투영한다(스펙 §3.6). 입력을 변형하지 않는 순수 함수다.
 *
 * - `received`: 수신자가 표적이면 몬스터 행동(근접 빗맞음·사망 취소 표적은 `hit:false, damage:0`,
 *   피해 없는 시전은 `cast, damage:0`), 표적이 아니면 `null`(반격만 한 플레이어).
 * - `counter`: 수신자가 이번 라운드에 굴린 반격 결과. 굴리지 않았으면 `null`.
 * - `youDied`: 수신자가 이번 라운드에 사망 seam을 거쳤는지(`playerDeaths` 포함 여부).
 */
export function projectCombatRound(
  report: CombatRoundReport,
  recipientId: string,
): CombatRoundEvent {
  const counter = report.counters.find((entry) => entry.characterId === recipientId)
  return {
    type: 'combat:round',
    creatureInstanceId: report.creature.instanceId,
    creatureName: report.creature.name,
    received: recipientId === report.targetId ? toReceived(report.incoming) : null,
    counter: counter === undefined ? null : toStrike(counter.outcome),
    monsterDied: report.monsterDied,
    youDied: report.playerDeaths.includes(recipientId),
  }
}

/** statsBefore 대비 현재 hp·mp가 바뀐 플레이어 ∪ 사망자. 현재 전투상태가 없는 생존자는 제외한다. */
function collectStatsChanged(
  report: CombatRoundReport,
  currentVitals: (characterId: string) => RoundVitals | undefined,
): Set<string> {
  const changed = new Set<string>()
  for (const [characterId, before] of report.statsBefore) {
    const now = currentVitals(characterId)
    if (now === undefined) continue
    if (now.hpCurrent !== before.hpCurrent || now.mpCurrent !== before.mpCurrent) {
      changed.add(characterId)
    }
  }
  for (const characterId of report.playerDeaths) changed.add(characterId)
  return changed
}

/**
 * 라운드 보고서·현재 전투상태·경험치 수령자로 G2 표의 통지 대상 집합을 계산한다(스펙 §2 G2, §3.4).
 * 입력을 변형하지 않는 순수 함수다 — 반환 집합은 모두 새로 만든다.
 *
 * `report.statsBefore`는 `CombatRoundReport`에서 필수 필드다(보고서를 만들 때 항상 채워진다).
 * `currentVitals`는 통지기가 전투 레지스트리에서 읽은 라운드 끝 hp·mp다. `awarded`는 이번 tick 호출의
 * 몬스터 사망 분배에서 경험치를 적립받은 라이브 플레이어로, 라운드 수신자 밖 기여자도 포함할 수 있다.
 */
export function computeRoundAudience(
  report: CombatRoundReport,
  currentVitals: (characterId: string) => RoundVitals | undefined,
  awarded: ReadonlySet<string>,
): RoundAudience {
  const roundRecipients = new Set<string>([
    report.targetId,
    ...report.counters.map((entry) => entry.characterId),
  ])
  const statsChanged = collectStatsChanged(report, currentVitals)
  const dead = new Set(report.playerDeaths)
  const survivorsToWriteBack = new Set(
    [...statsChanged].filter((characterId) => !dead.has(characterId)),
  )
  const statsRecipients = new Set<string>([...statsChanged, ...awarded])
  const roomViewRecipients = report.monsterDied
    ? new Set([...roundRecipients].filter((characterId) => report.room.occupants.has(characterId)))
    : new Set<string>()
  return {
    roundRecipients,
    statsChanged,
    survivorsToWriteBack,
    statsRecipients,
    roomViewRecipients,
  }
}
