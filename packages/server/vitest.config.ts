import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// shared property arbitraries(fast-check 의존, dist 미포함)를 server 테스트가 소스에서
// subpath로 재사용하도록 alias한다. `shared/*` → `../shared/src/*`(소스). bare `shared`는
// 슬래시가 없어 이 정규식에 걸리지 않으므로 dist 경유가 그대로 유지된다(두 경로 공존).
const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url))

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
      // firebaseVerifier.ts는 실 firebase 자격증명이 필요해 단위 테스트가 비실용적이라 index.ts처럼
      // 배선 코드로 취급해 제외한다(seam은 통합 테스트가 FAKE verifier로 관통 검증).
      exclude: [
        'src/index.ts',
        'src/auth/firebaseVerifier.ts',
        '**/*.test.ts',
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
  resolve: { alias: [{ find: /^shared\/(.*)$/, replacement: `${sharedSrc}/$1` }] },
})
