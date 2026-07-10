import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// client 앱 빌드 설정 — React 플러그인으로 JSX/Fast Refresh 배선.
// 실제 WebSocket 프록시·빌드 최적화는 후속 에픽에서 추가한다.
export default defineConfig({
  plugins: [react()],
})
