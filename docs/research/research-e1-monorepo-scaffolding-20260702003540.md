# pnpm 모노레포 스캐폴딩(E1): Research Report
*Generated: 2026-07-02 | Sources: 14 | Adapters: [adapter-exa] | Failed: none*

## Executive Summary

E1 스캐폴딩의 스택은 ADR D8에서 pnpm workspaces + Vite(client) + tsup(server) + vitest로 확정됐다. 리서치는 그 구성의 2026 현재 관행과 함정을 확인했고, **한 가지 실질적 재검토 지점**을 발견했다: **tsup은 현재 활발히 유지보수되지 않으며, README가 직접 후속작 `tsdown`(Rolldown+Oxc 기반)을 권장한다** ([egoist/tsup](https://www.github.com/egoist/tsup), [tsdown migrate](https://tsdown.dev/guide/migrate-from-tsup)). 나머지 결정(pnpm workspace 프로토콜, vitest projects, eslint 9 flat config, GitHub Actions CI)은 모두 안정적 관행이 있으며 ADR 방향과 정합한다. 핵심 세부: pnpm **catalog**로 버전 드리프트 방지, vitest **커버리지는 프로세스 전체 단위로 계산**(임계는 루트 정의), eslint flat config는 **단일 루트 config + glob 타게팅**, CI는 pnpm 버전을 lockfile에 맞춰 핀 고정.

## 1. pnpm workspaces 구조 관행

- **workspace: 프로토콜**이 로컬 패키지 해석을 워크스페이스 내부로 제한해 격리·예측성을 확보한다. 단일 루트 `pnpm-lock.yaml` + 단일 루트 `node_modules` 유지 ([pnpm workspaces](https://pnpm.io/workspaces)).
- **pnpm catalog** (pnpm 9.5+, 2026 프로덕션 레디)로 패키지 간 의존성 버전을 중앙에서 핀 고정해 버전 드리프트를 없앤다. 팀 성장 시 `catalogMode: strict`로 bare 버전 문자열 사용을 차단 ([Gerald Chen 2026 Monorepo](https://chenguangliang.com/en/posts/blog193_monorepo-practice-from-zero-to-production/)).
- **공유 설정 패키지 패턴**: `packages/config`(또는 유사) 하나에 ESLint·tsconfig·Prettier 베이스를 모아 앱들이 공유 ([Gerald Chen 2026 Monorepo](https://chenguangliang.com/en/posts/blog193_monorepo-practice-from-zero-to-production/)).
- **TypeScript project references**로 패키지 간 증분 빌드·타입체크 성능을 개선. 단, injected/hardlink된 workspace 의존성이 TS 증분 컴파일에 영향을 줄 수 있어 빌드 도구를 그에 맞춰 계획 ([pnpm workspaces](https://pnpm.io/workspaces)).
- Turborepo 2.x는 태스크 오케스트레이션·캐시 선택지지만 ([Gerald Chen 2026 Monorepo](https://chenguangliang.com/en/posts/blog193_monorepo-practice-from-zero-to-production/)) — 이 프로젝트 규모(4패키지)에선 필수는 아니다. *추론: 초기엔 pnpm 스크립트 + `--filter`로 충분, Turborepo는 빌드 시간이 문제될 때 후순위 도입.*

## 2. 서버 번들러: tsup vs tsdown (재검토 지점)

- **tsup은 유지보수 중단 상태**로 표기된다. 공식 README가 "not actively maintained"를 명시하고 `tsdown` 마이그레이션 가이드를 링크한다 ([egoist/tsup](https://www.github.com/egoist/tsup)). 다만 여전히 ~6M weekly downloads로 가장 널리 쓰인다 ([PkgPulse 2026](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)).
- **tsdown**은 Rolldown+Oxc 기반 "production-ready successor to tsup"으로, tsup과 높은 호환성 + 더 빠른 빌드 + 출력 제어 개선을 표방 ([tsdown](https://tsdown.dev/), [migrate](https://tsdown.dev/guide/migrate-from-tsup)). `experimentalDts` → `dts`로 정리, swc 대신 내장 oxc 사용.
- *추론/주의*: tsup·tsdown 모두 **라이브러리 번들러**다. 서버는 라이브러리가 아니므로 번들이 필수가 아니다 — `tsc` 빌드 또는 `tsx`(dev) + `tsc`(prod)도 유효한 대안. 번들의 이점은 단일 dist 배포 단순화. **결정 필요**: (a) ADR대로 tsup 유지(성숙·광범위하나 유지보수 정체), (b) tsdown 채택(모던·미성숙), (c) 서버는 tsc/tsx로 충분하다고 판단. Open Question으로 승격 권장.

## 3. vitest 구성·커버리지 (모노레포)

- **`projects` 구성**(구 `workspace`, 3.2부터 deprecated)으로 단일 실행에 다중 패키지 설정. 각 프로젝트는 고유 이름·`resolve.alias`·plugins를 갖고, 루트 config는 프로젝트에 상속되지 않는다. 프로젝트별 config는 `defineProject` 사용 ([Vitest Projects](https://vitest.dev/guide/projects)).
- **커버리지는 Vitest 프로세스 전체 단위로 계산**되며, **임계(threshold)는 루트 레벨에서 정의**한다. 프로젝트별 커버리지 제어는 루트 config에 종속 ([Vitest Projects](https://vitest.dev/guide/projects), [Vitest Coverage config](https://vitest.dev/config/coverage)).
- **임계 설정**: `coverage.thresholds.{lines,functions,branches,statements}`로 최소 퍼센트 지정. glob 패턴별 per-file 임계도 가능(`coverage.thresholds['packages/*'].100`), `perFile: true`로 파일 단위 리포트 ([Vitest Coverage config](https://vitest.dev/config/coverage)).
- **provider**: v8(기본)이 istanbul 대비 빠르고 리소스 적으며, Vitest v3.2.0부터 istanbul 호환 리포트 산출. 일부 모듈 로딩 시나리오에서만 느림 ([Vitest Coverage guide](https://vitest.dev/guide/coverage)).
- *적용*: 하네스 testing.md의 80% 임계(lines/functions/branches/statements)는 루트 vitest config에 v8 provider로 정의하고, 패키지는 `projects`로 등록.

## 4. ESLint 9 flat config + Prettier

- **단일 루트 `eslint.config.js`**로 모노레포 전체를 커버하고, `files` glob 패턴으로 패키지별 규칙을 타게팅하는 것이 표준. 공통 베이스는 config 패키지로 공유, 패키지별로 parser/plugins/env override ([eslint discussion #16960](https://github.com/eslint/eslint/discussions/16960), [flat config extends](https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/)).
- **typescript-eslint project service**(v8+)는 모노레포에 추가 설정이 대체로 불필요. typed linting에 `parserOptions.project`를 쓰면 tsconfig 경로 배열(글롭 가능)을 지정하되, 성능을 위해 **넓은 `**` 글롭 회피**. 큰 모노레포(>10 패키지)는 OOM 위험 → 단일 `tsconfig.eslint.json` 또는 패키지 순차 lint로 완화 ([typescript-eslint monorepos](https://typescript-eslint.io/troubleshooting/typed-linting/monorepos/)).
- *적용*: 4패키지 소규모라 OOM 리스크 낮음. 루트 flat config 하나 + glob 타게팅, Prettier는 별도(포맷 전용, lint와 역할 분리).

## 5. GitHub Actions CI 골격 (pnpm 모노레포)

- 표준 워크플로우: `pnpm/action-setup`(v6+ — 구 v2는 최신 Node 비호환) → `actions/setup-node` with `cache: "pnpm"` → `pnpm install` ([pnpm CI](https://pnpm.io/continuous-integration), [pnpm/action-setup](https://github.com/pnpm/action-setup)).
- **CI는 자동으로 frozen-lockfile 모드**. pnpm v11부터 lockfile이 호환되지 않으면(더 최신 pnpm major가 생성한 경우) **CI가 실패**한다 → **CI pnpm 버전을 lockfile 생성 버전에 맞춰 핀 고정** ([pnpm CI](https://pnpm.io/continuous-integration)).
- store/cache는 신뢰된 CI job만 쓰도록 제한. 모노레포는 다중 lockfile 시 `cache_dependency_path`에 여러 경로 지정 가능(단일 워크스페이스면 불필요) ([pnpm/action-setup](https://github.com/pnpm/action-setup)).
- *적용*: E1 CI 골격 = checkout → pnpm/action-setup(버전 핀) → setup-node(cache:pnpm) → install(frozen) → build/type-check/lint/test 순. 단일 루트 lockfile이므로 캐시 경로 단순.

## Key Takeaways

- **tsup 유지보수 정체를 스펙 Open Question으로 승격** — tsup 유지 vs tsdown 채택 vs 서버는 tsc/tsx로 대체. ADR D8은 tsup을 명시했으나 P2("적합성 별도 판단")가 이 재검토를 허용한다.
- **pnpm catalog를 초기부터 도입** — 4패키지라도 버전 드리프트 예방. workspace: 프로토콜 + 단일 lockfile 필수.
- **vitest 80% 커버리지 임계는 루트 config에 정의**(프로세스 전체 계산), 패키지는 `projects`로 등록, v8 provider.
- **eslint는 단일 루트 flat config + glob 타게팅**, Prettier 별도. 소규모라 typed-linting OOM 리스크 없음.
- **CI에서 pnpm 버전을 lockfile에 핀 고정** — frozen-lockfile 자동 + v11 비호환 실패 함정 회피.
- **공유 설정 패키지**(tsconfig/eslint/prettier 베이스)를 `shared` 또는 별도 config 패키지로 — ADR의 shared 패키지가 이 역할 흡수 가능.

## Sources

1. [Workspace | pnpm](https://pnpm.io/workspaces) — workspace: 프로토콜·단일 lockfile·injected 의존성 hardlink 주의
2. [A 2026 Monorepo Setup From Zero to Production](https://chenguangliang.com/en/posts/blog193_monorepo-practice-from-zero-to-production/) — pnpm catalog·catalogMode strict·공유 config 패키지·TS project references
3. [egoist/tsup (GitHub)](https://www.github.com/egoist/tsup) — tsup "not actively maintained", tsdown 권장
4. [tsup docs](https://tsup.egoist.dev/) — --dts/--experimental-dts, tsup-node, esbuild 비타입체크
5. [tsup vs tsdown vs unbuild 2026 — PkgPulse](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026) — tsup ~6M weekly downloads 여전히 최다
6. [tsdown migrate from tsup](https://tsdown.dev/guide/migrate-from-tsup) — Rolldown+Oxc 후속작, API 매핑, dts 정리
7. [tsdown](https://tsdown.dev/) — 사전구성 TS 라이브러리 번들러, 속도 지향
8. [Test Projects | Vitest](https://vitest.dev/guide/projects) — projects(구 workspace), 루트 미상속, defineProject, 커버리지 프로세스 전체 계산
9. [Coverage config | Vitest](https://vitest.dev/config/coverage) — thresholds 4지표·glob per-file·100 shortcut·perFile
10. [Coverage guide | Vitest](https://vitest.dev/guide/coverage) — v8 vs istanbul, v3.2 호환 리포트
11. [ESLint flat config in monorepo (discussion #16960)](https://github.com/eslint/eslint/discussions/16960) — 단일 루트 config + glob 타게팅
12. [Monorepo Configuration | typescript-eslint](https://typescript-eslint.io/troubleshooting/typed-linting/monorepos/) — project service v8+, parserOptions.project 배열, OOM 완화
13. [Continuous Integration | pnpm](https://pnpm.io/continuous-integration) — frozen-lockfile 자동, v11 비호환 실패, 버전 핀
14. [pnpm/action-setup](https://github.com/pnpm/action-setup) — v6+ 필요, cache/cache_dependency_path

## Methodology

Searched 6 queries via adapter-exa (`/search`, type=auto, 6 results each). Adapters used: adapter-exa. Adapters failed: none. Sub-questions investigated: (1) pnpm workspace 구조 관행, (2) tsup vs 대안 서버 번들러, (3) vitest projects·커버리지, (4) eslint 9 flat config + prettier, (5) GitHub Actions CI, (6) tsdown 후속작 검증. Sources analyzed: 14 unique.
