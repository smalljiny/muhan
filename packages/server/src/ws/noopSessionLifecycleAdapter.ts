import type { SessionLifecyclePort } from './sessionLifecyclePort.js'

/**
 * SessionLifecyclePort의 no-op 로깅 구현.
 *
 * mock이 아니라 실제 어댑터다 — 세션 종결을 로깅만 하고 저장 I/O는 하지 않는다(E4/E5가 실 영속화로
 * 교체한다). 생성자 주입 관례(전역 싱글턴을 조회하지 않는다)로 로거를 받아 소유한다.
 * inMemorySessionAuthAdapter.ts의 seam 관례를 미러한다.
 */

/** 어댑터가 의존하는 최소 로거 표면. Fastify의 app.log(pino)가 구조적으로 충족한다. */
export interface LifecycleLogger {
  info(obj: object, msg: string): void
}

/**
 * no-op 세션 수명 어댑터를 만든다. onSessionEnd는 종결 사실만 구조 로깅하고 즉시 반환한다.
 * accountId·characterId·reason은 PII가 아니라 도메인 식별자이므로 마스킹 없이 로깅한다.
 */
export function createNoopSessionLifecycleAdapter(logger: LifecycleLogger): SessionLifecyclePort {
  return {
    onSessionEnd(ctx) {
      logger.info(
        { accountId: ctx.accountId, characterId: ctx.characterId, reason: ctx.reason },
        'session ended (no-op persistence)',
      )
    },
  }
}
