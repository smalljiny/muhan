/**
 * 파싱된 WS 프레임(unknown)에서 필드를 안전하게 읽는 공용 primitive.
 *
 * 핸드셰이크·라우터가 payload 스키마 검증 이전 단계에서 `type`·`id`·`protocolVersion` 같은 필드를
 * 방어적으로 꺼낼 때 공유한다. null 가드는 load-bearing이다 — 없으면 `key in null`이 message 핸들러
 * 안에서 throw한다. `key`는 호출부의 리터럴이라 동적 키 주입 표면이 아니다.
 */

/** 파싱된 프레임에서 고정 키 필드를 꺼낸다. 객체가 아니거나 null이거나 키가 없으면 undefined. */
export function readField(parsed: unknown, key: string): unknown {
  if (typeof parsed !== 'object' || parsed === null || !(key in parsed)) return undefined
  return (parsed as Record<string, unknown>)[key]
}

/** 파싱된 프레임에서 문자열 필드를 꺼낸다. 값이 문자열이 아니면 undefined(빈 문자열은 유효). */
export function readStringField(parsed: unknown, key: string): string | undefined {
  const value = readField(parsed, key)
  return typeof value === 'string' ? value : undefined
}
