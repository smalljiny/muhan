import { clientCommandSchema, type ClientCommand, type ErrorCode, type ServerEvent } from 'shared'
import { echoHandler } from './handlers/echo.js'
import { createChatHandler } from './handlers/chat.js'
import { readStringField } from './frame.js'
import type { ActorContext } from './actorContext.js'
import type { ChannelPort } from './channelPort.js'

/**
 * 검증된 명령을 소비해 응답 이벤트(또는 응답 없음=undefined)를 계산하는 핸들러.
 *
 * 핸들러는 `clientCommandSchema`로 이미 검증된 `ClientCommand`만 받는다(payload 재검증 불필요).
 * `actor`는 이 명령을 실행하는 행위자 컨텍스트로, 권한·게임 규칙 판정 핸들러(Story 2~3)가 소비한다.
 * 무권한 핸들러(echo)는 actor를 받되 무시한다. fire-and-forget 명령은 undefined를 반환한다.
 */
export type CommandHandler = (command: ClientCommand, actor: ActorContext) => ServerEvent | undefined

/** type 리터럴 → 핸들러 레지스트리. 반드시 실제 `Map`이라 prototype-chain 키에도 안전하다. */
export type HandlerRegistry = Map<string, CommandHandler>

/**
 * 기본 명령 레지스트리를 만든다 — 무인증 `debug:echo`와 자유채팅 `chat:message`·`chat:emote`를 배선한다.
 *
 * plain object가 아닌 `Map`을 쓰는 것이 load-bearing이다: `registry.get('__proto__')`는
 * prototype 속성에 도달하지 않고 undefined를 반환해 allowlist 우회를 원천 차단한다.
 *
 * `channelPort`는 채팅 핸들러가 발화를 핸드오프할 채널 전달 포트다 — 팩토리는 어댑터를 소유하지 않고
 * 필수 파라미터로 받는다(기본 어댑터 소유·주입은 registerWebsocket 책임). 같은 핸들러 인스턴스를
 * chat:message·chat:emote 두 type에 공유 배선한다(핸들러가 내부에서 type을 narrow한다).
 *
 * 레지스트리는 의도적으로 `clientCommandSchema`보다 좁은 런타임 디스패치 집합이다. `system:ready`는
 * 스키마에 있으나 핸드셰이크(handleHandshakeFrame)가 `pass` 이전에 소비하므로 여기 등록하지 않는다.
 * 주의: `clientCommandSchema`에 없는 type의 핸들러를 등록하면 safeParse가 그 discriminator를 매칭하지
 * 못해 해당 명령이 영구히 bad_payload로 떨어진다 — 신규 핸들러는 반드시 스키마에도 variant를 추가한다.
 */
export function createCommandRegistry(channelPort: ChannelPort): HandlerRegistry {
  const chatHandler = createChatHandler(channelPort)
  return new Map<string, CommandHandler>([
    ['debug:echo', echoHandler],
    ['chat:message', chatHandler],
    ['chat:emote', chatHandler],
  ])
}

/**
 * `dispatch`의 반환 타입 — 셸이 idle rearm 여부를 판단할 근거를 라우터가 명시 반환한다.
 *
 * `handled`는 정상 디스패치(핸들러가 이벤트를 냈거나 fire-and-forget으로 undefined를 낸 경우)를,
 * `rejected`는 라우팅 레이어가 요청을 거부한 경우(unknown_type·bad_payload·internal)를 뜻한다.
 * `rejected`는 항상 `event`(error 이벤트)를 동반한다.
 */
export type DispatchResult =
  { outcome: 'handled'; event?: ServerEvent } | { outcome: 'rejected'; event: ServerEvent }

/** 라우터가 낼 수 있는 오류 코드 — 핸드셰이크 전용 `handshake_required`를 뺀 shared enum의 부분집합. */
type RouterErrorCode = Exclude<ErrorCode, 'handshake_required'>

/** 오류 이벤트를 만든다. `correlationId`는 값이 있을 때만 키를 포함한다(undefined 키 금지). */
function errorEvent(
  code: RouterErrorCode,
  message: string,
  correlationId: string | undefined,
): ServerEvent {
  if (correlationId !== undefined) {
    return { type: 'error', code, message, correlationId }
  }
  return { type: 'error', code, message }
}

/**
 * 핸드셰이크를 통과한 프레임을 레지스트리로 O(1) 디스패치한다(순수 함수 — 부수효과 없음).
 *
 * 레이어링은 distinct error code를 강제하기 위해 순서가 load-bearing이다:
 * 1. `registry.get(type)` 실패 → unknown_type: allowlist 가드(미등록/미지 type 차단, prototype 방어).
 * 2. `clientCommandSchema.safeParse` 실패 → bad_payload: 등록된 type이지만 payload 위반.
 *    discriminator가 등록 type임을 확인한 뒤 파싱하므로 정확히 그 variant를 검증한다(shared 계약 단일 출처).
 * 3. `handler` throw → internal: 핸들러 예외를 격리해 소켓을 생존시킨다.
 *
 * `id`는 type 판별 직후 payload 검증 이전에 추출해, bad_payload·internal 응답도 상관 키를 실어
 * 클라이언트가 실패를 상관지을 수 있게 한다. unknown_type은 type 판별 이전이라 상관 키를 싣지 않는다.
 *
 * 반환값은 `DispatchResult`다 — 핸들러가 성공(이벤트 또는 fire-and-forget undefined)하면 `handled`,
 * 라우팅 레이어가 거부(unknown_type·bad_payload·internal)하면 `rejected`를 태그해 셸이 idle rearm
 * 여부를 이 태그만으로 판단할 수 있게 한다.
 *
 * `actor`는 이 명령을 실행하는 행위자 컨텍스트다. dispatch는 actor를 해석하지 않고 검증 통과 후
 * 핸들러에 그대로 전달만 한다(권한·규칙 판정은 핸들러 책임 — Story 2~3).
 */
export function dispatch(
  registry: HandlerRegistry,
  parsed: unknown,
  actor: ActorContext,
): DispatchResult {
  const type = readStringField(parsed, 'type')
  if (type === undefined) {
    return {
      outcome: 'rejected',
      event: errorEvent('unknown_type', '알 수 없는 명령 type이다', undefined),
    }
  }

  const handler = registry.get(type)
  if (handler === undefined) {
    return {
      outcome: 'rejected',
      event: errorEvent('unknown_type', `등록되지 않은 명령 type이다: ${type}`, undefined),
    }
  }

  // 상관 키 `id`는 payload 검증 이전에 추출한다(빈 문자열도 유효 → typeof로 판별). 그래야
  // bad_payload·internal 응답도 상관 키를 실어 클라이언트가 실패를 상관지을 수 있다.
  const correlationId = readStringField(parsed, 'id')

  const parseResult = clientCommandSchema.safeParse(parsed)
  if (!parseResult.success) {
    return {
      outcome: 'rejected',
      event: errorEvent('bad_payload', '명령 payload 형식이 올바르지 않다', correlationId),
    }
  }

  try {
    return { outcome: 'handled', event: handler(parseResult.data, actor) }
  } catch {
    // 핸들러 예외를 이벤트로 격리한다(기존 JSON.parse try/catch 미러). 원인은 클라이언트에 노출하지 않는다.
    return {
      outcome: 'rejected',
      event: errorEvent('internal', '명령 처리 중 서버 오류가 발생했다', correlationId),
    }
  }
}
