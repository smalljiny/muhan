# E3-2 인증·세션 FSM: Research Report
*Generated: 2026-07-08 | Sources: 22 | Adapters: [exa] | Failed: none*

> E3-2(인증·세션 FSM) 스펙 브레인스토밍용 배경 조사. Firebase 세션 쿠키 기반 WS 핸드셰이크 인증, CSWSH/Origin 방어, 서버 주도 세션 상태머신(FSM)·prompt/response 다단, SessionAuthPort DIP seam의 선례·보안 패턴을 정리한다.

## Executive Summary

Firebase 세션 쿠키는 `createSessionCookie(idToken, {expiresIn})`로 서버가 발급하고 `verifySessionCookie(cookie, checkRevoked?)`로 검증하는, **최대 2주 유효기간의 서버 제어 세션 프리미티브**다 — 짧은 ID 토큰(≈1시간)과 달리 stateful 백엔드 세션에 맞고, 검증 후 서버가 권한 검사를 직접 수행해야 한다. WebSocket 인증은 **소켓이 열리기 전 HTTP upgrade 단계에서** 게이트해야 하며, `@fastify/websocket`은 `preValidation` 훅에서 쿠키를 검증하고 401로 upgrade를 중단하는 것이 관용 패턴이다(`ws`의 `verifyClient`는 maintainer가 공식 deprecate). 쿠키 기반 WS는 **CSWSH(CWE-1385)** 에 취약하므로 Origin allowlist(서버측·명시 목록) + `SameSite` + `HttpOnly`/`Secure`를 방어선으로 함께 건다. 세션 수명주기는 연결당 FSM(상태 enum + 핸들러 맵, `onEnter`/`handleInput`/`onExit`)로 모델링하는 것이 MUD·연결 서버의 정설이며, 상태 전이 부수효과는 enter/exit 콜백에 두고 prompt/response 다단은 correlation id로 짝짓는다. 인증은 **소비자(게임 패키지)가 소유하는 포트**(`SessionAuthPort`)로 추상화하고, firebase-admin 어댑터와 인메모리 stub 어댑터(모의가 아닌 실 계약 구현)를 조립 지점에서 주입한다 — Firebase Auth는 로컬 에뮬레이터가 없어 DIP seam이 결정적 테스트의 유일한 클린 경로다.

## 1. Firebase 세션 쿠키 인증

**핵심 메커니즘.** 클라이언트가 갓 발급받은 ID 토큰을 Admin SDK로 교환해 쿠키 JWT를 만든다: `createSessionCookie(idToken, { expiresIn })`. 서버는 이를 `HttpOnly`·`Secure` 쿠키로 세팅하고, 이후 요청에서 `verifySessionCookie(sessionCookie, checkRevoked?)`로 디코딩된 클레임을 검증한다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 시그니처는 `createSessionCookie(idToken: string, options): Promise<string>` / `verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>` ([SessionCookieOptions | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.sessioncookieoptions)).

**세션 쿠키 vs ID 토큰.** 세션 쿠키는 원본 ID 토큰과 같은 클레임(uid·roles 등)을 이어받되, **서버 제어 유효기간(최대 2주)** 을 갖는다 — ID 토큰은 ≈1시간 만료로 클라이언트 보관·빈번 갱신용, 세션 쿠키는 stateful 서버 세션용 프리미티브다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 커스텀 유효기간 때문에 **세션 쿠키는 다른 Firebase 서비스와 함께 쓸 수 없다** — 오직 자체 백엔드 세션 관리용이다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)).

**발급 제약.** `expiresIn`은 2주 상한 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 쿠키 발급 전 사용자가 **최근 로그인**했는지(ID 토큰의 `auth_time`) 확인하는 것이 권장된다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)).

**폐기(revocation).** 두 층: (a) `verifySessionCookie`에 `checkRevoked=true`를 주면 사용자 비활성(`auth/user-disabled`)·세션 폐기(`auth/session-cookie-revoked`)까지 확인하되 **검증당 네트워크 요청 1회가 추가**된다(지연 ↔ 즉시 무효화 트레이드오프). (b) 강제 폐기는 refresh 토큰 무효화(`revokeRefreshTokens`) 또는 자체 서버측 폐기 플래그로 구현하고 `checkRevoked`로 강제한다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies); [Manage User Sessions | Firebase](https://firebase.google.com/docs/auth/admin/manage-sessions)).

**보안 관행(공식).** 쿠키는 `HttpOnly`+`Secure`(+`SameSite`); **ID 토큰→세션 쿠키 교환 엔드포인트에 CSRF 방어** 적용; 제한 콘텐츠 제공 전 서버 검증; 무효 쿠키는 즉시 clear 후 재인증 강제 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). Admin SDK는 공개키를 자동 캐시해 지연을 줄인다 ([Verify ID Tokens | Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens)).

## 2. WebSocket 핸드셰이크 쿠키 인증 (preValidation)

**upgrade 이후가 아니라 upgrade 단계에서 인증.** WS 연결은 브라우저 쿠키를 실은 HTTP upgrade 요청으로 시작한다. 인증은 upgrade **완료 전** 게이트해 미인증 클라이언트가 소켓을 얻지 못하게 한다.

**Fastify `preValidation` 패턴.** `@fastify/websocket` 라우트는 Fastify 플러그인 수명주기를 따른다 — 연결 수립 **전**에 도는 `onRequest`/`preParsing`/`preValidation`/`preHandler` 훅이 모두 호출되며 "인증 등 요청 레벨 처리에 쓸 수 있다" ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)). 문서화된 패턴은 `preValidation` 훅에서 쿠키/헤더를 검사하고 실패 시 `401`로 응답해 upgrade를 중단하는 것이다. 이 pre-upgrade 훅은 Fastify HTTP 수명주기 안이라 예외가 표준 `setErrorHandler`로 처리되지만, **소켓 수립 후엔** 플러그인 자체 errorHandler로 넘어가 message 핸들러 안에서 예외를 잡아야 한다 ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)) — E3-1 `plugin.ts`의 message 핸들러 try/catch 격리와 정합한다.

**수명주기 함정(쿠키/세션 인증 시 중요).** WS 라우트 핸들러는 `on('message')` 리스너를 핸들러 실행 중 **동기적으로** 붙여야 한다. 세션/유저 로드 같은 async 작업을 먼저 하면 early 메시지가 조용히 드롭된다 — await *전에* message 핸들러를 붙여라 ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)). E3-1이 `system:hello`를 `setImmediate`로 지연한 것과 같은 레이스 클래스다. `preSerialization`/`onSend`는 WS 라우트에서 **돌지 않는다** ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)).

**`ws`의 `verifyClient`가 deprecate된 이유(1차 출처).** 공식 `ws` 문서: "`verifyClient` 사용은 discouraged. 대신 서버 `upgrade` 이벤트를 구독"해 `handleUpgrade` 전에 인증하라 ([ws/doc/ws.md](https://github.com/websockets/ws/blob/master/doc/ws.md)). 이 결정은 **PR #1613(2019-08 머지)** 로 반영됐고 ([ws PR #1613](https://github.com/websockets/ws/pull/1613)), 근거(issue #377)는 `verifyClient`가 `handleUpgrade()`를 async로 강제하는 "기술 부채"라는 것 — 권장은 HTTP `upgrade` 이벤트에서 인증 후 `handleUpgrade`를 호출해 인증된 신원을 `connection` 이벤트로 넘기는 것이다 ([ws issue #377](https://github.com/websockets/ws/issues/377)). Fastify 스택에선 `preValidation`이 관용 게이트라 이 문제는 무관하다. (참고: OWASP 치트시트는 여전히 `verifyClient`를 origin/auth 검사 지점으로 언급하나, `ws`에 한해선 라이브러리 자체 문서를 정본으로 본다 ([OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)).)

## 3. CSWSH & Origin allowlist 방어

**공격.** CSWSH("WebSocket의 CSRF")는 WS 핸드셰이크가 HTTP 쿠키에만 의존하고 CSRF 방어·예측불가 토큰이 없을 때 발생한다. 브라우저가 피해자 쿠키를 핸드셰이크에 자동 첨부하고, **WS는 `fetch`처럼 Same-Origin Policy/CORS에 구속되지 않는다** ([Cross-site WebSocket hijacking | PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking); [OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)). 타 출처 악성 페이지가 로그인된 피해자로서 WS를 열어 양방향 상호작용 — 임의 메시지 전송(피해자 행위 수행)·서버 응답 읽기(데이터 탈취) — 을 얻는다 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)).

**취약 근거.** "WebSocket엔 내장 인증이 없다. 브라우저가 핸드셰이크에 쿠키를 포함해 CSWSH에 취약하다" ([OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)). 명명된 약점: **CWE-1385: Missing Origin Validation in WebSockets** ([CWE-1385 | MITRE](https://cwe.mitre.org/data/definitions/1385.html)). 실제 영향은 심각 — Gitpod 2023 CSWSH는 불충분한 origin 검증으로 계정 탈취를 허용했다 ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)).

**1차 방어 — Origin allowlist.** 모든 WS 핸드셰이크에서 `Origin` 헤더를 서버측 검증하되 **명시 allowlist**(예 `https://app.example.com`)와 대조한다. denylist·와일드카드 금지, 연결 수립 전 검사 ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet); [CWE-1385](https://cwe.mitre.org/data/definitions/1385.html)). 주의: `Origin`은 *브라우저* 공격자엔 신뢰 가능(브라우저가 정직히 설정, JS 위조 불가)하나 비브라우저 클라이언트는 스푸핑 가능 — 즉 CSWSH 방어이지 일반 인증이 아니다 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)).

**심층 방어.** (a) **SameSite 쿠키**(`Lax`/`Strict`)로 브라우저가 교차 사이트 핸드셰이크에 쿠키를 안 붙이게 해 쿠키 층에서 차단 ([OWASP SameSite](https://owasp.org/www-community/SameSite)). (b) **핸드셰이크에 예측불가 CSRF 토큰** 결합 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking); [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)). (c) 쿠키 `HttpOnly`+`Secure` 유지. **설계 함의:** Firebase 세션 쿠키로 `preValidation`에서 WS upgrade를 게이트하고, 같은 훅에 strict `Origin` allowlist를 추가하며 쿠키를 `SameSite`+`HttpOnly`+`Secure`로 세팅 — 이 조합이 CSWSH 클래스(CWE-1385)를 올바른 수명주기 지점에서 직접 방어한다.

## 4. 세션/연결 FSM 패턴 + server-driven prompt/response

**핵심 패턴: 연결당 FSM(상태 enum + 핸들러 맵).** MUD·연결 지향 서버의 정설은 각 연결에 자체 FSM 인스턴스를 부여해 수명주기(connect → authenticate → character-select → in-game)를 추적하는 것 — I/O 루프에 `if(loggedIn)`을 흩뿌리지 않는다. 상태·전이 로직을 연결당 Session 객체에 캡슐화하고 I/O 준비·타임아웃을 상태머신 이벤트로 다루라는 권고 ([Generic Architecture for a Network Server/Client using a State Machine | Stack Overflow](https://stackoverflow.com/questions/300289/generic-architecture-for-a-network-server-client-using-a-state-machine)).

**`onEnter`/`handleInput`/`onExit` 상태 객체 인터페이스.** TS풍 MUD 선례: 각 클라이언트를 `onEnter`·`handleInput`·`onExit`를 가진 `State` 인터페이스로 다스리고 전이는 명시적 — `ConnectingState → LoginState → AuthenticatedState ⇄ CombatState`, `DisconnectedState`가 off-ramp. `AuthenticatedState`가 주 명령 디스패치 상태다 ([ellymud architecture.md](https://github.com/ellyseum/ellymud/blob/main/docs/architecture.md)). Node/TS 설계로 직결: `ConnectionState` enum + `Record<ConnectionState, StateHandler>` 핸들러 맵, 각 핸들러가 자기 prompt(`onEnter`)·입력 파싱(`handleInput`)을 소유.

**고전 MUD 상태 enum이 필요한 상태를 검증한다.** LuminariMUD 로그인 흐름은 단일 디스패치(`nanny()`)가 연결 상태 enum을 돈다: `CON_ACCOUNT_NAME → CON_PASSWORD → CON_ACCOUNT_MENU → (캐릭터 선택/생성: CON_GET_NAME, CON_QSEX, CON_QRACE, CON_QCLASS, CON_QCONFIRM) → CON_MENU → CON_PLAYING`, disconnect-pending용 `CON_CLOSE`. 각 상태가 prompt·검증을 정하고 비번은 실패 횟수를 임계까지 추적 후 종료 — **계정 인증과 다중 캐릭터 계정의 character-select 메뉴를 분리**한 형태로, `SessionAuthPort`의 `listCharacters`/`createCharacter`와 정확히 대응 ([LuminariMUD PLAYER_MANAGEMENT_SYSTEM.md](https://github.com/LuminariMUD/Luminari-Source/blob/4b6550541db6dbb227f9b240d261c15417c19898/docs/systems/PLAYER_MANAGEMENT_SYSTEM.md)). `tinymudserver`도 C++로 같은 패턴(`eAwaitingName`/`eAwaitingPassword`/`ePlaying` 등), `ePlaying` 진입 전이에 `EnteredGame` 부수효과 1개(인사·MOTD·초기 `look`·입장 브로드캐스트)를 둔다 ([tinymudserver states.cpp](https://github.com/nickgammon/tinymudserver/blob/master/states.cpp)).

**부수효과는 전이(enter/exit)에, 인라인 금지.** Erlang `gen_statem` 연결 매니저는 성숙판을 보여준다: `enter` 이벤트가 모든 전이에 발화해 리소스 부수효과의 지정 지점이 되고, init에서 즉시 반환한 뒤 내부 `:connect` 이벤트로 논블로킹 백그라운드 연결을 한다(Node 이벤트 루프에 유용) — 실패 전이엔 **back-off**를 두어 tight 재연결 루프를 피하라 ([Persistent connections with gen_statem — Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/)).

**server-driven prompt/response + correlation id(단일 소켓 다단).** 두 독립 출처가 request-id 상관 패턴을 확립: `gen_statem` 매니저는 `request_id → caller` 맵으로 in-flight 요청을 추적하고 응답을 id로 짝짓는다 ([Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/)). WS 앱 계층 역설계 명세도 같은 아이디어: `type` 필드로 디스패치하는 NDJSON에서 각 `control_request`가 UUID `request_id`로 prompt-응답을 상관지어 턴 간 신뢰 pairing을 하고, UUID는 재연결 시 중복/재생 감지에도 쓰인다 ([takode WEBSOCKET_PROTOCOL_REVERSED.md](https://github.com/MrVPlusOne/takode/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md)). MUD 번역: 서버가 구조화 prompt 이벤트(`{type:"prompt", id, subState}`)를 내고 클라가 `{type:"reply", id, value}`로 답하며, reply의 `id`가 대기 중 prompt와 일치할 때만 FSM이 서브상태를 진행 — E3-1의 correlationId 반향 규약을 재사용한다.

**결합 client/server 상태머신 + 조인트 전이표.** Python `h11`은 client·server 상태머신을 *분리*해 두고 "joint" 전이표를 둔다 — 특정 (client, server, keep-alive) 조합이 조율된 전이(`MUST_CLOSE` 등)를 자동 트리거 ([h11._state](https://h11.readthedocs.io/en/latest/_modules/h11/_state.html)). MUD 로그인엔 과하나 "흩뿌린 조건문 대신 명시 전이표" 원칙을 프로토콜 레벨에서 검증.

**Node/TS 종합:** WS당 `Session` 객체가 `ConnectionState` enum을 보유; `Record<ConnectionState, StateHandler>`에서 `StateHandler`는 `onEnter(session)`(prompt 이벤트 발화)·`handleInput(session, msg)`(상관 reply 파싱→다음 상태)·선택 `onExit`; 전이 부수효과(캐릭터 로드·입장 브로드캐스트)는 enter/exit에; prompt는 클라가 반향하는 correlation `id`를 싣는다.

## 5. DIP / Ports & Adapters — SessionAuthPort

**핵심 원칙: 포트 인터페이스는 소비자(고수준 모듈)가 소유한다.** `SessionAuthPort`를 소비자 패키지에 두는 근거 그 자체다. DIP를 날카롭게: "추상화는 고수준 모듈이 소유하고 저수준 모듈이 구현한다." 인터페이스를 구현 옆에 정의해 인프라 네임스페이스가 소유하는 것은 **위반**이며, 해법은 인터페이스 소유권을 도메인으로 이전하고 도메인 어휘로 명명하는 것 ([Dependency Inversion Implies Interfaces Are Owned by High-level Modules — Mikhail Shilkov](https://mikhail.io/2016/05/dependency-inversion-implies-interfaces-are-owned-by-high-level-modules/)). Martin Fowler도 DIP는 인터페이스의 *형태·추상화 수준*에 관한 것이며 기술이 아닌 도메인/사용자 목표를 반영해야 한다고 강조(비즈니스 로직은 POJO, 저수준은 도메인 인터페이스 뒤 어댑터로) ([DIP in the Wild — Martin Fowler](https://martinfowler.com/articles/dipInTheWild.html)). → `SessionAuthPort` 메서드(`validateSessionCookie`·`listCharacters`·`createCharacter`·`assertOwnership`)는 firebase-admin API가 아니라 게임의 세션/계정 어휘로 표현하고, firebase 어댑터가 둘을 번역한다.

**포트는 앱이 필요로 하는 것으로 정의(인프라 제공물이 아님).** "Port는 앱과 외부의 경계 인터페이스다. 포트는 인프라가 제공하는 것이 아니라 앱이 필요로 하는 것으로 정의된다." 조립 루트가 DI로 포트↔어댑터를 배선하고, 테스트에선 "실 어댑터를 test double(인메모리 repo)로 교체해 비즈니스 로직을 격리 테스트" — 구체부터 시작해 유연성·테스트가 필요할 때 인터페이스를 추출하라 ([Dependency Inversion & Ports/Adapters — Synapse Studios](https://docs.synapsestudios.com/concepts/architecture/dependency-inversion)).

**인메모리 stub 어댑터는 mock이 아니라 진짜 어댑터 — 같은 계약을 만족한다.** 테스트 가능성의 핵심: 인메모리 테스트 어댑터는 *인메모리 저장소를 쓰는 포트 계약의 실 구현*으로 "mock이 아니라 프로덕션 어댑터와 같은 계약을 만족"한다 — 테스트는 의존을 수기 배선하고 내부 호출 그래프가 아닌 상태 결과를 단언하며 프레임워크 부팅·마이그레이션·트랜잭션 없이 돈다. 정적 분석으로 앱 코드가 포트 인터페이스만 import하도록 경계를 강제 ([Hexagonal Architecture in Practice — dev.to/tacoda](https://dev.to/tacoda/hexagonal-architecture-in-practice-ports-adapters-and-tests-that-skip-the-database-5b19)). → `InMemorySessionAuthAdapter`는 `SessionAuthPort` 전체 계약을 구현(validate는 구조적으로 유효한 세션 반환, `assertOwnership`은 불일치 시 throw)해 FSM/세션 테스트가 firebase 어댑터와 같은 경로를 태운다.

**Firebase Auth는 Admin auth 경로의 로컬 에뮬레이터가 없어 어댑터+test double이 필수.** Firebase Authentication은 `mongodb-memory-server`처럼 로컬 인메모리로 테스트할 수 없고, 권장은 "`admin.auth()` 둘레에 어댑터 층을 두고 단위 테스트용 test double(mock/stub)을 제공"하는 것 ([Unit testing firebase admin SDK authentication — Stack Overflow](https://stackoverflow.com/questions/63163853/unit-testing-firebase-admin-sdk-authentication-on-node-js)). 즉 `SessionAuthPort` seam은 선택이 아니라 빠른·결정적 테스트의 유일한 클린 경로다. (에뮬레이터 공백은 Auth 제품에 한정 — Firestore는 인메모리 mock이 별도로 존재.)

**참조 아키텍처 — 모든 외부 의존을 포트 뒤에, 클래스 하나로 교체.** `odysseon/auth`(NestJS)는 헥사고날 기반 identity-only 인증 모듈 선례: "포트가 모듈이 필요로 하는 것을 정의하고 앱이 어댑터를 제공", ORM/DB·라이브러리 불가지, 모든 외부 npm 의존이 포트 뒤에 있어 "`Bearer header` → cookie를 클래스 하나 교체로" 전환(코어 로직 변경 0). 레이어링 `interfaces/ports/`(무의존, "inversion anchor") ← `adapters/` ← `core/`가 소비자-소유-포트 구조 그 자체이며 명시적으로 *identity only*("누구인가 — 무엇이 허용되는가가 아님")로 스코프를 한정 ([odysseon/auth](https://github.com/odysseon/auth/)). → `SessionAuthPort`에 대응: `validateSessionCookie`(신원)가 포트, `assertOwnership`이 게임이 정말 필요로 하는 인가성 메서드 하나.

**포트 설계 종합:** `SessionAuthPort`를 소비자/게임 패키지에 도메인 어휘 메서드로 두고, `FirebaseSessionAuthAdapter`(firebase-admin 래핑, 세션 쿠키→도메인 세션 번역)·`InMemorySessionAuthAdapter`(mock이 아닌 전체 계약 구현)를 조립 루트에서 생성자 주입; 세션 FSM은 인메모리 어댑터로 테스트해 Firebase 호출·에뮬레이터가 불필요하다.

## Key Takeaways

- **인증은 preValidation(upgrade 전) 게이트** — 미인증 소켓을 열지 않는다. `verifyClient` 불채택(`ws` maintainer deprecate), E3-1의 라우트 옵션 SEAM 자리에 정확히 대응. message 핸들러는 await 전 동기 부착.
- **세션 쿠키 = 서버 제어 세션 프리미티브(≤2주)**, 검증 후 권한 검사는 서버 책임. `checkRevoked`는 지연↔즉시무효화 트레이드오프 — 정책으로 결정.
- **CSWSH(CWE-1385)는 쿠키 WS의 명명된 위협** — Origin allowlist(서버측·명시)+`SameSite`+`HttpOnly`/`Secure` 삼중 방어를 같은 pre-upgrade 훅에 배선. Origin은 브라우저 공격자 전용 방어임을 스펙에 명시.
- **세션 FSM = 상태 enum + 핸들러 맵(`onEnter`/`handleInput`/`onExit`)**, 부수효과는 전이 콜백에. 원작 `io->fn` 함수 포인터 상태머신의 관용적 대체이며 A12 로그인/create_ply 상태와 대응.
- **prompt/response 다단은 correlation id로** — E3-1 correlationId 규약 재사용, 서버 prompt 이벤트↔클라 상관 reply로 서브상태 진행.
- **SessionAuthPort는 소비자 소유 DIP seam** — 도메인 어휘 메서드, firebase-admin 어댑터 ↔ 인메모리 stub(실 계약 구현) 조립 루트 주입. Firebase Auth 로컬 에뮬레이터 부재가 이 seam을 필수로 만든다(메모리 [[muhan-auth-firebase-decision]] 정합).
- **경계 재확인**: 실 firebase-admin 어댑터·`/session/login`·CSRF 토큰 발급 엔드포인트는 E5(#35), 라이브 캐릭터 월드 인스턴스화는 E4(#34), 세션 레지스트리·재연결은 E3-3(#47). E3-2는 SessionAuthPort + 인메모리 stub으로 독립 동작.

## Sources

1. [Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies) — 세션 쿠키 생성·검증·폐기·보안 관행 정본
2. [Manage User Sessions | Firebase](https://firebase.google.com/docs/auth/admin/manage-sessions) — refresh 토큰 무효화·세션 관리
3. [SessionCookieOptions | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.sessioncookieoptions) — API 시그니처
4. [TenantAwareAuth | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.tenantawareauth) — verifySessionCookie 동작
5. [Verify ID Tokens | Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens) — 공개키 캐싱
6. [fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md) — preValidation 훅·수명주기·message 동기 부착
7. [ws/doc/ws.md](https://github.com/websockets/ws/blob/master/doc/ws.md) — verifyClient discouraged, upgrade 이벤트 인증
8. [ws PR #1613](https://github.com/websockets/ws/pull/1613) — verifyClient deprecate 반영(2019-08)
9. [ws issue #377](https://github.com/websockets/ws/issues/377) — verifyClient vs handleUpgrade 근거
10. [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet) — CSWSH·Origin·SameSite 방어
11. [Cross-site WebSocket hijacking | PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking) — CSWSH 공격·Origin 한계
12. [CWE-1385 | MITRE](https://cwe.mitre.org/data/definitions/1385.html) — Missing Origin Validation in WebSockets
13. [CSRF Prevention Cheat Sheet | OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — CSRF 토큰
14. [SameSite | OWASP](https://owasp.org/www-community/SameSite) — SameSite 쿠키
15. [Generic Architecture for a Network Server/Client using a State Machine | Stack Overflow](https://stackoverflow.com/questions/300289/generic-architecture-for-a-network-server-client-using-a-state-machine) — 연결당 FSM 설계
16. [ellymud architecture.md](https://github.com/ellyseum/ellymud/blob/main/docs/architecture.md) — onEnter/handleInput/onExit 상태 객체(TS MUD)
17. [LuminariMUD PLAYER_MANAGEMENT_SYSTEM.md](https://github.com/LuminariMUD/Luminari-Source/blob/4b6550541db6dbb227f9b240d261c15417c19898/docs/systems/PLAYER_MANAGEMENT_SYSTEM.md) — nanny() 연결 상태 enum·계정/캐릭터 선택
18. [tinymudserver states.cpp](https://github.com/nickgammon/tinymudserver/blob/master/states.cpp) — 상태별 핸들러·EnteredGame 전이 부수효과
19. [Persistent connections with gen_statem — Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/) — enter 전이 부수효과·request_id 상관·back-off
20. [takode WEBSOCKET_PROTOCOL_REVERSED.md](https://github.com/MrVPlusOne/takode/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md) — type 디스패치·request_id 다단 상관
21. [h11._state](https://h11.readthedocs.io/en/latest/_modules/h11/_state.html) — 분리 client/server 상태머신 + joint 전이표
22. [Dependency Inversion Implies Interfaces Are Owned by High-level Modules — Mikhail Shilkov](https://mikhail.io/2016/05/dependency-inversion-implies-interfaces-are-owned-by-high-level-modules/) — 포트 소유권
23. [DIP in the Wild — Martin Fowler](https://martinfowler.com/articles/dipInTheWild.html) — 인터페이스 형태·추상화 수준
24. [Dependency Inversion & Ports/Adapters — Synapse Studios](https://docs.synapsestudios.com/concepts/architecture/dependency-inversion) — 포트=앱 필요, test double 교체
25. [Hexagonal Architecture in Practice — dev.to/tacoda](https://dev.to/tacoda/hexagonal-architecture-in-practice-ports-adapters-and-tests-that-skip-the-database-5b19) — 인메모리 어댑터=실 계약 구현
26. [Unit testing firebase admin SDK authentication — Stack Overflow](https://stackoverflow.com/questions/63163853/unit-testing-firebase-admin-sdk-authentication-on-node-js) — Firebase Auth 에뮬레이터 부재→어댑터+test double
27. [odysseon/auth](https://github.com/odysseon/auth/) — 헥사고날 identity-only 인증 모듈 선례

## Methodology

Exa `/search`(type=auto, 8 results/query)로 5개 서브질문을 2개 병렬 서브에이전트가 조사했다. 서브질문: (1) Firebase 세션 쿠키 인증, (2) WS 핸드셰이크 쿠키 인증·preValidation, (3) CSWSH·Origin allowlist, (4) 세션 FSM·server-driven prompt/response, (5) DIP/포트-어댑터 인증(SessionAuthPort). 어댑터 실패 없음(exa 단독). 공식 문서(firebase.google.com·fastify·ws·OWASP·MITRE) 우선, 단일 출처 주장은 본문에 표시. 27개 고유 출처 분석.
