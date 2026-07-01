import { defineConfig } from 'vitest/config'

// server 패키지 스코프 테스트 설정 — turbo run test가 이 config로 커버리지 게이트를 강제한다.
// 부팅 엔트리(src/index.ts)는 커버리지에서 제외(리스너 배선은 스모크 대상 아님).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
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
