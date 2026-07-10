import { defineConfig, devices } from '@playwright/test'

// 호스트 Playwright e2e 설정(Story 7, G4 정본 검증) — compose 스택(server+mongo)을 SUT로 삼아
// 전송 왕복(G1 인증 접속·G2 버전 협상·G3 debug:echo 왕복)을 실브라우저로 end-to-end 검증한다.
//
// 부팅 분담(OQ2): compose(server:3000 + mongo)는 caller가 e2e 실행 전 외부에서 미리 부팅한다.
// webServer는 호스트 Vite(5173)만 기동한다 — Vite(Story 5)가 /game·/dev/login을 서버 3000으로
// 프록시하므로 브라우저는 same-origin(localhost:5173)으로만 통신한다. Vite는 strictPort로 5173에
// 고정돼 있어 Origin 게이트(WS_ALLOWED_ORIGINS=http://localhost:5173)와 정확히 대조된다.
//
// 실행 절차(재현):
//   1. docker compose up -d --build          # server(3000) + mongo 부팅
//   2. pnpm --filter client e2e              # 호스트 Vite 기동 + Playwright 실행
//   3. docker compose down                   # 정리
export default defineConfig({
  testDir: 'e2e',
  // WS 핸드셰이크·왕복이 비동기라 개별 assertion에 넉넉한 타임아웃을 spec에서 부여한다.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // 호스트 Vite만 기동한다. compose(server+mongo)는 caller가 외부에서 미리 부팅한다.
  // reuseExistingServer: 로컬에서 이미 떠 있는 Vite를 재사용, CI에서는 항상 새로 띄운다.
  webServer: {
    command: 'pnpm --filter client dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
