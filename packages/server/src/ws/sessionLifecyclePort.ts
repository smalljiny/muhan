import type { DisconnectReason } from './sessionRegistry.js'

/**
 * 세션 수명 포트 — 세션이 종결될 때 도메인이 소유하는 후처리 어휘의 단일 계약.
 *
 * 이 인터페이스는 Mongo·파일 저장 API를 표현하지 않는다. 게임 세션 도메인 언어(세션 종료 사실 +
 * 종결 사유)로만 표현하며, 실 영속화(캐릭터 세이브 flush·last-seen 기록 등)는 포트 뒤 어댑터 교체로
 * 붙는다(DIP seam). E4/E5에서 실 저장 어댑터가 이 포트를 구현한다 — 여기(E3)에는 실 저장을 두지 않고
 * no-op 로깅 어댑터로만 만족한다. sessionAuthPort.ts의 seam 관례를 미러한다.
 *
 * 동기 시그니처: no-op stub이라 onSessionEnd가 Promise를 반환하지 않는다. E4/E5의 실 어댑터는 DB I/O로
 * async가 필요하므로, 그 시점에 포트를 `Promise<void>` 반환으로 확장하고 호출부(resolveDisconnect)를
 * await로 조정한다. 지금은 async seam을 주석으로만 남기고 동기로 유지한다.
 *
 * `DisconnectReason`은 재정의하지 않고 sessionRegistry.ts에서 import한다(종결 사유의 단일 출처).
 */

/** 세션 종료 사실을 전달하는 도메인 컨텍스트 — 최소 식별 필드 + 종결 사유. */
export interface SessionEndContext {
  readonly accountId: string
  readonly characterId: string
  readonly reason: DisconnectReason
}

/**
 * 세션 수명 포트 계약. 구현체는 자체 저장소·로거를 생성자로 소유한다(서비스 로케이터·전역 싱글턴 금지).
 * resolveDisconnect가 세션 종결 시 정확히 1회 호출한다(멱등성은 호출부의 identity 가드가 보장).
 */
export interface SessionLifecyclePort {
  /** 세션이 종결됐음을 통지한다. 실패해도 transport teardown을 막지 않도록 호출부가 catch한다. */
  onSessionEnd(ctx: SessionEndContext): void
}
