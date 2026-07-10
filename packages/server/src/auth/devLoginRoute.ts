import type { FastifyInstance } from 'fastify'

/**
 * dev 전용 로그인 라우트 등록(Story 4, G1 서버측). DEV_LOGIN_ENABLED가 true일 때만 buildApp이 호출한다.
 *
 * `GET /dev/login`은 시드 세션 쿠키(`__session=<seedCookie>`)를 Set-Cookie로 발급한다. 쿠키 속성:
 * - `Path=/` — 모든 경로에 첨부돼 `/game` WS upgrade에도 실린다.
 * - Secure 없음 — dev는 평문 loopback(http/ws)이므로 Secure를 붙이면 브라우저가 쿠키를 첨부하지 않는다
 *   (이게 G1 실패점이었다). 프로덕션에선 이 라우트가 마운트되지 않으므로 평문 쿠키 노출 표면이 없다.
 * - `HttpOnly` — 클라 JS가 읽을 필요가 없고, WS upgrade는 same-origin 자동 전송이라 무관하게 첨부된다.
 * - SameSite 미지정 — SameSite=None은 Secure를 강제해 위 제약과 충돌하므로 브라우저 기본(Lax)에 맡긴다.
 */
export function registerDevLoginRoute(app: FastifyInstance, seedCookie: string): void {
  app.get('/dev/login', async (_request, reply) => {
    reply.header('set-cookie', `__session=${seedCookie}; Path=/; HttpOnly`)
    return { ok: true }
  })
}
