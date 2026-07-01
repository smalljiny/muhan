import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 단일 루트 flat config.
// - TS 패키지(shared·server·client): 타입 인지 규칙 (projectService)
// - port(packages/port/**/*.js): 1993 파생 순수 CommonJS, non-type-checked 블록으로 분리
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  // TS 패키지 — 타입 인지
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  // port — 순수 CommonJS JS, 타입 인지 비활성
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
)
