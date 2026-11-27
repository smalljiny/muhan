# 전송 셸 (E9-1)

> React 웹 클라이언트가 dev 환경에서 서버 `/game` WebSocket에 인증 접속해 프로토콜 왕복(ClientCommand↔ServerEvent)을 증명하는 전송 기반 셸과, 이를 재현 가능하게 검증하는 로컬 Docker 개발/테스트 하네스.

## 개요

`packages/client`(React + Vite)에 WebSocket 전송 레이어·경량 UI·dev 인증 접속 연결을 세우고, `packages/server`에 dev 전용 로그인 엔드포인트와 env 기반 시드 인증 어댑터를 연결하며, docker-compose(server+mongo)와 호스트 Playwright e2e로 end-to-end 왕복을 검증한다.

이 계층은 [`transport-protocol.md`](transport-protocol.md)(E3-1)가 확립한 WS 핸드셰이크·라우터·하트비트와 [`auth-session.md`](auth-session.md)(E3-2)가 확립한 `preValidation` 인증 게이트·세션 FSM을 **소비**한다 — 둘 다 재구현하지 않고 그 계약(`shared/protocol`) 위에서 클라이언트를 붙인다. 캐릭터 선택 UI·게임플레이 뷰는 후속 에픽(E10~)이 담당하며, 이 토픽은 전송 기반을 증명하는 최소 셸에 한정한다.

## 구조 / 스키마

### 클라이언트 (`packages/client`)

- `src/transport/wsClient.ts` — 프레임워크 비의존 순수 TS `WsClient`. 연결/해제/수동 재연결, 송신 전 `clientCommandSchema` 검증, 수신 후 `serverEventSchema` parse, hello→ready 버전 협상, `sendEcho(text)` 송신을 제공한다. `SocketFactory`(테스트가 fake `SocketLike`를 주입하는 확장 지점(seam))로 실제 `WebSocket` 생성을 감싸고, 불변 `WsClientSnapshot`을 `subscribe`/`getSnapshot`으로 노출한다(React `useSyncExternalStore` 호환). 세션 진입 서브상태(`session`)와 사용자 조작 기반 명령(`selectCharacter`·`replyPrompt`)은 E10이 확장한다([`session-entry.md`](session-entry.md)). 수신 이벤트 기록 `events`는 `LoggedEvent { seq, event }`의 최근 `EVENT_LOG_LIMIT`(200)건만 유지한다 — `seq`는 인스턴스 단위로 0부터 단조 증가하며 재연결에도 이어지고(로그도 비우지 않는다), 상한으로 앞 항목이 빠져도 남은 항목의 `seq`·참조는 바뀌지 않는다. 전송 오류 `errors`는 최근 `TRANSPORT_ERROR_LIMIT`(50)건만 들어온 순서대로 유지한다. 상태 갱신(`dispatch`)은 원본 `ServerEvent`를 받는다.
- `src/transport/appendBounded.ts` — 끝에 항목을 덧붙이고 최근 `limit`건만 남긴 새 배열을 돌려주는 순수 헬퍼(입력 불변, `limit`이 1 이상 정수가 아니면 `RangeError`). `events`·`errors` 기록과 `presence.ts`의 통지 목록이 공유한다.
- `src/App.tsx` — 전송 셸 최상위. `WsClient`를 마운트 동안 단일 인스턴스로 유지하고 스냅샷을 구독해 하위 컴포넌트에 데이터·콜백을 주입한다. 게임 소켓 URL을 `window.location`에서 파생한다(하드코딩 host 없음 — same-origin이라야 쿠키가 upgrade에 첨부된다).
- `src/main.tsx` — React 마운트 엔트리(`#root`).
- `src/components/EventLog.tsx` — `WsClient`가 기록한 최근 `EVENT_LOG_LIMIT`건의 `LoggedEvent`를 순차 렌더하는 순수 표시 컴포넌트. 행은 `seq`를 키로 쓰는 `React.memo` 행(`EventLogRow`)이고 표시 문자열은 `useMemo`로 계산해, 같은 마운트에서 유지되는 행은 새 이벤트가 덧붙어도 다시 직렬화하지 않는다(`App`의 `entered`/`resumed` 분기를 벗어났다 돌아와 재마운트되는 경우는 보장 밖). 각 행은 `<span>type</span> <code>표시 문자열</code>`이다.
- `src/components/describeEvent.ts` — 행 표시 문자열을 만드는 순수 함수. `world:room`은 `<방 이름> (#<roomId>)` 한 줄로 요약하고(직렬화하지 않음), 그 밖의 타입은 원시 JSON(`JSON.stringify(event)`)을 돌려준다.
- `src/components/CommandInput.tsx` — 텍스트 입력 폼. submit 시 주입된 `onSubmitEcho` 콜백을 호출한다. `disabled`가 참이면 제출 버튼을 비활성화하고 submit 핸들러도 송신하지 않는다(입력란은 유지). `App`은 전송 `status`가 `ready`가 아닐 때 `disabled`를 넘긴다([`session-entry.md`](session-entry.md)).
- `src/components/ConnectionStatus.tsx` — 연결 상태 표시 + 수동 재연결 버튼(`onReconnect` 콜백).
- `vite.config.ts` — React 플러그인, dev 프록시(`/game`·`/dev/login`), `shared`/`shared/protocol` 소스 alias.
- `vitest.config.ts` — jsdom + React Testing Library 유닛 하네스, 동일 `shared` 소스 alias, 커버리지 80%+ 게이트.
- `playwright.config.ts` — 호스트 Playwright e2e 설정. `webServer`는 호스트 Vite(5173)만 실행한다.
- `e2e/transport.spec.ts` — compose 스택을 SUT로 삼는 실브라우저 왕복 검증.

### 서버 dev 연결 (`packages/server/src/auth`, `config/env.ts`, `app.ts`, `index.ts`)

- `devLoginRoute.ts` — `registerDevLoginRoute(app, seedCookie)`. `GET /dev/login`을 등록해 `Set-Cookie: __session=<seedCookie>; Path=/; HttpOnly`를 응답한다.
- `devSeedSessionAuth.ts` — `createDevSeedAuthAdapter(cookie, accountId)`(순수 팩토리)와 `createDevSeedAuthAdapterFromEnv(config)`(env 래퍼). 시드 쿠키→accountId 매핑과 고정 캐릭터 1개(`DEV_SEED_CHARACTER`)를 담은 `InMemorySessionAuthAdapter`를 조립한다.
- `config/env.ts` — `DEV_LOGIN_ENABLED`(`z.enum(['true','false']).default('false').transform(...)`)·`DEV_SEED_COOKIE`·`DEV_SEED_ACCOUNT_ID` 필드와, `getConfig()` 내부의 `NODE_ENV` fail-closed 2차 게이트.
- `app.ts` — `buildApp(deps)`가 `deps.devLoginSeedCookie`가 주어질 때만 `registerDevLoginRoute`를 호출한다(미주입 시 라우트 없음).
- `devSeedCharacter.ts` — `buildDevSeedCharacterDoc(accountId)`(순수 함수)는 `DEV_SEED_CHARACTER`에 대응하는 영속 `Character` 문서를 만든다. 식별·요약 필드는 `DEV_SEED_CHARACTER`, vitals·spell store·`schemaVersion`은 생성 경로와 같은 `seedVitals`·`seedSpellStore`·`CURRENT_CHARACTER_SCHEMA_VERSION`(`repo/characterBackfill.ts`), 시작 방·소지금은 `characterStartDefaults.ts`에서 가져온다. `experience`·`status`·`stats`·`alignment`만 시드 고정값이다. `seedDevCharacter(repo, accountId)`는 이 문서를 `insertIfAbsent`로 없을 때만 넣고(`'inserted'`), 이미 있으면 정합만 확인한다(`'kept'`).
- `characterStartDefaults.ts` — 신규 캐릭터 시작 기본값 `START_ROOM`(1)·`STARTING_GOLD`(500). 생성 경로(`firebaseSessionAuthAdapter.ts`)와 dev 시드가 함께 쓴다.
- `sessionAuthAssembly.ts` — `assembleSessionAuth(config, { accounts, characters, createVerifier })`가 세션 인증 분기를 맡는다. `DEV_LOGIN_ENABLED`가 false면 Firebase 어댑터를 조립하고(빈 `FIREBASE_PROJECT_ID` fail-fast), true면 dev 시드 어댑터를 조립한 뒤 시드 캐릭터를 보장해 `{ sessionAuth, devLoginSeedCookie, devSeedResult }`를 돌려준다. firebase-admin을 import하지 않도록 verifier 팩토리를 `createVerifier`로 주입받는다.
- `index.ts` — 부팅이 `buildApp` 앞에서 `assembleSessionAuth`를 `await`하고, 돌려받은 `sessionAuth`·`devLoginSeedCookie`를 `buildApp`에 주입한다. `buildApp` 직후 `devSeedResult`가 있으면 `dev seed character dev-char-1: inserted|kept` info 로그를 남긴다.

`WS_ALLOWED_ORIGINS`([`auth-session.md`](auth-session.md) E3-2 담당 필드)는 E9-1이 새로 정의하지 않지만, compose·Vite 설정이 이 값을 dev origin(`http://localhost:5173`)으로 채운다.

### 하네스 (레포 루트)

- `docker-compose.yml` — `mongo`(로컬 DB, healthcheck) + `server`(`Dockerfile.dev`로 빌드, `mongo` 헬시 대기 후 시작, dev 로그인·시드 env 주입) + 선택적 `test` profile(유닛 스위트를 도커에서 재현, 기본 `up` 미포함).
- `Dockerfile.dev` — `node:24-slim` 기반, 워크스페이스 전체를 install하고 `shared`만 빌드한 뒤 `tsx`로 서버 소스를 직접 실행. 프로덕션 멀티스테이지 최적화는 다루지 않는다.
- `.dockerignore` — `node_modules`/`dist`/워크트리 하네스 심볼릭 링크(`.claude`·`.codex` 등)·시크릿·`docs`·`legacy`를 빌드 컨텍스트에서 제외한다.
- `packages/shared/package.json` — `./protocol` subpath export(`dist/protocol/index.js`)로 클라이언트가 `shared/protocol`을 패키지 진입점으로 import할 수 있게 한다(Vite/Vitest는 이를 소스로 alias-override한다 — 아래 참조).

## 동작

### G1 — dev 인증 접속

브라우저가 `GET /dev/login`을 호출하면(Vite가 API 서버로 same-origin 프록시) 서버가 `Set-Cookie: __session=<시드값>; Path=/; HttpOnly`를 응답한다. `Secure` 속성은 붙이지 않는다 — dev는 평문 loopback(http/ws)이므로 `Secure`를 붙이면 브라우저가 쿠키를 첨부하지 않아 upgrade가 실패한다(이 속성이 G1의 실제 실패점이었다). 이후 클라이언트가 같은 origin(`ws://localhost:5173/game`)으로 접속하면 브라우저가 `__session` 쿠키를 WS upgrade 요청에 자동 첨부하고, Vite 프록시가 이를 API 서버로 그대로 전달한다. 서버 `preValidation`([`auth-session.md`](auth-session.md))이 Origin allowlist와 세션 쿠키를 검증해 `DEV_SEED_ACCOUNT_ID` 신원으로 통과시킨다.

dev 로그인은 **이중 fail-closed 게이트**로 보호한다.

1. `DEV_LOGIN_ENABLED` env 플래그(기본 `false`)가 `/dev/login` 라우트 마운트와 시드 어댑터 연결을 게이트한다. `z.enum(['true','false']).transform(...)`으로 파싱해 `z.coerce.boolean`이 비어있지 않은 문자열 `"false"`를 `true`로 강제하는 함정을 피한다.
2. `getConfig()`가 2차 방어선으로, `DEV_LOGIN_ENABLED=true`인데 `NODE_ENV`가 명시적으로 `development`/`test`가 아니면(production·미설정·기타 값 포함) 부팅을 fail-fast로 차단한다. 플래그 하나만으로 dev 인증 우회가 프로덕션에 잔존하는 경로를 코드 레벨에서 막는다.

시드 인증은 프로덕션 격리를 존중한다. `devSeedSessionAuth.ts`는 하드코딩 유효 쿠키 상수를 담은 `seedSessionAuth.testutil.ts`(빌드에서 제외되는 test-only 모듈)를 import하지 않는다. 대신 런타임 env(`DEV_SEED_COOKIE`/`DEV_SEED_ACCOUNT_ID`)에서만 시드 값을 읽어 어댑터를 조립하므로, 이 모듈이 `dist`에 나가도 유효 쿠키 문자열은 컴파일 산출물에 실리지 않는다. 값이 비어 있으면(cookie·accountId 중 하나라도 빈 문자열) 조립을 fail-fast로 거부한다 — 플래그가 켜졌는데 시드 값이 없으면 무의미한 빈 쿠키가 배포되는 오설정을 조기에 막는다. `DEV_LOGIN_ENABLED`가 false이거나 없으면 `buildApp`은 라우트를 마운트하지 않고 기존 빈 `InMemorySessionAuthAdapter`(유효 쿠키 0개) 경로를 그대로 유지한다.

Vite 프록시(`vite.config.ts`)는 CSWSH를 브라우저 실제 Origin으로 방어한다 — `changeOrigin:false`(`rewriteWsOrigin` 미사용)로 프록시가 브라우저 Origin을 조작하지 않고 서버에 그대로 전달하고, `server.port: 5173` + `strictPort: true`로 포트를 고정한다. 포트가 드리프트하면(예: 5174로 밀림) 서버 `WS_ALLOWED_ORIGINS` allowlist와 불일치해 403이 나므로, `strictPort`가 이 대조를 결정적으로 만든다.

### G2 — 버전 협상

`WsClient`가 `system:hello` 수신 시 `system:ready{protocolVersion: PROTOCOL_VERSION}`을 송신해 상태를 `negotiating`으로 전환한다. 서버측 핸드셰이크 전이표는 [`transport-protocol.md`](transport-protocol.md)의 계약을 그대로 따른다(이 토픽은 재구현하지 않음).

### G3 — 프로토콜 왕복

`WsClient`는 모든 송신 `ClientCommand`를 `clientCommandSchema.safeParse`로, 모든 수신 프레임을 `serverEventSchema.safeParse`로 검증한다. 검증에 실패하면 throw하지 않고 관측 가능한 `WsClientSnapshot.errors`에 누적한다(최근 `TRANSPORT_ERROR_LIMIT`건) — 상태 전이·이벤트 기록에 도달하지 않으므로 실패가 무증상으로 묻히지 않는다.

서버 세션 FSM([`auth-session.md`](auth-session.md))은 `command` 상태에 도달해야 `debug:echo`를 라우팅한다. E9-1은 이 경로를 성립시키려 `session:characterList` 수신 시 첫 캐릭터를 1회 자동 선택하는 스텁을 두었으나, E10이 이를 사용자 조작 기반 캐릭터 선택·생성 UI로 대체했다([`session-entry.md`](session-entry.md)) — 목록 렌더·선택·생성/재개는 이제 그 계층이 담당한다. `session:entered`/`session:resumed` 수신 시 상태를 `ready`로 전환한다(echo 가능). `EventLog`는 수신 이벤트를 type + 원시 JSON으로 표시하는(`world:room`만 한 줄 요약) 진입 후 placeholder 셸의 일부다.

`ready` 상태에서 `CommandInput`이 텍스트를 `sendEcho(text)`로 넘기면 `debug:echo` ClientCommand가 송신되고, 서버가 되돌린 `debug:echo:result`가 `EventLog`에 나타나 왕복을 증명한다.

`shared`/`shared/protocol`은 Vite·Vitest 설정 모두 패키지 `exports`(→ git-ignored `dist`)가 아니라 소스(`../shared/src/index.ts`, `../shared/src/protocol/index.ts`)로 alias 해석한다. clean checkout에서 `shared`를 먼저 빌드하지 않아도 client의 dev·build·test·e2e가 모듈 해석에 실패하지 않는다(패키지 `exports`는 그대로 두어 dist 기준 소비자와의 호환은 유지한다).

### G4 — 로컬 Docker 검증

`docker compose up`이 `mongo`(healthcheck 통과 대기) 뒤에 `server`를 시작한다. 서버 컨테이너는 `MONGODB_URI=mongodb://mongo:27017`(외부 Atlas 비의존), `WS_ALLOWED_ORIGINS=http://localhost:5173`, `DEV_LOGIN_ENABLED=true` + 시드 값을 env로 받는다.

dev 로그인으로 부팅한 서버는 `buildApp`·listen 전에 시드 캐릭터 `dev-char-1`을 `characters` 컬렉션에 보장한다. 그래야 인메모리 인증 목록(`DEV_SEED_CHARACTER`)과 hydrate 소스(DB)가 같은 캐릭터를 본다. 순서는 dev 어댑터 조립(쿠키·계정 ID 검증) → 시드 → `buildApp`이라, 설정이 잘못되면 시드를 쓰기 전에 부팅이 멈춘다. 부팅 시 DB 상태별 결과는 다음과 같다.

| 부팅 시 `dev-char-1` | 결과 |
|---|---|
| 없음 | 삽입, `inserted` 로그 |
| 시드 계정 소유, 정규화한 `status`가 `active`(필드가 없는 옛 문서 포함) | 바꾸지 않음, `kept` 로그. 쌓인 진행 상태를 보존한다 |
| 다른 계정 소유 | 부팅 실패. 오류에 문서 id, 기대·실제 `accountId`, 해결 방법(문서 삭제 또는 `DEV_SEED_ACCOUNT_ID` 수정)을 담는다 |
| `status: 'deleted'` | 부팅 실패. 되살리지 않고 해결 방법(문서 삭제)을 담는다 |
| 다른 `_id`가 시드 이름을 가짐 | `name` unique 인덱스의 E11000을 전파해 부팅 실패 |

정합 실패 메시지는 `dev 시드 캐릭터 정합 실패:`로 시작한다. `assembleSessionAuth`는 `getConfig()`와 같은 `NODE_ENV`(development·test) 조건을 직접 확인해, 다른 경로로 만든 config로도 dev 경로가 열리지 않게 한다.

Playwright e2e(`e2e/transport.spec.ts`)는 호스트에서 실행하며 compose(server+mongo)를 SUT로 삼는다 — `playwright.config.ts`의 `webServer`는 호스트 Vite(5173)만 실행하고, compose 스택은 caller가 `docker compose up -d --build`로 미리 띄운다. compose는 서버 listen을 기다리지 않으므로 README 절차의 2단계가 `/health`를 폴링해(전체 기한 60초, 요청마다 `--max-time 2`) `status`가 `ok`가 된 뒤에만 `pnpm --filter client e2e`를 실행한다. 시드가 listen 전에 끝나므로 `/health`가 `ok`라는 것은 시드도 끝났다는 뜻이다. 대기는 서브셸 안에서 돌아, 시간 초과(실제 최대 약 63초) 시 사용자의 셸을 닫지 않고 종료 코드 1로 끝나며 e2e는 실행되지 않는다. 각 테스트는 `beforeEach`에서 `/dev/login`으로 쿠키를 먼저 심은 뒤 앱을 로드하고(순서가 바뀌면 쿠키 없는 upgrade가 401난다), 캐릭터 목록이 도착하면 시드 캐릭터의 '선택' 버튼을 눌러(autoSelect 스텁 제거 후 진입은 사용자 조작 기반 — [`session-entry.md`](session-entry.md)) `연결 상태` 텍스트가 `ready`에 도달함(G1+G2)과 `이벤트 로그`에 `debug:echo:result`·에코 텍스트가 나타남(G3)을 web-first assertion(자동 재시도, 고정 sleep 없음)으로 단언한다.

compose는 선택적 `test` profile로 `docker compose --profile test run --rm test`가 `shared`·`client`·`server`(mongodb-memory-server 통합 테스트 제외) 유닛 스위트를 클린 컨테이너에서 실행하는 도커 재현 경로를 제공한다. 기본 `up`에는 포함되지 않으며, 커버리지 게이트는 호스트/CI가 담당한다.

## 제약사항

- **dev/test 전용** — `DEV_LOGIN_ENABLED`·시드 인증·`Dockerfile.dev`·compose 스택은 모두 dev/test 하네스다. 프로덕션 배포용 이미지 최적화·멀티스테이지 Dockerfile은 범위 밖이며, 프로덕션 Firebase 인증은 다루지 않는다(dev seed만).
- **수동 재연결만** — `WsClient.reconnect()`는 사용자가 트리거하는 명시 호출뿐이다. 자동 재연결·백오프·`session:resumed`를 통한 상태 복원 흐름은 이 토픽에 없다.
- **캐릭터 선택·게임플레이 뷰는 범위 밖** — 캐릭터 목록·선택·생성·진입 UI는 E10([`session-entry.md`](session-entry.md)), 방·전투·인벤·채팅 등 게임플레이 뷰는 E11~E13(대응 프로토콜 미존재)이 담당한다. E9-1이 두었던 자동 `selectCharacter` 스텁은 E10이 사용자 조작 기반 선택으로 대체했다.
- **CI 파이프라인 통합 없음** — 로컬 Docker 실행 절차만 다루며, CI 연결은 후속 토픽이다.
- **디자인·테마·레이아웃 폴리시 없음** — 컴포넌트는 최소 시맨틱 마크업만 제공한다(FE-6 경계).
- **인증·세션·핸드셰이크 로직은 소비만** — `preValidation` 게이트·버전 협상 상태표·세션 FSM 자체의 기준은 [`transport-protocol.md`](transport-protocol.md)·[`auth-session.md`](auth-session.md)이며, 이 문서는 그 계약을 client가 어떻게 소비하는지만 기술한다.
