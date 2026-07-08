import type { ServerEvent } from 'shared'
import type { ConnectionContext } from './connection.js'
import { readField, readStringField } from './frame.js'

/**
 * 핸드셰이크 프레임 처리 결과 — message 핸들러가 수행할 부수효과를 순수 함수로 기술한 명령.
 *
 * 순수 함수 `handleHandshakeFrame`이 상태 전이를 계산하고, message 핸들러가 이 결과를 해석해
 * I/O(전송·close)·상태 변이(`ctx.ready = true`)를 실행한다. 분리 덕에 상태 전이표를 소켓 없이 단위 검증한다.
 */
export type HandshakeResult =
  | { readonly action: 'accept' }
  | { readonly action: 'pass' }
  | { readonly action: 'error'; readonly event: ServerEvent }
  | { readonly action: 'reload'; readonly event: ServerEvent }

/**
 * 1회 버전 협상 핸드셰이크의 상태 전이를 계산한다(순수 함수 — 부수효과 없음).
 *
 * 상태 전이표(malformed JSON은 호출 전에 message 핸들러가 bad_payload로 걸러 여기 도달하지 않는다):
 * - ready + system:ready(중복) → error(handshake_required): 핸드셰이크는 연결당 1회, 첫 메시지로만 유효.
 * - ready + 그 외 → pass: 핸드셰이크 완료 후 프레임은 셸이 세션 상태로 라우팅한다(command 상태면 라우터, 그 이전 상태면 세션 FSM).
 * - pre-ready + system:ready 아님 → error(handshake_required): 핸드셰이크 전 명령 거부.
 * - pre-ready + system:ready + 버전 정확 일치 → accept: `ctx.ready`를 true로 전이시켜야 한다는 신호.
 * - pre-ready + system:ready + 버전 불일치 → reload: system:reload push 후 소켓 close 신호.
 *
 * 버전 대조는 서버 권위 정확 비교(`client === ctx.protocolVersion`)다. 누락·문자열·소수 등 어떤
 * 불일치도 reload 경로로 보낸다(clientCommandSchema 전체 파싱은 Story 6 라우터의 몫).
 */
export function handleHandshakeFrame(ctx: ConnectionContext, parsed: unknown): HandshakeResult {
  const type = readStringField(parsed, 'type')

  if (ctx.ready) {
    if (type === 'system:ready') {
      return {
        action: 'error',
        event: {
          type: 'error',
          code: 'handshake_required',
          message: '핸드셰이크는 연결당 한 번, 첫 메시지로만 유효하다',
        },
      }
    }
    return { action: 'pass' }
  }

  if (type !== 'system:ready') {
    return {
      action: 'error',
      event: {
        type: 'error',
        code: 'handshake_required',
        message: '먼저 system:ready로 핸드셰이크를 완료하라',
      },
    }
  }

  // 서버 권위 정확 비교(강제 변환 없음). 누락·문자열·소수 등 어떤 불일치도 reload로 보낸다.
  // 의도적 설계: 핸드셰이크는 type+버전만 게이트하고 `clientCommandSchema` strict 파싱을 돌리지 않는다.
  // 계약 밖 여분 필드가 실려도 ready로 전이하나, ready 이후 모든 프레임은 셸이 세션 상태로 라우팅해
  // clientCommandSchema로 strict 검증하므로(command 상태면 라우터 dispatch, 그 이전 상태면 세션 FSM decider)
  // 우회 표면이 없다. 여기서 strict 파싱하면 "문자열/누락 protocolVersion → reload"
  // 계약이 bad_payload로 바뀌어(handshake.test.ts) 버전 협상 의미가 달라진다 — 그래서 type-only 게이트를 유지한다.
  if (readField(parsed, 'protocolVersion') === ctx.protocolVersion) {
    return { action: 'accept' }
  }

  return {
    action: 'reload',
    event: {
      type: 'system:reload',
      reason: `프로토콜 버전이 서버(${ctx.protocolVersion})와 일치하지 않는다`,
    },
  }
}
