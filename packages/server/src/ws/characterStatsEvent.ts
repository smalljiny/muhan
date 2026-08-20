import { resolveHpMax, resolveMpMax, type Character, type ServerEvent } from 'shared'

/** `character:stats` 이벤트 — 와이어 계약에서 파생한다(수기 재선언 금지, `RoomView` 선례). */
export type CharacterStatsEvent = Extract<ServerEvent, { type: 'character:stats' }>

/**
 * 캐릭터 문서를 `character:stats` 스냅샷 이벤트로 투영한다. 입력을 변형하지 않는 순수 함수다.
 *
 * ## 왜 핸들러가 아니라 별도 모듈인가
 * 이 이벤트는 전투 전용이 아니라 **스탯이 바뀌는 모든 명령**(공격·훈련·연마)이 공유하는 통일
 * 통지 경로다(스펙 D10). 첫 소비자인 attack 핸들러 안에 두면 다음 소비자가 그 핸들러를 import하게
 * 되어(명령 핸들러끼리 결합) 배선 그래프가 꼬이거나, 결합을 피하려고 각자 투영을 복사해 같은
 * 이벤트의 파생 규칙이 갈린다. 생산자를 여기 하나로 둔다.
 *
 * ## 문서 값 4 + 파생 값 2
 * `hpCurrent`·`mpCurrent`·`experience`·`level`은 캐릭터 문서에서 그대로 옮긴다. 반면 `hpMax`·`mpMax`는
 * 문서에 없다 — `progression/maxResolvers`의 compute-on-read 계약대로 `class`·`level`에서 매번
 * 파생한다(저장하지 않는다). 폐형과 CARETAKER 오버라이드는 그 모듈이 단독으로 소유하므로 여기서
 * 산술을 재구현하지 않는다.
 *
 * ⚠ **호출자가 넘기는 문서가 곧 이벤트의 진실이다.** 상태를 바꾼 뒤 갱신 **이전** 문서를 넘기면
 * 클라이언트는 한 박자 뒤처진 스냅샷을 받는다. 델타가 아니라 스냅샷이라 다음 통지에서 수렴하지만,
 * 그 사이 화면은 틀린 값을 보여준다.
 */
export function characterStatsEvent(character: Character): CharacterStatsEvent {
  return {
    type: 'character:stats',
    hpCurrent: character.hpCurrent,
    hpMax: resolveHpMax(character),
    mpCurrent: character.mpCurrent,
    mpMax: resolveMpMax(character),
    experience: character.experience,
    level: character.level,
  }
}
