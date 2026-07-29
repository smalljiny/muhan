import { clientCommandSchema, type ClientCommand, type ServerEvent } from 'shared'
import { echoHandler } from './handlers/echo.js'
import { createChatHandler } from './handlers/chat.js'
import { createMoveHandler, type MoveHandlerDeps } from './handlers/move.js'
import { readStringField } from './frame.js'
import { makeErrorEvent } from './serverEvent.js'
import type { ActorContext } from './actorContext.js'
import type { ChannelPort } from './channelPort.js'
import type { PermissionPort } from './permissionPort.js'

/**
 * 검증된 명령을 소비해 응답 이벤트(또는 응답 없음=undefined)를 계산하는 핸들러.
 *
 * 핸들러는 `clientCommandSchema`로 이미 검증된 `ClientCommand`만 받는다(payload 재검증 불필요).
 * `actor`는 이 명령을 실행하는 행위자 컨텍스트다. 권한 판정은 dispatch의 `PermissionPort` 레이어가
 * 핸들러 진입 전에 끝내므로(Story 3), 핸들러는 통과한 명령의 게임 규칙 판정(자원 소모·상태 전이 등)에만
 * actor를 쓴다. 무권한 핸들러(echo)는 actor를 받되 무시한다. fire-and-forget 명령은 undefined를 반환한다.
 */
export type CommandHandler = (command: ClientCommand, actor: ActorContext) => ServerEvent | undefined

/** type 리터럴 → 핸들러 레지스트리. 반드시 실제 `Map`이라 prototype-chain 키에도 안전하다. */
export type HandlerRegistry = Map<string, CommandHandler>

/**
 * 조건부 등록 명령의 deps 번들 — 명령 하나당 필드 하나다.
 *
 * 명령이 늘 때마다 팩토리에 optional 위치 파라미터를 덧붙이면 호출부가 인자 순서에 결합되고
 * 중간 명령만 미주입하려면 `undefined` 자리 채우기가 필요해진다. 필드 번들은 그 결합을 끊는다 —
 * 호출부는 배선할 명령의 필드만 채우고, 필드가 없으면 그 명령은 미등록으로 남는다.
 *
 * 모든 필드가 optional이라 번들 자체도 optional이다(무-deps 호출부는 1-인자 형태 그대로).
 */
export interface GameCommandDeps {
  readonly move?: MoveHandlerDeps
}

/**
 * 기본 명령 레지스트리를 만든다 — 무인증 `debug:echo`와 자유채팅 `chat:message`·`chat:emote`를 배선하고,
 * `deps.move`가 주어지면 `world:move`도 배선한다.
 *
 * plain object가 아닌 `Map`을 쓰는 것이 load-bearing이다: `registry.get('__proto__')`는
 * prototype 속성에 도달하지 않고 undefined를 반환해 allowlist 우회를 원천 차단한다.
 *
 * `channelPort`는 채팅 핸들러가 발화를 핸드오프할 채널 전달 포트다 — 팩토리는 어댑터를 소유하지 않고
 * 필수 파라미터로 받는다(기본 어댑터 소유·주입은 registerWebsocket 책임). 같은 핸들러 인스턴스를
 * chat:message·chat:emote 두 type에 공유 배선한다(핸들러가 내부에서 type을 narrow한다).
 *
 * `deps`는 조건부 등록 명령의 deps 번들이다(`GameCommandDeps` — 명령 하나당 필드 하나). `deps.move`는
 * 라이브 레지스트리·이동 seam·markDirty가 배선된 환경(실 서버)에서만 주입되며, 주어지면 `world:move`를
 * move 핸들러로 등록한다. 미주입이면 world:move는 미등록으로 남아 dispatch가 unknown_type을 반환한다
 * (방 배치·영속 seam이 아직 없는 컨텍스트에서의 기본 동작). 이 조건부 배선으로 기존 무-deps 호출부
 * (라우터 순수 단위 테스트 등)의 동작이 변하지 않는다.
 *
 * 레지스트리는 의도적으로 `clientCommandSchema`보다 좁은 런타임 디스패치 집합이다. `system:ready`는
 * 스키마에 있으나 핸드셰이크(handleHandshakeFrame)가 `pass` 이전에 소비하므로 여기 등록하지 않는다.
 * 주의: `clientCommandSchema`에 없는 type의 핸들러를 등록하면 safeParse가 그 discriminator를 매칭하지
 * 못해 해당 명령이 영구히 bad_payload로 떨어진다 — 신규 핸들러는 반드시 스키마에도 variant를 추가한다.
 */
export function createCommandRegistry(
  channelPort: ChannelPort,
  deps?: GameCommandDeps,
): HandlerRegistry {
  const chatHandler = createChatHandler(channelPort)
  const registry = new Map<string, CommandHandler>([
    ['debug:echo', echoHandler],
    ['chat:message', chatHandler],
    ['chat:emote', chatHandler],
  ])
  if (deps?.move !== undefined) {
    registry.set('world:move', createMoveHandler(deps.move))
  }
  return registry
}

/**
 * `dispatch`의 반환 타입 — 셸이 idle rearm 여부를 판단할 근거를 라우터가 명시 반환한다.
 *
 * `handled`는 정상 디스패치(핸들러가 이벤트를 냈거나 fire-and-forget으로 undefined를 낸 경우)를,
 * `rejected`는 라우팅 레이어가 요청을 거부한 경우(unknown_type·bad_payload·forbidden·internal)를 뜻한다.
 * `rejected`는 항상 `event`(error 이벤트)를 동반한다.
 */
export type DispatchResult =
  { outcome: 'handled'; event?: ServerEvent } | { outcome: 'rejected'; event: ServerEvent }


/**
 * 핸드셰이크를 통과한 프레임을 레지스트리로 O(1) 디스패치한다(순수 함수 — 부수효과 없음).
 *
 * 레이어링은 distinct error code를 강제하기 위해 순서가 load-bearing이다:
 * 1. `registry.get(type)` 실패 → unknown_type: allowlist 가드(미등록/미지 type 차단, prototype 방어).
 * 2. `clientCommandSchema.safeParse` 실패 → bad_payload: 등록된 type이지만 payload 위반.
 *    discriminator가 등록 type임을 확인한 뒤 파싱하므로 정확히 그 variant를 검증한다(shared 계약 단일 출처).
 * 3. `permission.check` false → forbidden: 검증된 명령이나 actor가 실행 자격이 없다(safeParse 성공
 *    후·handler 전에 검사 — 검증된 명령만 권한 판정에 넘긴다). E3 permissive 어댑터는 항상 allow라 inert다.
 * 4. `permission.check`·`handler` throw → internal: permission 판정 또는 핸들러 예외를 같은 격리 경계에서
 *    잡아 소켓을 생존시킨다(check가 false를 반환하면 forbidden, throw하면 internal로 구분).
 *
 * `id`는 type 판별 직후 payload 검증 이전에 추출해, bad_payload·forbidden·internal 응답도 상관 키를 실어
 * 클라이언트가 실패를 상관지을 수 있게 한다. unknown_type은 type 판별 이전이라 상관 키를 싣지 않는다.
 *
 * 반환값은 `DispatchResult`다 — 핸들러가 성공(이벤트 또는 fire-and-forget undefined)하면 `handled`,
 * 라우팅 레이어가 거부(unknown_type·bad_payload·forbidden·internal)하면 `rejected`를 태그해 셸이 idle
 * rearm 여부를 이 태그만으로 판단할 수 있게 한다.
 *
 * `actor`는 이 명령을 실행하는 행위자 컨텍스트다. dispatch는 `permission`으로 actor의 명령 실행 자격을
 * 게이트한 뒤(권한 판정은 dispatch 레이어 책임 — Story 3), 통과한 명령만 핸들러에 그대로 전달한다.
 * 게임 규칙 판정(자원 소모·상태 전이 등)은 여전히 핸들러 책임이다.
 */
export function dispatch(
  registry: HandlerRegistry,
  parsed: unknown,
  actor: ActorContext,
  permission: PermissionPort,
): DispatchResult {
  const type = readStringField(parsed, 'type')
  if (type === undefined) {
    return {
      outcome: 'rejected',
      event: makeErrorEvent('unknown_type', '알 수 없는 명령 type이다', undefined),
    }
  }

  const handler = registry.get(type)
  if (handler === undefined) {
    return {
      outcome: 'rejected',
      event: makeErrorEvent('unknown_type', `등록되지 않은 명령 type이다: ${type}`, undefined),
    }
  }

  // 상관 키 `id`는 payload 검증 이전에 추출한다(빈 문자열도 유효 → typeof로 판별). 그래야
  // bad_payload·internal 응답도 상관 키를 실어 클라이언트가 실패를 상관지을 수 있다.
  const correlationId = readStringField(parsed, 'id')

  const parseResult = clientCommandSchema.safeParse(parsed)
  if (!parseResult.success) {
    return {
      outcome: 'rejected',
      event: makeErrorEvent('bad_payload', '명령 payload 형식이 올바르지 않다', correlationId),
    }
  }

  // 권한 레이어와 handler를 같은 격리 경계 안에서 실행한다 — dispatch의 containment 계약(라우팅 레이어의
  // 거부는 항상 DispatchResult로 반환, 예외 누출 없음)을 permission.check에도 확장한다. E3 permissive
  // 어댑터는 throw하지 않지만, E5의 실 RBAC 어댑터는 저장소 타임아웃·stale actor 등으로 throw할 수 있다 —
  // 그 예외가 dispatch를 탈출하면 correlationId를 잃고 셸의 일반 catch로 떨어지므로, 여기서 internal로
  // 격리해 상관 키를 실어 반환한다(handler throw와 동일 처리). check가 정상적으로 false를 반환하면
  // forbidden(자격 없음)으로, throw하면 internal(판정 실패)로 구분한다.
  try {
    // 권한 판정: 검증된 명령(parseResult.data)만 넘긴다(raw parsed 아님 — 검증된 명령만 자격을 판정한다).
    // safeParse 성공 후·handler 전에 위치해, 자격 없는 actor의 유효 명령을 handler에 도달시키지 않는다.
    // E3 permissive 어댑터는 항상 allow라 이 레이어는 inert다.
    if (!permission.check(parseResult.data, actor)) {
      return {
        outcome: 'rejected',
        event: makeErrorEvent('forbidden', '이 명령을 실행할 권한이 없다', correlationId),
      }
    }
    return { outcome: 'handled', event: handler(parseResult.data, actor) }
  } catch {
    // permission.check·handler 예외를 이벤트로 격리한다. 원인은 클라이언트에 노출하지 않는다.
    return {
      outcome: 'rejected',
      event: makeErrorEvent('internal', '명령 처리 중 서버 오류가 발생했다', correlationId),
    }
  }
}
