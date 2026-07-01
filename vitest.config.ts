import { defineConfig } from 'vitest/config'

// 루트 vitest 설정 — 워크스페이스 통합 뷰.
// - projects: vitest.config.ts를 가진 패키지만 프로젝트로 포함 (port는 config 없어 제외)
// - coverage: repo-wide 정책의 단일 문서화 지점. 부팅 엔트리·client main·port·config 파일 제외.
//   실제 turbo-time 강제는 패키지별 vitest.config.ts가 담당하며, 두 exclude 목록은 일관되게 유지한다.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/server/src/index.ts',
        'packages/client/src/main.ts',
        'packages/port/**',
        '**/*.test.ts',
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
