import { defineConfig } from 'vitest/config'

// shared 패키지 스코프 테스트 설정 — turbo run test가 이 config로 커버리지 게이트를 강제한다.
// index.ts(타입 + re-export 배럴)는 커버리지에서 제외, 실제 로직(worldLoader)만 측정.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
