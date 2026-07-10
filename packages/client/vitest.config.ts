import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// client 패키지 스코프 테스트 설정 — Story 2·3이 재사용하는 단일 하네스.
// - environment jsdom: DOM/RTL 렌더 대상.
// - include는 .tsx까지 포함해 React 테스트가 누락되지 않게 한다(.ts 전용 glob 복사 금지).
// - setupFiles로 jest-dom 매처를 vitest expect에 등록.
// - 커버리지: 부팅 엔트리(main.tsx)·셋업·테스트 파일 제외.
export default defineConfig({
  plugins: [react()],
  // shared를 dist가 아닌 소스로 해석한다(vite.config.ts와 동일 근거) — dist는 git-ignored라
  // clean checkout(빌드 전)에서 테스트가 모듈 해석에 실패하지 않게 소스로 alias한다.
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
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/test/setup.ts',
        '**/*.test.{ts,tsx}',
        'src/**/*.testutil.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
