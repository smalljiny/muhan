# 전송 셸 (E9-1)

> React 웹 클라이언트가 dev 환경에서 서버 `/game` WebSocket에 인증 접속해 프로토콜 왕복(ClientCommand↔ServerEvent)을 증명하는 전송 기반 셸과, 이를 재현 가능하게 검증하는 로컬 Docker 개발/테스트 하네스.

## 개요

`packages/client`(React + Vite)에 WebSocket 전송 레이어·경량 UI·dev 인증 접속 배선을 세우고, `packages/server`에 dev 전용 로그인 엔드포인트와 env 기반 시드 인증 어댑터를 배선하며, docker-compose(server+mongo)와 호스트 Playwright e2e로 end-to-end 왕복을 검증한다.

이 계층은 [`transport-protocol.md`](transport-protocol.md)(E3-1)가 확립한 WS 핸드셰이크·라우터·하트비트와 [`auth-session.md`](auth-session.md)(E3-2)가 확립한 `preValidation` 인증 게이트·세션 FSM을 **소비**한다 — 둘 다 재구현하지 않고 그 계약(`shared/protocol`) 위에서 클라이언트를 붙인다. 캐릭터 선택 UI·게임플레이 뷰는 후속 에픽(E10~)이 소유하며, 이 토픽은 전송 기반을 증명하는 최소 셸에 한정한다.

## 구조 / 스키마

### 클라이언트 (`packages/client`)

- `src/transport/wsClient.ts` — 프레임워크 비의존 순수 TS `WsClient`. 연결/해제/수동 재연결, 송신 전 `clientCommandSchema` 검증, 수신 후 `serverEventSchema` parse, hello→ready 버전 협상, command 상태 도달용 최소 자동 `selectCharacter`, `sendEcho(text)`를 제공한다. `SocketFactory`(테스트가 fake `SocketLike`를 주입하는 seam)로 실제 `WebSocket` 생성을 감싸고, 불변 `WsClientSnapshot { status, events, errors }`를 `subscribe`/`getSnapshot`으로 노출한다(React `useSyncExternalStore` 호환).
- `src/App.tsx` — 전송 셸 최상위. `WsClient`를 마운트 동안 단일 인스턴스로 유지하고 스냅샷을 구독해 하위 컴포넌트에 데이터·콜백을 주입한다. 게임 소켓 URL을 `window.location`에서 파생한다(하드코딩 host 없음 — same-origin이라야 쿠키가 upgrade에 첨부된다).
- `src/main.tsx` — React 마운트 엔트리(`#root`).
- `src/components/EventLog.tsx` — 수신 `ServerEvent`를 원본(type + 직렬화 payload)으로 순차 렌더하는 순수 표시 컴포넌트.
- `src/components/CommandInput.tsx` — 텍스트 입력 폼. submit 시 주입된 `onSubmitEcho` 콜백을 호출한다.
- `src/components/ConnectionStatus.tsx` — 연결 상태 표시 + 수동 재연결 버튼(`onReconnect` 콜백).
- `vite.config.ts` — React 플러그인, dev 프록시(`/game`·`/dev/login`), `shared`/`shared/protocol` 소스 alias.
- `vitest.config.ts` — jsdom + React Testing Library 유닛 하네스, 동일 `shared` 소스 alias, 커버리지 80%+ 게이트.
- `playwright.config.ts` — 호스트 Playwright e2e 설정. `webServer`는 호스트 Vite(5173)만 기동한다.
- `e2e/transport.spec.ts` — compose 스택을 SUT로 삼는 실브라우저 왕복 검증.

### 서버 dev 배선 (`packages/server/src/auth`, `config/env.ts`, `app.ts`, `index.ts`)

- `devLoginRoute.ts` — `registerDevLoginRoute(app, seedCookie)`. `GET /dev/login`을 등록해 `Set-Cookie: __session=<seedCookie>; Path=/; HttpOnly`를 응답한다.
- `devSeedSessionAuth.ts` — `createDevSeedAuthAdapter(cookie, accountId)`(순수 팩토리)와 `createDevSeedAuthAdapterFromEnv(config)`(env 래퍼). 시드 쿠키→accountId 매핑과 고정 캐릭터 1개(`DEV_SEED_CHARACTER`)를 담은 `InMemorySessionAuthAdapter`를 조립한다.
- `config/env.ts` — `DEV_LOGIN_ENABLED`(`z.enum(['true','false']).default('false').transform(...)`)·`DEV_SEED_COOKIE`·`DEV_SEED_ACCOUNT_ID` 필드와, `getConfig()` 내부의 `NODE_ENV` fail-closed 2차 게이트.
- `app.ts` — `buildApp(deps)`가 `deps.devLoginSeedCookie`가 주어질 때만 `registerDevLoginRoute`를 호출한다(미주입 시 라우트 부재).
- `index.ts` — 부팅이 `config.DEV_LOGIN_ENABLED`가 true일 때만 `sessionAuth`·`devLoginSeedCookie`를 `buildApp`에 주입한다.

`WS_ALLOWED_ORIGINS`([`auth-session.md`](auth-session.md) E3-2 소유 필드)는 E9-1이 새로 정의하지 않지만, compose·Vite 설정이 이 값을 dev origin(`http://localhost:5173`)으로 채운다.

### 하네스 (레포 루트)

- `docker-compose.yml` — `mongo`(로컬 DB, healthcheck) + `server`(`Dockerfile.dev`로 빌드, `mongo` 헬시 대기 후 기동, dev 로그인·시드 env 주입) + 선택적 `test` profile(유닛 스위트를 도커에서 재현, 기본 `up` 미포함).
- `Dockerfile.dev` — `node:24-slim` 기반, 워크스페이스 전체를 install하고 `shared`만 빌드한 뒤 `tsx`로 서버 소스를 직접 구동. 프로덕션 멀티스테이지 최적화는 다루지 않는다.
- `.dockerignore` — `node_modules`/`dist`/워크트리 하네스 심볼릭 링크(`.claude`·`.codex` 등)·시크릿·`docs`·`legacy`를 빌드 컨텍스트에서 제외한다.
- `packages/shared/package.json` — `./protocol` subpath export(`dist/protocol/index.js`)로 클라이언트가 `shared/protocol`을 패키지 진입점으로 import할 수 있게 한다(Vite/Vitest는 이를 소스로 alias-override한다 — 아래 참조).

## 동작

### G1 — dev 인증 접속

브라우저가 `GET /dev/login`을 호출하면(Vite가 API 서버로 same-origin 프록시) 서버가 `Set-Cookie: __session=<시드값>; Path=/; HttpOnly`를 응답한다. `Secure` 속성은 붙이지 않는다 — dev는 평문 loopback(http/ws)이므로 `Secure`를 붙이면 브라우저가 쿠키를 첨부하지 않아 upgrade가 실패한다(이 속성이 G1의 실제 실패점이었다). 이후 클라이언트가 같은 origin(`ws://localhost:5173/game`)으로 접속하면 브라우저가 `__session` 쿠키를 WS upgrade 요청에 자동 첨부하고, Vite 프록시가 이를 API 서버로 그대로 전달한다. 서버 `preValidation`([`auth-session.md`](auth-session.md))이 Origin allowlist와 세션 쿠키를 검증해 `DEV_SEED_ACCOUNT_ID` 신원으로 통과시킨다.

dev 로그인은 **이중 fail-closed 게이트**로 보호한다.

1. `DEV_LOGIN_ENABLED` env 플래그(기본 `false`)가 `/dev/login` 라우트 마운트와 시드 어댑터 배선을 게이트한다. `z.enum(['true','false']).transform(...)`으로 파싱해 `z.coerce.boolean`이 비어있지 않은 문자열 `"false"`를 `true`로 강제하는 함정을 피한다.
2. `getConfig()`가 2차 방어선으로, `DEV_LOGIN_ENABLED=true`인데 `NODE_ENV`가 명시적으로 `development`/`test`가 아니면(production·미설정·기타 값 포함) 부팅을 fail-fast로 차단한다. 플래그 하나만으로 dev 인증 우회가 프로덕션에 잔존하는 경로를 코드 레벨에서 막는다.

시드 인증은 프로덕션 격리를 존중한다. `devSeedSessionAuth.ts`는 하드코딩 유효 쿠키 상수를 담은 `seedSessionAuth.testutil.ts`(빌드에서 제외되는 test-only 모듈)를 import하지 않는다. 대신 런타임 env(`DEV_SEED_COOKIE`/`DEV_SEED_ACCOUNT_ID`)에서만 시드 값을 읽어 어댑터를 조립하므로, 이 모듈이 `dist`에 나가도 유효 쿠키 문자열은 컴파일 산출물에 실리지 않는다. 값이 비어 있으면(cookie·accountId 중 하나라도 빈 문자열) 조립을 fail-fast로 거부한다 — 플래그가 켜졌는데 시드 값이 없으면 무의미한 빈 쿠키가 배포되는 오설정을 조기에 막는다. `DEV_LOGIN_ENABLED`가 false/부재면 `buildApp`은 라우트를 마운트하지 않고 기존 빈 `InMemorySessionAuthAdapter`(유효 쿠키 0개) 경로를 그대로 유지한다.

Vite 프록시(`vite.config.ts`)는 CSWSH를 브라우저 실제 Origin으로 방어한다 — `changeOrigin:false`(`rewriteWsOrigin` 미사용)로 프록시가 브라우저 Origin을 조작하지 않고 서버에 그대로 전달하고, `server.port: 5173` + `strictPort: true`로 포트를 고정한다. 포트가 드리프트하면(예: 5174로 밀림) 서버 `WS_ALLOWED_ORIGINS` allowlist와 불일치해 403이 나므로, `strictPort`가 이 대조를 결정적으로 만든다.

### G2 — 버전 협상

`WsClient`가 `system:hello` 수신 시 `system:ready{protocolVersion: PROTOCOL_VERSION}`을 송신해 상태를 `negotiating`으로 전환한다. 서버측 핸드셰이크 전이표는 [`transport-protocol.md`](transport-protocol.md)의 계약을 그대로 따른다(이 토픽은 재구현하지 않음).

### G3 — 프로토콜 왕복

`WsClient`는 모든 송신 `ClientCommand`를 `clientCommandSchema.safeParse`로, 모든 수신 프레임을 `serverEventSchema.safeParse`로 검증한다. 검증에 실패하면 throw하지 않고 관측 가능한 `WsClientSnapshot.errors`에 누적한다 — 상태 전이·이벤트 기록에 도달하지 않으므로 실패가 무증상으로 묻히지 않는다.

서버 세션 FSM([`auth-session.md`](auth-session.md))은 `command` 상태에 도달해야 `debug:echo`를 라우팅한다. `WsClient`는 이 경로를 성립시키기 위해 `session:characterList` 수신 시 첫 캐릭터의 `characterId`로 `session:selectCharacter`를 1회 자동 송신한다. 이 자동 선택은 **전송 배관**이며 캐릭터 선택 UI가 아니다 — 목록 렌더·사용자 선택·생성/재개 UX는 다루지 않는다(E10 소유). `session:entered` 수신 시 상태를 `ready`로 전환한다(echo 가능). `EventLog`는 `session:characterList` 등 수신 이벤트를 원본으로 표시할 뿐, 캐릭터 선택 화면을 구현하지 않는다.

`ready` 상태에서 `CommandInput`이 텍스트를 `sendEcho(text)`로 넘기면 `debug:echo` ClientCommand가 송신되고, 서버가 되돌린 `debug:echo:result`가 `EventLog`에 나타나 왕복을 증명한다.

`shared`/`shared/protocol`은 Vite·Vitest 설정 모두 패키지 `exports`(→ git-ignored `dist`)가 아니라 소스(`../shared/src/index.ts`, `../shared/src/protocol/index.ts`)로 alias 해석한다. clean checkout에서 `shared`를 먼저 빌드하지 않아도 client의 dev·build·test·e2e가 모듈 해석에 실패하지 않는다(패키지 `exports`는 그대로 두어 dist 기준 소비자와의 호환은 유지한다).

### G4 — 로컬 Docker 검증

`docker compose up`이 `mongo`(healthcheck 통과 대기) 뒤에 `server`를 기동한다. 서버 컨테이너는 `MONGODB_URI=mongodb://mongo:27017`(외부 Atlas 비의존), `WS_ALLOWED_ORIGINS=http://localhost:5173`, `DEV_LOGIN_ENABLED=true` + 시드 값을 env로 받는다.

Playwright e2e(`e2e/transport.spec.ts`)는 호스트에서 실행하며 compose(server+mongo)를 SUT로 삼는다 — `playwright.config.ts`의 `webServer`는 호스트 Vite(5173)만 기동하고, compose 스택은 caller가 `docker compose up -d --build`로 미리 띄운다. 각 테스트는 `beforeEach`에서 `/dev/login`으로 쿠키를 먼저 심은 뒤 앱을 로드해(순서가 바뀌면 쿠키 없는 upgrade가 401난다) `연결 상태` 텍스트가 `ready`에 도달함(G1+G2)과 `이벤트 로그`에 `debug:echo:result`·에코 텍스트가 나타남(G3)을 web-first assertion(자동 재시도, 고정 sleep 없음)으로 단언한다.

compose는 선택적 `test` profile로 `docker compose --profile test run --rm test`가 `shared`·`client`·`server`(mongodb-memory-server 통합 테스트 제외) 유닛 스위트를 클린 컨테이너에서 실행하는 도커 재현 경로를 제공한다. 기본 `up`에는 포함되지 않으며, 커버리지 게이트는 호스트/CI가 담당한다.

## 제약사항

- **dev/test 전용** — `DEV_LOGIN_ENABLED`·시드 인증·`Dockerfile.dev`·compose 스택은 모두 dev/test 하네스다. 프로덕션 배포용 이미지 최적화·멀티스테이지 Dockerfile은 범위 밖이며, 프로덕션 Firebase 인증은 다루지 않는다(dev seed만).
- **수동 재연결만** — `WsClient.reconnect()`는 사용자가 트리거하는 명시 호출뿐이다. 자동 재연결·백오프·`session:resumed`를 통한 상태 복원 흐름은 이 토픽에 없다.
- **캐릭터 선택·게임플레이 뷰는 범위 밖** — 캐릭터 목록·선택·생성·진입 UI는 E10, 방·전투·인벤·채팅 등 게임플레이 뷰는 E11~E13(대응 프로토콜 미존재)이 소유한다. G3의 자동 `selectCharacter`는 오직 `command` 상태 도달을 위한 전송 배관이다.
- **CI 파이프라인 통합 없음** — 로컬 Docker 실행 절차만 다루며, CI 배선은 후속 토픽이다.
- **디자인·테마·레이아웃 폴리시 없음** — 컴포넌트는 최소 시맨틱 마크업만 제공한다(FE-6 경계).
- **인증·세션·핸드셰이크 로직은 소비만** — `preValidation` 게이트·버전 협상 상태표·세션 FSM 자체의 정본은 [`transport-protocol.md`](transport-protocol.md)·[`auth-session.md`](auth-session.md)이며, 이 문서는 그 계약을 client가 어떻게 소비하는지만 기술한다.
