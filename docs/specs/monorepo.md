# Monorepo 스캐폴딩·툴체인

> pnpm workspaces + Turborepo 기반 4패키지 monorepo와 빌드·타입체크·lint·test·CI 툴체인의 정본.

## 개요

무한 포팅의 실행 가능한 토대다. 데이터 포맷 역설계·JSON 변환(`data/world/`)이 끝난 상태에서, 이후 모든 에픽(E2 영속화·E3 전송·E8 테스트)이 분기하는 원자적 스캐폴딩을 이룬다. pnpm workspaces monorepo에 `shared`·`server`·`client`·`port` 4패키지를 두고, Turborepo 2.x가 태스크 오케스트레이션·증분 캐시를 담당한다. 툴체인(build → type-check → lint → test → CI)이 end-to-end로 동작함을 최소 부팅 Fastify 서버 + 스모크 테스트로 증명한다.

아키텍처 결정 배경은 [`architecture.md`](architecture.md) D8(구성)·D0(전송 호스트) 참조. E1은 D8을 리서치 기반으로 구체화하며, 서버 번들러를 tsup에서 tsc로 보정하고(§3.8) Fastify를 HTTP 호스트로 채택한다(§3.5).

## 구조 / 스키마

### 디렉터리 레이아웃

```
muhan/
├── package.json            # 루트(private, turbo run 위임 스크립트, packageManager 핀)
├── pnpm-workspace.yaml     # packages/* + catalog 버전 핀
├── turbo.json              # 태스크 파이프라인(build/type-check/lint/test)
├── tsconfig.base.json      # 공유 컴파일러 옵션
├── eslint.config.js        # flat config 단일 루트
├── .prettierrc.json        # prettier 포맷 설정
├── .prettierignore         # prettier 제외 경로
├── vitest.config.ts        # projects + 루트 커버리지 임계
├── .gitignore              # graphify·.venv·node_modules·dist·.turbo·coverage
├── .github/workflows/ci.yml
├── data/world/             # 기존 산출물(정본, 이동 없음)
└── packages/
    ├── shared/   # 공유 단일 출처 타입 + world 로더
    ├── server/   # 최소 Fastify 부팅 엔트리 + /health
    ├── client/   # Vite 빈 앱 스켈레톤
    └── port/     # 1993 디스크 포맷 변환기(순수 JS, 무빌드)
```

### 패키지 책임

| 패키지 | 이름 | E1 스코프 | 빌드 | 후속 |
|--------|------|-----------|------|------|
| `shared` | `shared` | 공유 타입(`HealthStatus`) + `loadWorldFile` world 로더 | tsc(타입 소거) | Zod 계약·조사 유틸·게임 도메인 타입 |
| `server` | `server` | 최소 Fastify 부팅 + `/health` 200 + `buildApp()` 팩토리 | tsc | E2 Mongo·E3 WS·세션 |
| `client` | `client` | Vite 빈 앱 스켈레톤 | Vite | 프론트엔드 토픽 UI |
| `port` | `@muhan/port` | 루트 3파일 이관(순수 CommonJS JS) | 없음(Node 직접 실행) | 유지 |

- 패키지 간 의존은 `workspace:*` 프로토콜. `server`·`client`가 `shared`를 import한다.
- `shared`는 `exports`/`types`로 `dist/index.d.ts`를 노출해 소비 패키지가 타입을 참조한다.
- `port`는 `type: "commonjs"`, `@muhan/port`로 네임스페이스화됐고 lint만 태스크로 가진다.

### 공유 의존성 버전 (pnpm catalog)

`pnpm-workspace.yaml`의 `catalog:`가 공유 의존성(런타임·dev) 버전을 단일화한다. `catalogMode` strict는 미강제(팀 1인).

| 항목 | 핀 |
|------|-----|
| typescript | ^5.7.2 |
| vitest / @vitest/coverage-v8 | ^3.0.0 |
| eslint / typescript-eslint | ^9.17.0 / ^8.19.0 |
| prettier | ^3.4.0 |
| turbo | ^2.3.0 |
| fastify | ^5.2.0 |
| vite | ^7.0.0 |
| tsx | ^4.19.0 |
| @types/node | ^22.10.0 |
| mongodb | ^7.4.0 |
| zod | ^4.4.3 |
| mongodb-memory-server | ^11.2.0 |

런타임 의존성은 소비 패키지의 `dependencies`에 `catalog:`로 참조한다: `zod`는 `shared`(스키마)·`server`, `mongodb`는 `server`, `mongodb-memory-server`는 `server` devDependency(통합 테스트). E2-1 영속화 계층이 추가했다(`docs/specs/persistence.md`).

pnpm 버전은 루트 `package.json`의 `packageManager: "pnpm@10.33.0"`가 단일 출처다.

### transitive 취약점 하드닝 (pnpm.overrides)

루트 `package.json`의 `pnpm.overrides`가 `pnpm audit`이 검출한 transitive 의존성 취약점을 패치 버전으로 강제 해석한다. catalog가 직접 devDependency 버전을 단일화하는 것과 층위가 다르다 — overrides는 소비 패키지가 선언하지 않은 **transitive 노드**의 해석을 대역 한정으로 재작성한다.

| LHS 셀렉터(취약 대역) | RHS(강제 버전) | 대상 경로 | Advisory |
|------|------|------|------|
| `brace-expansion@<1.1.16` | `>=1.1.16 <2.0.0` | eslint → minimatch → brace-expansion | GHSA-3jxr-9vmj-r5cp (ReDoS) |
| `brace-expansion@>=2.0.0 <2.1.2` | `>=2.1.2 <3.0.0` | @vitest/coverage-v8 → test-exclude → glob → minimatch → brace-expansion | GHSA-3jxr-9vmj-r5cp (ReDoS) |
| `uuid@<11.1.1` | `>=11.1.1 <12.0.0` | firebase-admin → @google-cloud/storage → gaxios → uuid | GHSA-w5hq-g745-h8pq |
| `fast-uri@<3.1.4` | `>=3.1.4 <4.0.0` | packages/server → fastify → @fastify/ajv-compiler → fast-uri | GHSA-v2hh-gcrm-f6hx (host confusion) |
| `find-my-way@<9.7.0` | `>=9.7.0 <10.0.0` | packages/server → fastify → find-my-way | GHSA-c96f-x56v-gq3h (HTTP2 DDoS) |

정책 두 축:
- **LHS 대역 한정**: 취약 대역에 해당하는 노드만 재해석하고 다른 소비자는 건드리지 않아 blast radius를 최소화한다. 무범위 override(`"uuid": ">=11.1.1"`)는 전 트리를 강제해 부작용 위험이 크므로 금지한다.
- **RHS "다음 메이저 미만" 상한**: 각 RHS를 취약 대역과 같은 메이저 라인에 고정한다(`<2.0.0`/`<3.0.0`/`<12.0.0`/`<4.0.0`/`<10.0.0`). 상한 없는 `>=`는 최고 만족 버전을 끌어와 cross-major breaking을 유발한다 — 실제로 무상한 `>=2.1.2`는 minimatch@9.0.9(brace-expansion `^2.0.2` 소비)에 brace-expansion 5.0.7(ESM named-export)을 강제해 CJS `.default` interop을 깨뜨렸고, 무상한 `>=11.1.1`은 uuid를 14.x로 점프시켰다. fast-uri도 4.x 라인이 존재해 무상한 `>=3.1.4`는 미검증 메이저를 끌어올 수 있으므로 `<4.0.0`으로 고정한다.

override는 transitive 버전만 바꾸므로 애플리케이션 소스는 무변경이며, 검증은 audit 0건 + build·type-check·test 회귀 부재로 갈음한다. 시점 반응 패치이므로 향후 dependency bump가 취약 대역을 재도입할 수 있고, CI에는 아직 `pnpm audit` 게이트가 없어(향후 별도 토픽) 재검출은 로컬 `pnpm audit`에 의존한다.

## 동작

### 태스크 오케스트레이션 (Turborepo)

루트 `package.json` 스크립트는 `turbo run <task>`로 위임한다. `turbo.json`이 파이프라인을 정의한다:

- `build`: `dependsOn: ["^build"]`(의존 패키지 먼저), `outputs: ["dist/**"]`.
- `type-check`·`lint`: `dependsOn: []`(독립).
- `test`: `dependsOn: ["^build"]`, `outputs: ["coverage/**"]`. vitest는 워크스페이스 패키지(`shared`)를 `exports`로 `dist/`에서 해석하므로, `test` 전에 의존 패키지를 빌드해야 stale/부재 `dist`로 인한 clean-CI 실패를 막는다(E2-1이 `[]`→`["^build"]`로 정정). `type-check`는 tsconfig `paths`로 `shared/src`를 직접 읽어 이 의존이 불필요하다.

로컬·CI 모두 증분 캐시로 미변경 패키지 태스크를 스킵한다(`>>> FULL TURBO`). 원격 캐시는 미도입.

### TypeScript

`tsconfig.base.json`이 공유 컴파일러 옵션을 정의하고 패키지별 tsconfig가 확장한다. `strict`·`noUncheckedIndexedAccess`·`isolatedModules`·`noEmitOnError`·`declaration`·`declarationMap`, `module: ESNext`, `moduleResolution: bundler`, `target: ES2022`. project references는 미도입(4패키지 소규모라 패키지별 `tsconfig.build.json` 단순 경로 참조).

### 빌드·실행 모델

- **client**: `vite build` → `dist/`. dev는 `vite`.
- **server**: 번들러 없음. `build`=`tsc -p tsconfig.build.json` → `dist/`, `dev`=`tsx watch src/index.ts`, `start`=`node dist/index.js`. 서버는 실행 앱이라 번들이 불필요하고, Fastify 동적 require가 번들러와 충돌하므로 tsc를 쓴다.
- **port**: 무빌드. Node로 스크립트 직접 실행.

서버 엔트리(`server/src/index.ts`)는 부팅 시퀀스를 오케스트레이션한다: `getConfig()`(env fail-fast) → `connectMongo`(DB fail-fast) → repository 인덱스 `init()` → `loadWorldGraph`(방 2341 인메모리) → `buildApp({ pingDb })` → `PORT`(`getConfig().PORT`, 0–65535) `0.0.0.0` 리슨(E2-1이 확장; 상세는 `docs/specs/persistence.md`). `/health`는 DB ping 기반으로 `shared`의 `HealthStatus`(`{ status: 'ok'|'degraded', db: 'up'|'down' }`)를 반환한다. 배선 엔트리(`index.ts`)는 커버리지에서 제외하고, 앱 팩토리(`app.ts`)를 `inject`로 스모크 테스트한다.

### 테스트·커버리지

루트 `vitest.config.ts`가 `projects: ['packages/*/vitest.config.ts']`로 vitest.config를 가진 패키지만 프로젝트로 묶는다(`port` 제외). 커버리지는 v8 provider, 리포터 `['text','lcov']`, 임계 80%(lines/functions/branches/statements). `include: packages/*/src/**/*.ts`, 제외 대상은 부팅 엔트리(`server/src/index.ts`)·client `main.ts`·`port/**`·`**/*.test.ts`·테스트 헬퍼(`**/*.testutil.ts`). 임계는 루트 문서화 지점이며 실제 강제는 패키지별 `vitest.config.ts`가 담당하고 두 exclude 목록을 일관되게 유지한다. 테스트 헬퍼는 `*.testutil.ts` 컨벤션으로 `tsconfig.build.json`(dist 미포함)과 커버리지 양쪽에서 제외한다 — 프로덕션 코드가 아니라 테스트 인프라이기 때문이다.

### lint / format

단일 루트 `eslint.config.js`(flat config, typescript-eslint)가 glob으로 스코프를 나눈다:

- `**/*.ts`(config 파일 제외): 타입 인지 규칙(`recommendedTypeChecked`, `projectService`).
- `**/*.config.{ts,mts,cts}`: tsconfig include 밖이라 non-type-checked(`recommended`).
- `packages/port/**/*.js`: 순수 CommonJS, `disableTypeChecked`.

prettier는 포맷 전용으로 분리(`.prettierrc.json` + `.prettierignore`).

### CI

`.github/workflows/ci.yml` 단일 워크플로우. `push`(develop·main)·`pull_request` 트리거, `permissions: contents: read`(최소 권한). 스텝: checkout → `pnpm/action-setup@v4`(버전은 `packageManager` 핀 단일 출처) → `setup-node@v4`(node 24, `cache: pnpm`) → `pnpm install --frozen-lockfile` → `pnpm turbo run build type-check lint test`. Turborepo 로컬 캐시로 미변경 태스크를 스킵한다.

### gitignore

`node_modules/`·`dist/`·`build/`·`.turbo/`·`coverage/`·`.venv/`·`.env*` 무시. graphify는 `graphify-out/*`를 무시하되 `GRAPH_REPORT.md`·`cost.json`만 tracked로 노출한다.

## 제약사항

- E1은 스캐폴딩 토대만 다룬다. 상세 전송·세션(WS 핸드셰이크·프로토콜·라우팅)은 E3, 영속화(MongoDB)는 E2, 게임 로직·규칙은 후속 에픽 범위 밖이다.
- 서버는 `/health` 최소 엔드포인트 + 부팅만 제공한다. 실제 Fastify 라우트·플러그인·`@fastify/websocket` 배선은 E3.
- `client`는 빈 앱 스켈레톤이며 UI·상태관리는 별도 프론트엔드 토픽이다.
- `port`는 순수 JS를 유지한다(TS 전환 안 함).
- Turborepo 원격 캐시·Redis·배포/Docker/prod 인프라는 범위 밖이다.
