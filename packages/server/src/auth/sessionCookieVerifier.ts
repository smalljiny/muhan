/**
 * 세션 쿠키 검증 seam — DIP 경계 함수 타입.
 *
 * 이 타입이 어댑터와 firebase-admin 사이의 유일한 결합점이다. FirebaseSessionAuthAdapter는
 * 이 함수에만 의존하며 firebase-admin을 직접 import하지 않는다 — 실제 firebase-admin 기반
 * verifier(verifySessionCookie 래핑)는 부팅 시점(Story 7)에 조립돼 어댑터에 주입된다.
 *
 * 계약: 쿠키가 유효하면 계정 UID를 담은 { uid }를 resolve, 무효면 null을 resolve한다.
 * 검증 실패를 throw로 표현하는 백엔드(firebase-admin은 만료·위조 시 throw)도 있으므로,
 * 어댑터가 throw를 null과 동일하게 취급(swallow)한다.
 */
export type SessionCookieVerifier = (cookie: string) => Promise<{ uid: string } | null>
