import type { ConnectionContext } from './connection.js'

/**
 * 세션 레지스트리 — `characterId → SessionBinding` 인메모리 색인(1캐릭터 1세션).
 *
 * `plugin.ts`의 소켓별 `Map<WebSocket, ConnectionContext>`와 **직교**한다 — 후자는 소켓→컨텍스트(transport),
 * 이 색인은 캐릭터→세션(도메인 수명)이다. 레지스트리는 소켓을 직접 참조하지 않고 `ConnectionContext`를
 * 가리켜, 재연결 시 참조만 교체한다. 순수 자료구조 + 주입 콜백만 쓰며 포트·소켓에 의존하지 않는다.
 *
 * **불변 바인딩**: 모든 상태 변경(live→link-dead, rebind)은 필드 변이가 아니라 **새 객체로 교체**한다.
 * 유일한 예외는 `markLinkDead`가 새 link-dead 객체를 map에 publish하기 전 `graceTimer` 슬롯을 한 번 채우는
 * 구성 단계다(아무도 아직 관찰하지 않으므로 공유 변이가 아니다). 이 때문에 `graceTimer`만 `readonly`가 아니다.
 *
 * **ABA-safe identity 가드**: stale 판별의 1차 불변식은 객체 identity(`get(characterId) === binding`)다.
 * grace 타이머·close 리스너는 자신을 스케줄한 시점의 바인딩 객체 참조를 캡처하고, 발화 시 이 identity를
 * 재확인한다. rebind/markLinkDead가 새 객체로 교체하므로 옛 객체를 캡처한 트리거는 identity 불일치로 no-op이다.
 */

/** 바인딩의 연결 상태 — live(소켓 정상) 또는 link-dead(grace 재연결 대기). */
export type LinkState = 'live' | 'link-dead'

/**
 * 종결 사유 — `register`의 evict-old가 쓰는 `evictedByNewLogin`(같은 캐릭터 재로그인)과, Story 4/5가 채우는
 * grace 만료·idle 종료 사유. Story 3의 `register`는 `evictedByNewLogin`만 발생시킨다.
 */
export type DisconnectReason = 'evictedByNewLogin' | 'graceExpired' | 'idleTimeout'

/** 등록된 기존 엔트리를 종결하는 주입 콜백. Story 4의 `resolveDisconnect`가 이 형태로 배선된다. */
export type TerminateCallback = (existing: SessionBinding, reason: DisconnectReason) => void

/**
 * link-dead 진입 시 grace 타이머를 거는 주입 콜백. 새 link-dead 바인딩 객체를 인자로 받아(그 객체를 캡처해
 * 만료 시 identity 판정 기준으로 삼는다) 타이머 핸들을 반환한다. Story 5가 fake clock 지원 setTimeout으로 배선한다.
 */
export type ScheduleGraceCallback = (deadBinding: SessionBinding) => NodeJS.Timeout

/**
 * 캐릭터 하나의 세션 바인딩. 도메인 수명(account/characterId/link) + 현재 연결 참조 + grace 타이머 슬롯.
 * `graceTimer`를 제외한 모든 필드는 불변이며, 상태 변경은 새 객체 교체로만 일어난다.
 */
export interface SessionBinding {
  readonly characterId: string
  readonly accountId: string
  readonly connection: ConnectionContext
  readonly link: LinkState
  /** link-dead 진입 시 건 grace 타이머 핸들(live면 null). 구성 단계 1회 채움만 허용(위 주석). */
  graceTimer: NodeJS.Timeout | null
}

/** 레지스트리 팩토리 옵션 — 타이머 clear 주입(미주입 시 전역 clearTimeout). deadline.ts 관례 미러. */
export interface SessionRegistryOptions {
  readonly clearTimeoutFn?: typeof clearTimeout
}

/** 세션 레지스트리 핸들. 색인 상태(Map)는 클로저에 캡슐화한다. */
export interface SessionRegistry {
  register(
    characterId: string,
    accountId: string,
    ctx: ConnectionContext,
    terminate: TerminateCallback,
  ): SessionBinding
  markLinkDead(binding: SessionBinding, scheduleGrace: ScheduleGraceCallback): SessionBinding | null
  rebind(binding: SessionBinding, newCtx: ConnectionContext): SessionBinding | null
  get(characterId: string): SessionBinding | undefined
  remove(characterId: string): void
}

/**
 * 세션 레지스트리를 만든다. 색인(Map)은 클로저에 캡슐화한다(deadline.ts의 createDeadline 관례 미러).
 * 타이머 clear는 주입 가능하며, 미주입 시 전역 clearTimeout을 쓴다(rebind의 grace 취소가 유일한 소비자).
 */
export function createSessionRegistry(opts: SessionRegistryOptions = {}): SessionRegistry {
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
  const index = new Map<string, SessionBinding>()

  function register(
    characterId: string,
    accountId: string,
    ctx: ConnectionContext,
    terminate: TerminateCallback,
  ): SessionBinding {
    const existing = index.get(characterId)
    if (existing !== undefined) {
      // 기존 엔트리(live·link-dead 무관)를 먼저 종결한다 — 포트 1회 + graceTimer clear(누수 방지).
      terminate(existing, 'evictedByNewLogin')
    }
    // 순서 load-bearing: terminate가 fresh 엔트리를 지우지 않도록 set을 terminate '뒤'에 둔다.
    const binding: SessionBinding = {
      characterId,
      accountId,
      connection: ctx,
      link: 'live',
      graceTimer: null,
    }
    index.set(characterId, binding)
    ctx.boundCharacterId = characterId
    return binding
  }

  function markLinkDead(
    binding: SessionBinding,
    scheduleGrace: ScheduleGraceCallback,
  ): SessionBinding | null {
    // identity 가드: 넘어온 binding이 현재 map 엔트리와 동일할 때만 진행(전이 전 옛 객체는 no-op).
    if (index.get(binding.characterId) !== binding) return null
    // 필드 변이 없이 새 link-dead 객체로 교체한다.
    const deadBinding: SessionBinding = {
      ...binding,
      link: 'link-dead',
      graceTimer: null,
    }
    // scheduleGrace가 이 '새' 객체(deadBinding)를 캡처해 만료 시 identity 판정 기준으로 삼는다.
    // 반환된 타이머 핸들을 publish 전에 슬롯에 1회 채운다 — map에 아직 없어 아무도 관찰 못 하므로 공유 변이가 아니다.
    // deadBinding이 곧 map.set될 그 객체 자체여야(=== 동일) Story 5의 grace 콜백 identity 가드가 성립한다.
    deadBinding.graceTimer = scheduleGrace(deadBinding)
    index.set(binding.characterId, deadBinding)
    return deadBinding
  }

  function rebind(binding: SessionBinding, newCtx: ConnectionContext): SessionBinding | null {
    // identity 가드: stale(현재 map 엔트리와 불일치)이면 null — 호출자는 fresh register로 폴백한다.
    if (index.get(binding.characterId) !== binding) return null
    if (binding.graceTimer !== null) clearTimeoutFn(binding.graceTimer)
    // 새 live 객체로 교체하고 새 연결을 가리킨다(재로드 없이 참조만 교체).
    const newBinding: SessionBinding = {
      ...binding,
      connection: newCtx,
      link: 'live',
      graceTimer: null,
    }
    index.set(binding.characterId, newBinding)
    newCtx.boundCharacterId = binding.characterId
    return newBinding
  }

  function get(characterId: string): SessionBinding | undefined {
    return index.get(characterId)
  }

  function remove(characterId: string): void {
    index.delete(characterId)
  }

  return { register, markLinkDead, rebind, get, remove }
}
