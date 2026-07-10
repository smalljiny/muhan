import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// client 앱 빌드 설정 — React 플러그인으로 JSX/Fast Refresh 배선.
//
// dev 프록시(Story 5, G1 클라측): 브라우저 관점 same-origin으로 `/game`(WS)·`/dev/login`을
// API 서버(기본 PORT 3000)로 프록시한다. same-origin이라야 dev 로그인이 심은 `__session` 쿠키가
// `/game` upgrade에 자동 첨부된다.
// - port 5173 + strictPort: 서버 Origin 게이트가 `WS_ALLOWED_ORIGINS`=`http://localhost:5173`과
//   정확히 대조하므로, 포트가 점유돼 5174로 드리프트하면 Origin 불일치로 403이 된다. 결정적 origin을 핀한다.
// - changeOrigin:false + rewriteWsOrigin 미사용(기본 false): 프록시가 브라우저 Origin(localhost:5173)을
//   그대로 서버에 전달해 Origin 게이트를 통과시킨다. rewriteWsOrigin은 CSWSH 위험이라 쓰지 않는다.
// - `/game`은 ws:true로 WebSocket upgrade를 프록시한다.
export default defineConfig({
  plugins: [react()],
  // shared 워크스페이스를 dist(빌드 산출물)가 아니라 소스로 해석한다. shared/package.json exports는
  // ./dist를 가리키지만 dist는 git-ignored라 clean checkout(빌드 전)에서 dev/e2e가 모듈 해석에 실패한다.
  // tsconfig paths와 동일하게 소스로 alias해 shared 선-빌드 없이 dev·build·e2e가 재현되게 한다.
  resolve: {
    alias: [
      {
        find: /^shared\/protocol$/,
        replacement: fileURLToPath(new URL('../shared/src/protocol/index.ts', import.meta.url)),
      },
      {
        find: /^shared$/,
        replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/game': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: false,
      },
      '/dev/login': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
})
