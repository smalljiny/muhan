import type { ClientCommand, RoomNode, ServerEvent } from 'shared'
import type { CommandHandler } from '../router.js'
import type { ActorContext } from '../actorContext.js'
import type { LiveCharacterRegistry } from '../../world/liveCharacterRegistry.js'
import type { MarkCharacterDirty } from '../../world/markCharacterDirty.js'
import { train, type TrainResult } from '../../progression/train.js'
import { makeErrorEvent } from '../serverEvent.js'

/**
 * train 핸들러 의존성 seam(전역 금지 — 인자 주입).
 *
 * `liveRegistry`는 라이브 캐릭터 단일 출처다. 핸들러가 소비하는 두 메서드 `get`·`register`만
 * 요구한다(최소 표면) — `register`는 train()이 반환한 새 Character로 엔트리를 교체하는 데 쓴다.
 * `resolveRoom`은 발화자(characterId) 현재 방 해소자로, 훈련방 flag 판정 입력을 준다(방 위치 단일
 * 출처는 `character.currentRoom`이므로 by-character 해소자를 쓴다 — D-A1).
 * `markCharacterDirty`는 write-behind 영속화 seam으로, train()이 성공 경로에서 1회 소비한다.
 */
export interface TrainHandlerDeps {
  readonly liveRegistry: Pick<LiveCharacterRegistry, 'get' | 'register'>
  readonly resolveRoom: (characterId: string) => RoomNode | undefined
  readonly markCharacterDirty: MarkCharacterDirty
}

/** train() 거부 사유의 사람용 한국어 message. 5개 사유 전부를 빠짐없이 사상한다(Record로 강제). */
const REJECT_MESSAGES: Record<Extract<TrainResult, { ok: false }>['reason'], string> = {
  'not-training-room': '이곳에서는 연마할 수 없습니다',
  'class-mismatch': '이곳은 당신의 수련장이 아닙니다',
  'caretaker-forbidden': '초인은 더 연마할 수 없습니다',
  'insufficient-exp': '경험이 부족합니다',
  'insufficient-gold': '연마 비용이 부족합니다',
}

/**
 * `progress:train{id?}` 명령을 실 연마(레벨업)로 배선하는 핸들러 팩토리.
 *
 * 게임 규칙 판정(훈련방·클래스 일치·exp·gold 3게이트, prestige 승급, 배치 상승)은 전부
 * `progression/train`이 소유한다 — 핸들러는 라이브 상태 조회·방 해소·결과 사상만 한다.
 *
 * ## 권한 정책(OQ3) — 기본 allow
 * `progress:train`은 permissionPort에 명령별 정책을 두지 않는다(현 어댑터는 항상 allow하는
 * permissive stub이고, 클래스·레벨·방 플래그 기반 실 RBAC는 E5의 실 어댑터 소관이다). 연마 게이트는
 * 이미 train()의 3게이트(location→exp→gold)가 단독 소유하므로 권한 레이어에 중복 게이트를 두지
 * 않는다 — 같은 판정이 두 레이어에 흩어지면 분기하고, 거부 코드도 rule_rejected/forbidden으로 갈린다.
 *
 * ## 라이브 엔트리 교체
 * train()은 새 Character를 반환하고 `LiveCharacter.character`는 readonly라, 성공 시
 * `liveRegistry.register`로 엔트리를 통째로 교체한다(같은 _id 키를 덮어쓴다). 이는 턴 밖으로
 * LiveCharacter 참조를 보유하는 코드가 0건이라는 불변식 위에 선다(현재 모든 소비자가 매 호출마다
 * `liveRegistry.get`으로 재조회한다).
 *
 * 회귀 신호의 범위에 주의한다: train.test.ts의 교체 회귀 테스트는 **디스패치 경로 위의 캐시**만
 * 잡는다(같은 명령을 2회 디스패치해 두 번째가 새 객체를 보는지 확인). 후속 토픽이 `ConnectionContext`나
 * 세션 바인딩에 LiveCharacter를 들고 있다가 **다른 명령**에서 읽으면 그 테스트는 그대로 통과한다.
 * 그런 캐시를 도입하려면 이 불변식을 먼저 다시 판단하라.
 *
 * 반환:
 *   - 성공 → `progress:trained{...}`(상태 이벤트, correlationId 없음 — world:room 선례).
 *   - 게임 규칙 거부 → `error{rule_rejected, message}`(id 있으면 correlationId 반향 — D-D).
 *   - 라이브 미등록 actor·방 미해소 → `error{internal}`(배선 격리 — 게임 규칙 거부와 구분).
 */
export function createTrainHandler(deps: TrainHandlerDeps): CommandHandler {
  return (command: ClientCommand, actor: ActorContext): ServerEvent | undefined => {
    // (1) defensive narrow — router는 progress:train type에만 이 핸들러를 배선하므로 false 갈래는
    //     구조적으로 도달 불가한 방어선이다.
    if (command.type !== 'progress:train') return undefined

    // (2) 라이브 캐릭터 단일 출처 조회. 미등록 actor는 연마 불가 — internal로 격리한다.
    const live = deps.liveRegistry.get(actor.characterId)
    if (live === undefined) {
      return makeErrorEvent('internal', '캐릭터 라이브 상태를 찾을 수 없습니다', command.id)
    }

    // (3) 현재 방 해소(by-character — currentRoom 단일 출처 경유). 그래프 미해소는 배선 오류다.
    const room = deps.resolveRoom(actor.characterId)
    if (room === undefined) {
      return makeErrorEvent('internal', '현재 방을 찾을 수 없습니다', command.id)
    }

    // (4) 게임 규칙 판정 일체를 train()에 위임한다. 성공 경로의 markCharacterDirty 1회 호출도
    //     train()의 finalize가 소유하므로 핸들러는 중복 마킹하지 않는다.
    const result = train(live.character, room, { markCharacterDirty: deps.markCharacterDirty })

    // (5) 거부 — 게임 규칙 거부(D-D). train()은 거부 시 마킹·변이 없이 bail한다.
    if (!result.ok) {
      return makeErrorEvent('rule_rejected', REJECT_MESSAGES[result.reason], command.id)
    }

    // (6) 성공 — 라이브 엔트리를 새 Character로 교체한 뒤 성장 결과를 통지한다.
    //     stats는 참조 그대로 싣는다(map/spread는 5-튜플을 number[]로 넓혀 와이어 계약을 깬다).
    deps.liveRegistry.register({ character: result.character })
    return {
      type: 'progress:trained',
      level: result.character.level,
      levelsGained: result.levelsGained,
      experience: result.character.experience,
      gold: result.character.gold,
      hpCurrent: result.character.hpCurrent,
      mpCurrent: result.character.mpCurrent,
      stats: result.character.stats,
      prestige: result.prestige,
    }
  }
}
