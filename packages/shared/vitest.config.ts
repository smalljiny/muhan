import { defineConfig } from 'vitest/config'

// shared 패키지 스코프 테스트 설정 — turbo run test가 이 config로 커버리지 게이트를 강제한다.
// index.ts(타입 + re-export 배럴)는 커버리지에서 제외, 실제 로직(worldLoader)만 측정.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.ts'],
      // index.ts(배럴)·context.ts(type-only)는 실행 코드가 없어 커버리지에서 제외.
      exclude: ['src/index.ts', 'src/stats/context.ts', '**/*.test.ts', 'src/**/*.testutil.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
