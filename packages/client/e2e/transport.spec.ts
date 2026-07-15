import { expect, test } from '@playwright/test'

// 전송 왕복 e2e(Story 7, G4 정본 검증) — compose 스택(server+mongo)을 SUT로 실브라우저 왕복을 단언한다.
//
// 사전 조건(caller가 보장): `docker compose up -d --build`로 server(3000)+mongo가 떠 있어야 한다.
// Playwright webServer가 호스트 Vite(5173)를 기동하고, Vite가 /game·/dev/login을 서버 3000으로 프록시한다.
// 실행: `docker compose up -d --build` → `pnpm --filter client e2e` → `docker compose down`.
//
// CRITICAL 순서: (1) dev 로그인으로 __session 쿠키 세팅 → (2) 앱 페이지 로드 → (3) WS 연결.
// 앱이 먼저 마운트되면 쿠키 없이 /game upgrade에 접속해 서버 쿠키 게이트에서 401난다. beforeEach가
// goto('/dev/login')로 쿠키를 먼저 심고, 각 test가 goto('/')로 앱을 로드한다.
//
// 관측 표면(UI 단언): 연결 상태 span(aria-label '연결 상태'), 캐릭터 카드의 '선택' 버튼,
// 이벤트 로그 ul(aria-label '이벤트 로그'), 명령 입력(label '명령')+'보내기' 버튼.
// 상태 도달은 web-first assertion(자동 재시도)으로 대기한다 — 고정 sleep 금지.

// WS 핸드셰이크·인증·왕복은 비동기라 상태 도달에 넉넉한 타임아웃을 둔다.
const HANDSHAKE_TIMEOUT = 15_000

test.beforeEach(async ({ page }) => {
  // G1 전제: dev 로그인이 same-origin(localhost:5173)에서 __session 쿠키를 발급하게 한다.
  // Vite가 서버 3000으로 프록시하고, 서버는 Set-Cookie: __session=...; Path=/ 와 {"ok":true}를 응답한다.
  const response = await page.goto('/dev/login')
  expect(response?.ok()).toBe(true)
})

test('전송 왕복: 인증 접속(G1)·버전 협상(G2)·debug:echo 왕복(G3)', async ({ page }) => {
  // 연결 상태 span은 implicit role이 없어 getByLabel 매칭이 불확실하므로 aria-label 속성 선택자로 확실히 잡는다.
  const connectionStatus = page.locator('[aria-label="연결 상태"]')
  const eventLog = page.getByRole('list', { name: '이벤트 로그' })

  await test.step('G1: 앱 로드 → __session 쿠키로 /game WS 접속 → 캐릭터 선택 → ready 도달', async () => {
    // 쿠키가 심긴 뒤 앱을 로드한다. WsClient가 ws://localhost:5173/game으로 연결하고 쿠키가 첨부된다.
    await page.goto('/')
    // 진입은 사용자 구동이다(E10이 autoSelect 스텁 제거). 캐릭터 목록이 도착하면 시드 캐릭터를 선택해야
    // 서버 FSM이 characterSelect→command로 전이하며 session:entered를 발화한다.
    const selectButton = page.getByRole('button', { name: '선택' })
    await expect(selectButton).toBeVisible({ timeout: HANDSHAKE_TIMEOUT })
    await selectButton.click()
    // ready = session:entered 도달 = 핸드셰이크+인증+command 상태 완료. G1(접속)+G2(협상)를 동시에 증명한다.
    await expect(connectionStatus).toHaveText('ready', { timeout: HANDSHAKE_TIMEOUT })
  })

  await test.step('G2: hello→ready 협상 개시가 이벤트 로그에 나타남', async () => {
    // WsClient는 모든 수신 이벤트를 events에 기록하므로 system:hello가 로그에 렌더된다.
    await expect(eventLog).toContainText('system:hello', { timeout: HANDSHAKE_TIMEOUT })
  })

  await test.step('G3: debug:echo 송신 → debug:echo:result 왕복이 로그에 표시됨', async () => {
    // ready 도달 이후에만 sendEcho가 프레임을 보낸다(미ready 시 not-connected로 드롭). 위 step이
    // ready를 대기 완료했으므로 안전하다.
    const echoText = 'hello-e2e'
    await page.getByLabel('명령').fill(echoText)
    await page.getByRole('button', { name: '보내기' }).click()
    await expect(eventLog).toContainText('debug:echo:result', { timeout: HANDSHAKE_TIMEOUT })
    await expect(eventLog).toContainText(echoText, { timeout: HANDSHAKE_TIMEOUT })
  })
})
