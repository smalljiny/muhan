/**
 * 저장 파이프라인 공용 logger seam.
 *
 * AsyncWriteQueue·SaveScheduler·SaveEngine이 폐기·실패를 기록할 때 쓰는 최소 인터페이스를
 * 단일 출처로 정의한다. 세 컴포넌트가 각자 동형(`error(context, message)`) 인터페이스를 로컬
 * 정의하던 중복을 제거하고, 하나의 `SaveLogger`·`NOOP_LOGGER`로 통합했다.
 *
 * console 금지(coding-style.md) — 프로덕션은 fastify app.log를 감싼 어댑터를 주입한다.
 * `NOOP_LOGGER`는 테스트 편의·조용한 방어용 기본값으로만 노출하며, AsyncWriteQueue는
 * 무흔적 폐기를 막기 위해 실제 logger 주입을 생성자에서 강제한다(NOOP는 명시 선택).
 */

/** 폐기·실패를 기록하는 최소 logger seam(console 금지). */
export interface SaveLogger {
  error(context: Record<string, unknown>, message: string): void
}

/**
 * 아무것도 하지 않는 logger. 생성자 기본값이 아니라 테스트 편의·조용한 방어용으로만 노출한다
 * (프로덕션은 실제 logger 주입이 필수 — 무흔적 폐기 방지).
 */
export const NOOP_LOGGER: SaveLogger = { error: () => undefined }
