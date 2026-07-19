import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import type { SessionCookieVerifier } from './sessionCookieVerifier.js'

/**
 * firebase-admin 기반 SessionCookieVerifier 팩토리 — 어댑터와 firebase-admin 사이의 유일한 결합점이다.
 *
 * FirebaseSessionAuthAdapter는 SessionCookieVerifier 함수 타입에만 의존하며 firebase-admin을 직접
 * import하지 않는다(firebase-agnostic 유지). 이 팩토리가 부팅 시점(index.ts)에서 실 verifier를 조립해
 * 어댑터에 주입한다 — firebase-admin import는 이 파일과 index.ts로만 국한한다.
 *
 * 초기화 멱등성: getApps().length 가드로 default app을 1회만 initializeApp한다(모듈 재평가·다중 조립 시
 * 이중 초기화 방지). 반환 함수는 getAuth().verifySessionCookie로 쿠키를 검증하고 uid만 뽑아 돌려준다.
 * 만료·위조 시 verifySessionCookie가 throw하며, 어댑터가 그 throw를 삼켜 인증 실패(null)로 취급한다 —
 * 여기서 잡지 않고 그대로 전파한다.
 *
 * 실 자격증명·프로젝트 환경이 필요해 단위 테스트가 비실용적이므로 커버리지에서 제외한다(index.ts와 동일
 * 배선 코드 취급 — vitest.config.ts exclude). seam(FirebaseSessionAuthAdapter)은 FAKE verifier로 통합
 * 테스트가 관통 검증한다(sessionAuthFlow.integration.test.ts).
 *
 * 자격증명 범위 주의: `initializeApp({ projectId })`(명시 credential 없음)는 세션 쿠키 서명 검증에
 * 충분하다 — verifySessionCookie는 Google 공개 인증서 + projectId(aud/iss)만 필요하다. 단
 * `verifySessionCookie(cookie, true)`(checkRevoked)로 바꾸면 getUser 경로가 서비스 계정 자격증명을
 * 요구하므로, 그 전환 시 부팅에 credential 주입을 함께 배선해야 한다(현재 비폐기 경로만 지원).
 */
export function createFirebaseVerifier(projectId: string): SessionCookieVerifier {
  if (getApps().length === 0) {
    initializeApp({ projectId })
  }
  return async (cookie: string): Promise<{ uid: string } | null> => {
    const decoded = await getAuth().verifySessionCookie(cookie)
    return { uid: decoded.uid }
  }
}
