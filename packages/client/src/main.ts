import type { HealthStatus } from 'shared'

// E1 client 스켈레톤 — 빈 앱 부트. shared 타입 edge(교차 패키지 타입 공유)만 증명한다.
// 실제 UI·게임 화면은 후속 에픽에서 구현한다.
const health: HealthStatus = { status: 'ok', db: 'up' }

const root = document.querySelector<HTMLDivElement>('#app')
if (root) {
  root.textContent = `무한 client (health: ${health.status})`
}
