import { defineConfig } from 'vitest/config'

// server 패키지 스코프 테스트 설정 — turbo run test가 이 config로 커버리지 게이트를 강제한다.
// 부팅 엔트리(src/index.ts)는 커버리지에서 제외(리스너 배선은 스모크 대상 아님).
// 테스트 헬퍼(*.testutil.ts)는 프로덕션 코드가 아니라 테스트 인프라이므로 커버리지 대상에서 제외한다
// (tsconfig.build.json도 동일 glob으로 제외해 dist에 나가지 않게 한다).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.test.ts', 'src/**/*.testutil.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
