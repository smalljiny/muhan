import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 단일 루트 flat config.
// - TS 패키지(shared·server·client): 타입 인지 규칙 (projectService)
// - config .ts(vitest.config 등): 어느 tsconfig에도 없어 projectService 불가 → non-type-checked 블록
// - port(packages/port/**/*.js): 1993 파생 순수 CommonJS, non-type-checked 블록으로 분리
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  // TS 패키지 소스 — 타입 인지 (config 파일은 tsconfig include 밖이라 제외)
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.config.{ts,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  // config .ts — 타입 인지 없이 스타일만 (projectService 미적용)
  {
    files: ['**/*.config.{ts,mts,cts}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // port — 순수 CommonJS JS, 타입 인지 비활성 (port 디렉터리로 스코프)
  {
    files: ['packages/port/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
)
