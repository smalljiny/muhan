// 서버 오류 수명 분류표와 일시 오류 해제 이벤트 집합 — 순수 데이터 모듈.
// transient 오류는 본인 조작 성공·진입 대화의 새 단계를 알리는 이벤트가 오면 지우고,
// sticky 오류(권한 계열)는 사용자가 직접 닫을 때까지 남긴다.
//
// - 두 표는 Record<ErrorCode, …>·Record<ServerEvent['type'], …>로 선언해, shared 프로토콜에 오류
//   코드나 이벤트 타입이 추가되면 분류하지 않은 키가 컴파일 오류로 드러나게 한다(스펙 OQ3).
// - combat:attacked는 지금 요청 소켓에만 돌아가는 본인 공격 결과라 해제 이벤트로 둔다. 다른 점유자의
//   공격 통지(방 전파)에도 쓰이게 되면 본인 공격과 구분할 기준을 두고 이 분류를 다시 판단한다(스펙 OQ2).

import type { ErrorCode, ServerEvent } from 'shared/protocol'

export type ErrorLifetime = 'transient' | 'sticky'

export const ERROR_LIFETIME: Readonly<Record<ErrorCode, ErrorLifetime>> = {
  handshake_required: 'transient',
  unknown_type: 'transient',
  bad_payload: 'transient',
  internal: 'transient',
  unauthorized: 'sticky',
  session_state: 'transient',
  forbidden: 'sticky',
  rate_limited: 'transient',
  rule_rejected: 'transient',
}

export const CLEARS_TRANSIENT_ERROR: Readonly<Record<ServerEvent['type'], boolean>> = {
  // 이동 성공·방 진입.
  'world:room': true,
  // 진입 대화의 새 단계 시작(생성 진행·재연결 직후 선택 프롬프트 모두).
  'session:prompt': true,
  // 진입 성공.
  'session:entered': true,
  // 재개 성공.
  'session:resumed': true,
  // 수련 성공.
  'progress:trained': true,
  // 학습 성공.
  'progress:studied': true,
  // 본인 공격 성공 — 요청 소켓에만 돌아가는 본인 공격 결과(OQ2 참조).
  'combat:attacked': true,
  // 다른 플레이어가 일으키는 통지라 자신의 조작 결과가 아니다.
  'world:presence': false,
  'chat:said': false,
  // 재생 틱 등 조작과 무관한 경로에서도 오는 상태 동기화다. 공격 성공은 함께 오는 combat:attacked가 해제를 맡는다.
  'character:stats': false,
  // 핸드셰이크 응답이다.
  'system:hello': false,
  // 재연결·재동기 지시 통지다.
  'system:reload': false,
  // 진단용 echo 응답이다.
  'debug:echo:result': false,
  // 목록 데이터일 뿐 성공 신호가 아니다.
  'session:characterList': false,
  // 오류 자체다.
  error: false,
}

/** 사용자가 닫을 때까지 남아야 하는 오류 코드인지 판정한다. */
export function isStickyError(code: ErrorCode): boolean {
  return ERROR_LIFETIME[code] === 'sticky'
}

/** 이 이벤트 수신이 남아 있는 transient 오류를 해제하는지 판정한다. */
export function clearsTransientError(type: ServerEvent['type']): boolean {
  return CLEARS_TRANSIENT_ERROR[type]
}
