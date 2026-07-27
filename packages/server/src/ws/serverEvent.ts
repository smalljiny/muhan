import type { ErrorCode, ServerEvent } from 'shared'

/**
 * error 이벤트 봉투를 만드는 단일 헬퍼 — 라우터·명령 핸들러가 공유한다.
 *
 * `correlationId`는 값이 있을 때만 키를 포함한다(undefined 키 금지). `id`는 빈 문자열도 유효하므로
 * truthiness가 아닌 `!== undefined`로 판별한다 — 이 미묘한 판별을 한 곳에 가둬 호출부마다 재구현하며
 * 빈 문자열 correlationId를 실수로 드롭하는 회귀를 막는다. `code`는 shared `ErrorCode` 전체를 받으며,
 * 각 호출부는 그 부분집합(라우터는 handshake_required 제외, move는 rule_rejected·internal)을 넘긴다.
 */
export function makeErrorEvent(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ServerEvent {
  if (correlationId !== undefined) {
    return { type: 'error', code, message, correlationId }
  }
  return { type: 'error', code, message }
}
