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
 * 수용된 보안 한계(revocation 미검사): `verifySessionCookie(cookie)`는 checkRevoked 없이 서명·만료만
 * 검증하므로, 명시 revoke된(비번 변경·강제 로그아웃) 세션 쿠키가 자연 만료 시점(최대 ~2주)까지 계속
 * 인증을 통과한다. 이는 편의가 아니라 **의도적으로 유예한 보안 트레이드오프**다 — 즉시 세션 차단이
 * 필요하면 `verifySessionCookie(cookie, true)`(checkRevoked)로 전환해야 하는데, 그 경로의 getUser는
 * 서비스 계정 자격증명을 요구한다(`initializeApp({ projectId })` 서명 검증용 설정으로는 부족). 따라서
 * revocation 강제는 프로덕션 Firebase credential 프로비저닝과 함께 배선하는 하드닝 작업으로 유예하며,
 * account.status='banned' 강제(A13)와 같은 후속 이슈로 추적한다.
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
