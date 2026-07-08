import type { ClientCommand, ServerEvent } from 'shared'

/**
 * 무인증·무권한 진단 핸들러 — `debug:echo{text, id?}`를 `debug:echo:result{text, correlationId?}`로 되돌린다.
 *
 * 라우터가 이미 discriminator를 판별하고 `clientCommandSchema`로 payload를 검증한 뒤에만 호출하므로,
 * 여기서 payload를 수기 재검증하지 않는다. type narrowing은 union을 좁히기 위한 것이며, 라우터가
 * `debug:echo` type에만 이 핸들러를 배선하므로 false 갈래는 구조적으로 도달 불가한 방어선이다.
 * `id`가 있을 때만 `correlationId` 키를 실어 클라이언트가 요청·응답을 상관지을 수 있게 한다
 * (`id`는 빈 문자열도 유효하므로 truthiness가 아닌 `!== undefined`로 판별한다).
 */
export function echoHandler(command: ClientCommand): ServerEvent | undefined {
  if (command.type !== 'debug:echo') return undefined
  if (command.id !== undefined) {
    return { type: 'debug:echo:result', text: command.text, correlationId: command.id }
  }
  return { type: 'debug:echo:result', text: command.text }
}
