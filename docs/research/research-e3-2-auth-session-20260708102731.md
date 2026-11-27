# E3-2 인증·세션 FSM: Research Report
*Generated: 2026-07-08 | Sources: 22 | Adapters: [exa] | Failed: none*

> E3-2(인증·세션 FSM) 스펙 브레인스토밍을 위한 배경 조사다. 다음 주제의 선례와 보안 패턴을 정리한다.
> - Firebase 세션 쿠키 기반 WS 핸드셰이크 인증
> - CSWSH/Origin 방어
> - 서버 주도 세션 상태머신(FSM)과 prompt/response 다단 흐름
> - SessionAuthPort DIP 확장 지점(seam)

## Executive Summary

Firebase 세션 쿠키는 서버가 `createSessionCookie(idToken, {expiresIn})`로 발급하고 `verifySessionCookie(cookie, checkRevoked?)`로 검증한다. 유효기간이 **최대 2주이고 서버가 제어하는 세션 프리미티브**다. 짧은 ID 토큰(≈1시간)과 달리 stateful 백엔드 세션에 맞으며, 검증한 뒤의 권한 검사는 서버가 직접 해야 한다.

WebSocket 인증은 **소켓이 열리기 전, HTTP upgrade 단계에서** 해야 한다. `@fastify/websocket`에서는 `preValidation` 훅에서 쿠키를 검증하고, 실패하면 401로 upgrade를 중단하는 것이 관용 패턴이다. `ws`의 `verifyClient`는 maintainer가 공식적으로 deprecate했다.

쿠키 기반 WS는 CSWSH(CWE-1385)에 취약하다. 그래서 세 가지 방어를 함께 건다. Origin allowlist(서버 측에서, 명시한 목록으로 검사), `SameSite`, `HttpOnly`/`Secure`다.

세션 수명주기는 연결마다 FSM을 두어 모델링하는 것이 MUD와 연결 서버의 정설이다. FSM은 상태 enum과 핸들러 맵(`onEnter`/`handleInput`/`onExit`)으로 구성한다. 상태 전이의 부수효과는 enter/exit 콜백에 두고, prompt/response 다단 흐름은 correlation id로 짝짓는다.

인증은 **소비자(게임 패키지)가 소유하는 포트**(`SessionAuthPort`)로 추상화한다. firebase-admin 어댑터와 인메모리 stub 어댑터를 조립 지점에서 주입한다. stub 어댑터는 모의 객체가 아니라 실제 계약을 구현한 것이다. Firebase Auth에는 로컬 에뮬레이터가 없으므로, 결정적인 테스트를 깔끔하게 할 수 있는 길은 이 DIP seam뿐이다.

## 1. Firebase 세션 쿠키 인증

**핵심 메커니즘.** 클라이언트가 방금 발급받은 ID 토큰을 Admin SDK로 교환해 쿠키 JWT를 만든다. 호출은 `createSessionCookie(idToken, { expiresIn })`이다. 서버는 이 값을 `HttpOnly`·`Secure` 쿠키로 설정한다. 이후 요청에서는 `verifySessionCookie(sessionCookie, checkRevoked?)`로 쿠키를 검증하고 디코딩된 클레임을 얻는다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 시그니처는 `createSessionCookie(idToken: string, options): Promise<string>`과 `verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>`이다 ([SessionCookieOptions | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.sessioncookieoptions)).

**세션 쿠키 vs ID 토큰.** 세션 쿠키는 원래 ID 토큰과 같은 클레임(uid, roles 등)을 물려받지만, **유효기간을 서버가 정한다(최대 2주)**. ID 토큰은 ≈1시간 뒤 만료되며 클라이언트가 보관하고 자주 갱신하는 용도다. 세션 쿠키는 stateful 서버 세션용 프리미티브다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 유효기간을 따로 정하기 때문에 세션 쿠키는 다른 Firebase 서비스와 함께 쓸 수 없고, 자체 백엔드 세션 관리에만 쓴다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)).

**발급 제약.** `expiresIn`의 상한은 2주다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)). 쿠키를 발급하기 전에 사용자가 **최근에 로그인**했는지 ID 토큰의 `auth_time`으로 확인하는 것이 권장된다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)).

**폐기(revocation).** 두 층이 있다.
- (a) `verifySessionCookie`에 `checkRevoked=true`를 주면 사용자 비활성(`auth/user-disabled`)과 세션 폐기(`auth/session-cookie-revoked`)까지 확인한다. 대신 **검증할 때마다 네트워크 요청이 1회 늘어난다**. 지연과 즉시 무효화 사이의 트레이드오프다.
- (b) 강제 폐기는 refresh 토큰 무효화(`revokeRefreshTokens`)나 자체 서버 측 폐기 플래그로 구현하고, `checkRevoked`로 적용한다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies); [Manage User Sessions | Firebase](https://firebase.google.com/docs/auth/admin/manage-sessions)).

**보안 관행(공식).**
- 쿠키는 `HttpOnly`+`Secure`(+`SameSite`)로 설정한다.
- **ID 토큰을 세션 쿠키로 바꾸는 엔드포인트에는 CSRF 방어**를 적용한다.
- 제한된 콘텐츠를 주기 전에 서버에서 검증한다.
- 무효한 쿠키는 바로 지우고 다시 인증하게 한다 ([Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies)).

Admin SDK는 공개키를 자동으로 캐시해 지연을 줄인다 ([Verify ID Tokens | Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens)).

## 2. WebSocket 핸드셰이크 쿠키 인증 (preValidation)

**upgrade 이후가 아니라 upgrade 단계에서 인증한다.** WS 연결은 브라우저 쿠키가 실린 HTTP upgrade 요청으로 시작한다. 인증은 upgrade가 **끝나기 전에** 검사해서, 인증되지 않은 클라이언트가 소켓을 얻지 못하게 한다.

**Fastify `preValidation` 패턴.** `@fastify/websocket` 라우트는 Fastify 플러그인 수명주기를 따른다. 연결이 수립되기 **전에** `onRequest`/`preParsing`/`preValidation`/`preHandler` 훅이 모두 호출되며, 이 훅들은 "인증 등 요청 레벨 처리에 쓸 수 있다" ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)). 문서화된 패턴은 `preValidation` 훅에서 쿠키나 헤더를 검사하고, 실패하면 `401`로 응답해 upgrade를 중단하는 것이다. 이 pre-upgrade 훅은 Fastify HTTP 수명주기 안에서 돌기 때문에 예외가 표준 `setErrorHandler`로 처리된다. 하지만 **소켓이 수립된 뒤에는** 예외가 플러그인 자체 errorHandler로 넘어가므로, message 핸들러 안에서 예외를 잡아야 한다 ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)). 이는 E3-1 `plugin.ts`가 message 핸들러를 try/catch로 격리한 것과 일치한다.

**수명주기 함정(쿠키/세션 인증에서 중요).** WS 라우트 핸들러는 `on('message')` 리스너를 핸들러가 실행되는 동안 **동기적으로** 붙여야 한다. 세션이나 사용자를 불러오는 async 작업을 먼저 하면, 그사이 도착한 메시지가 조용히 버려진다. 그러니 await *전에* message 핸들러를 붙여야 한다 ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)). E3-1이 `system:hello`를 `setImmediate`로 늦춘 것과 같은 종류의 레이스다. `preSerialization`/`onSend`는 WS 라우트에서 **실행되지 않는다** ([fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md)).

**`ws`의 `verifyClient`가 deprecate된 이유(1차 출처).** 공식 `ws` 문서는 "`verifyClient` 사용은 discouraged. 대신 서버 `upgrade` 이벤트를 구독"하라고 하며, `handleUpgrade` 전에 인증하라고 한다 ([ws/doc/ws.md](https://github.com/websockets/ws/blob/master/doc/ws.md)). 이 결정은 PR #1613(2019-08 머지)에 반영됐다 ([ws PR #1613](https://github.com/websockets/ws/pull/1613)). 근거는 issue #377에 있다. `verifyClient`가 `handleUpgrade()`를 async로 만들게 강제하는 "기술 부채"라는 것이다. 권장 방식은 HTTP `upgrade` 이벤트에서 인증한 뒤 `handleUpgrade`를 호출하고, 인증된 신원을 `connection` 이벤트로 넘기는 것이다 ([ws issue #377](https://github.com/websockets/ws/issues/377)). Fastify 스택에서는 `preValidation`이 관용적인 검사 지점이므로 이 문제와 무관하다.

참고로 OWASP 치트시트는 여전히 `verifyClient`를 origin/auth 검사 지점으로 언급한다. 하지만 `ws`에 대해서는 라이브러리 자체 문서를 기준으로 본다 ([OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)).

## 3. CSWSH & Origin allowlist 방어

**공격.** CSWSH("WebSocket의 CSRF")는 WS 핸드셰이크가 HTTP 쿠키에만 의존하고, CSRF 방어나 예측할 수 없는 토큰이 없을 때 생긴다. 브라우저는 피해자의 쿠키를 핸드셰이크에 자동으로 붙인다. 그리고 **WS는 `fetch`와 달리 Same-Origin Policy/CORS의 제약을 받지 않는다** ([Cross-site WebSocket hijacking | PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking); [OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)). 그래서 다른 출처의 악성 페이지가 로그인된 피해자 자격으로 WS를 열어 양방향으로 상호작용할 수 있다. 임의 메시지를 보내 피해자 행세를 하고, 서버 응답을 읽어 데이터를 빼낼 수 있다 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)).

**취약한 이유.** "WebSocket엔 내장 인증이 없다. 브라우저가 핸드셰이크에 쿠키를 포함해 CSWSH에 취약하다" ([OWASP WebSocket Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)). 이 약점에는 **CWE-1385: Missing Origin Validation in WebSockets** 라는 이름이 붙어 있다 ([CWE-1385 | MITRE](https://cwe.mitre.org/data/definitions/1385.html)). 실제 영향도 크다. 2023년 Gitpod의 CSWSH는 origin 검증이 불충분해 계정 탈취를 허용했다 ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet)).

**1차 방어: Origin allowlist.** 모든 WS 핸드셰이크에서 `Origin` 헤더를 서버 측에서 검사하고, **명시한 allowlist**(예 `https://app.example.com`)와 비교한다. denylist와 와일드카드는 쓰지 않고, 연결을 수립하기 전에 검사한다 ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet); [CWE-1385](https://cwe.mitre.org/data/definitions/1385.html)). 주의할 점이 있다. `Origin`은 *브라우저* 공격자에 대해서는 믿을 수 있다. 브라우저가 정직하게 설정하고 JS로 위조할 수 없기 때문이다. 하지만 브라우저가 아닌 클라이언트는 이를 스푸핑할 수 있다. 즉 이것은 CSWSH 방어이지 일반적인 인증이 아니다 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)).

**심층 방어.**
- (a) **SameSite 쿠키**(`Lax`/`Strict`)를 쓰면 브라우저가 교차 사이트 핸드셰이크에 쿠키를 붙이지 않아 쿠키 층에서 막힌다 ([OWASP SameSite](https://owasp.org/www-community/SameSite)).
- (b) 핸드셰이크에 예측할 수 없는 CSRF 토큰을 함께 쓴다 ([PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking); [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
- (c) 쿠키는 `HttpOnly`+`Secure`로 유지한다.

**설계 시사점:** Firebase 세션 쿠키로 `preValidation`에서 WS upgrade를 검사하고, 같은 훅에 엄격한 `Origin` allowlist를 더한다. 쿠키는 `SameSite`+`HttpOnly`+`Secure`로 설정한다. 이 조합이 올바른 수명주기 지점에서 CSWSH 계열(CWE-1385)을 직접 막는다.

## 4. 세션/연결 FSM 패턴 + server-driven prompt/response

**핵심 패턴: 연결마다 FSM(상태 enum + 핸들러 맵)을 둔다.** MUD와 연결 지향 서버의 정설은 연결마다 FSM 인스턴스를 하나씩 주어 수명주기(connect → authenticate → character-select → in-game)를 추적하는 것이다. I/O 루프 곳곳에 `if(loggedIn)`을 흩어 두지 않는다. 상태와 전이 로직은 연결마다 하나인 Session 객체에 담고, I/O 준비와 타임아웃은 상태머신 이벤트로 다루라고 권한다 ([Generic Architecture for a Network Server/Client using a State Machine | Stack Overflow](https://stackoverflow.com/questions/300289/generic-architecture-for-a-network-server-client-using-a-state-machine)).

**`onEnter`/`handleInput`/`onExit` 상태 객체 인터페이스.** TS 스타일 MUD 선례가 있다. 각 클라이언트를 `onEnter`·`handleInput`·`onExit`를 가진 `State` 인터페이스로 관리하고, 전이는 명시적으로 한다. 흐름은 `ConnectingState → LoginState → AuthenticatedState ⇄ CombatState`이고, `DisconnectedState`는 연결을 끝낼 때 거치는 상태다. 주된 명령 디스패치는 `AuthenticatedState`가 맡는다 ([ellymud architecture.md](https://github.com/ellyseum/ellymud/blob/main/docs/architecture.md)). 이를 Node/TS 설계로 그대로 옮기면 `ConnectionState` enum과 `Record<ConnectionState, StateHandler>` 핸들러 맵이 된다. 각 핸들러는 자기 prompt(`onEnter`)와 입력 파싱(`handleInput`)을 담당한다.

**고전 MUD의 상태 enum으로 필요한 상태를 검증할 수 있다.** LuminariMUD 로그인 흐름에서는 디스패치 함수 하나(`nanny()`)가 연결 상태 enum을 차례로 따라간다. 순서는 `CON_ACCOUNT_NAME → CON_PASSWORD → CON_ACCOUNT_MENU → (캐릭터 선택/생성: CON_GET_NAME, CON_QSEX, CON_QRACE, CON_QCLASS, CON_QCONFIRM) → CON_MENU → CON_PLAYING`이고, 연결 종료 대기에는 `CON_CLOSE`를 쓴다. 각 상태가 prompt와 검증을 정한다. 비밀번호는 실패 횟수를 세다가 임계에 이르면 연결을 끊는다. 이 구조는 **계정 인증과, 캐릭터가 여럿인 계정의 character-select 메뉴를 분리**한 형태다. 그래서 `SessionAuthPort`의 `listCharacters`/`createCharacter`와 정확히 대응한다 ([LuminariMUD PLAYER_MANAGEMENT_SYSTEM.md](https://github.com/LuminariMUD/Luminari-Source/blob/4b6550541db6dbb227f9b240d261c15417c19898/docs/systems/PLAYER_MANAGEMENT_SYSTEM.md)). `tinymudserver`도 C++로 같은 패턴(`eAwaitingName`/`eAwaitingPassword`/`ePlaying` 등)을 쓴다. `ePlaying`으로 들어가는 전이에는 `EnteredGame` 부수효과 1개를 둔다. 여기서 인사, MOTD, 첫 `look`, 입장 브로드캐스트를 처리한다 ([tinymudserver states.cpp](https://github.com/nickgammon/tinymudserver/blob/master/states.cpp)).

**부수효과는 전이(enter/exit)에 두고, 인라인으로 쓰지 않는다.** Erlang `gen_statem` 연결 매니저가 성숙한 예를 보여 준다. `enter` 이벤트가 모든 전이에서 발생하므로 리소스 관련 부수효과를 둘 정해진 자리가 된다. init에서는 바로 반환하고, 내부 `:connect` 이벤트로 논블로킹 백그라운드 연결을 한다(Node 이벤트 루프에도 유용하다). 실패 전이에는 **back-off**를 두어 쉬지 않고 재연결하는 루프를 피한다 ([Persistent connections with gen_statem — Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/)).

**server-driven prompt/response와 correlation id(소켓 하나에서 다단 흐름).** 서로 독립된 두 출처가 request-id 상관 패턴을 보여 준다. `gen_statem` 매니저는 `request_id → caller` 맵으로 진행 중인 요청을 추적하고, 응답을 id로 짝짓는다 ([Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/)). WS 앱 계층을 역설계한 명세도 같은 아이디어를 쓴다. `type` 필드로 디스패치하는 NDJSON에서 각 `control_request`가 UUID `request_id`로 prompt와 응답을 연결한다. 그래서 턴이 바뀌어도 쌍을 믿을 수 있게 맞추고, 재연결할 때 UUID로 중복과 재생을 감지한다 ([takode WEBSOCKET_PROTOCOL_REVERSED.md](https://github.com/MrVPlusOne/takode/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md)). MUD에 옮기면 이렇다. 서버가 구조화된 prompt 이벤트(`{type:"prompt", id, subState}`)를 보내고, 클라이언트가 `{type:"reply", id, value}`로 답한다. reply의 `id`가 대기 중인 prompt와 일치할 때만 FSM이 서브상태를 진행한다. 이는 E3-1의 correlationId 반향 규약을 재사용한다.

**client/server 상태머신 결합과 조인트 전이표.** Python `h11`은 client와 server 상태머신을 *따로* 두고 "joint" 전이표를 둔다. 특정 (client, server, keep-alive) 조합이 되면 조율된 전이(`MUST_CLOSE` 등)가 자동으로 일어난다 ([h11._state](https://h11.readthedocs.io/en/latest/_modules/h11/_state.html)). MUD 로그인에는 과하지만, "흩어진 조건문 대신 명시적 전이표"라는 원칙을 프로토콜 수준에서 검증해 준다.

**Node/TS 종합:**
- WS마다 `Session` 객체가 하나 있고, `ConnectionState` enum을 가진다.
- `Record<ConnectionState, StateHandler>`에서 `StateHandler`는 `onEnter(session)`(prompt 이벤트 발생), `handleInput(session, msg)`(상관된 reply를 파싱해 다음 상태로 이동), 선택적인 `onExit`를 가진다.
- 전이 부수효과(캐릭터 로드, 입장 브로드캐스트)는 enter/exit에 둔다.
- prompt에는 클라이언트가 그대로 돌려보내는 correlation `id`를 싣는다.

## 5. DIP / Ports & Adapters — SessionAuthPort

**핵심 원칙: 포트 인터페이스는 소비자(고수준 모듈)가 소유한다.** 이것이 `SessionAuthPort`를 소비자 패키지에 두는 근거다. DIP를 더 엄밀하게 말하면 "추상화는 고수준 모듈이 소유하고 저수준 모듈이 구현한다." 인터페이스를 구현 옆에 정의해 인프라 네임스페이스가 소유하게 하면 **위반**이다. 해법은 인터페이스 소유권을 도메인으로 옮기고 도메인 어휘로 이름 짓는 것이다 ([Dependency Inversion Implies Interfaces Are Owned by High-level Modules — Mikhail Shilkov](https://mikhail.io/2016/05/dependency-inversion-implies-interfaces-are-owned-by-high-level-modules/)). Martin Fowler도 DIP는 인터페이스의 *형태와 추상화 수준*에 관한 것이라고 강조한다. 인터페이스는 기술이 아니라 도메인과 사용자 목표를 반영해야 한다. 비즈니스 로직은 POJO로 두고, 저수준 구현은 도메인 인터페이스 뒤의 어댑터로 둔다 ([DIP in the Wild — Martin Fowler](https://martinfowler.com/articles/dipInTheWild.html)). → 따라서 `SessionAuthPort` 메서드(`validateSessionCookie`·`listCharacters`·`createCharacter`·`assertOwnership`)는 firebase-admin API가 아니라 게임의 세션/계정 어휘로 표현한다. 둘 사이의 번역은 firebase 어댑터가 맡는다.

**포트는 인프라가 제공하는 것이 아니라 앱이 필요로 하는 것으로 정의한다.** "Port는 앱과 외부의 경계 인터페이스다. 포트는 인프라가 제공하는 것이 아니라 앱이 필요로 하는 것으로 정의된다." 조립 루트가 DI로 포트와 어댑터를 연결한다. 테스트에서는 "실 어댑터를 test double(인메모리 repo)로 교체해 비즈니스 로직을 격리 테스트"한다. 처음에는 구체 구현으로 시작하고, 유연성이나 테스트가 필요해지면 인터페이스를 추출하라고 권한다 ([Dependency Inversion & Ports/Adapters — Synapse Studios](https://docs.synapsestudios.com/concepts/architecture/dependency-inversion)).

**인메모리 stub 어댑터는 mock이 아니라 진짜 어댑터이며, 같은 계약을 만족한다.** 이것이 테스트 가능성의 핵심이다. 인메모리 테스트 어댑터는 *인메모리 저장소를 쓰는, 포트 계약의 실제 구현*이다. 그래서 "mock이 아니라 프로덕션 어댑터와 같은 계약을 만족"한다. 테스트는 의존성을 손으로 연결하고, 내부 호출 그래프가 아니라 상태 결과를 단언한다. 프레임워크 부팅, 마이그레이션, 트랜잭션 없이 돈다. 앱 코드가 포트 인터페이스만 import하도록 정적 분석으로 경계를 강제한다 ([Hexagonal Architecture in Practice — dev.to/tacoda](https://dev.to/tacoda/hexagonal-architecture-in-practice-ports-adapters-and-tests-that-skip-the-database-5b19)). → `InMemorySessionAuthAdapter`는 `SessionAuthPort`의 계약 전체를 구현한다. validate는 구조적으로 유효한 세션을 돌려주고, `assertOwnership`은 불일치하면 throw한다. 그래서 FSM/세션 테스트가 firebase 어댑터와 같은 경로를 탄다.

**Firebase Auth는 Admin auth 경로에 로컬 에뮬레이터가 없으므로 어댑터와 test double이 꼭 필요하다.** Firebase Authentication은 `mongodb-memory-server`처럼 로컬 메모리에서 테스트할 수 없다. 권장 방법은 "`admin.auth()` 둘레에 어댑터 층을 두고 단위 테스트용 test double(mock/stub)을 제공"하는 것이다 ([Unit testing firebase admin SDK authentication — Stack Overflow](https://stackoverflow.com/questions/63163853/unit-testing-firebase-admin-sdk-authentication-on-node-js)). 즉 `SessionAuthPort` seam은 선택 사항이 아니다. 빠르고 결정적인 테스트를 깔끔하게 할 수 있는 유일한 길이다. 에뮬레이터가 없는 것은 Auth 제품에 한정되며, Firestore에는 인메모리 mock이 따로 있다.

**참조 아키텍처: 모든 외부 의존을 포트 뒤에 두고, 클래스 하나로 교체한다.** `odysseon/auth`(NestJS)는 헥사고날 구조의 identity-only 인증 모듈 선례다.
- "포트가 모듈이 필요로 하는 것을 정의하고 앱이 어댑터를 제공"한다.
- ORM/DB나 라이브러리에 종속되지 않는다.
- 모든 외부 npm 의존이 포트 뒤에 있어서, "`Bearer header` → cookie를 클래스 하나 교체로" 전환할 수 있다(코어 로직 변경 0).
- 레이어는 `interfaces/ports/`(의존 없음, "inversion anchor") ← `adapters/` ← `core/` 순이다. 이것이 바로 소비자가 포트를 소유하는 구조다.
- 범위를 명시적으로 *identity only*("누구인가 — 무엇이 허용되는가가 아님")로 한정한다 ([odysseon/auth](https://github.com/odysseon/auth/)).

→ `SessionAuthPort`에 대응시키면, `validateSessionCookie`(신원)가 포트에 해당하고, `assertOwnership`은 게임에 정말 필요한 인가 성격의 메서드 하나다.

**포트 설계 종합:** `SessionAuthPort`는 소비자/게임 패키지에 두고 메서드는 도메인 어휘로 짓는다. 조립 루트에서 두 어댑터를 생성자로 주입한다. `FirebaseSessionAuthAdapter`는 firebase-admin을 감싸 세션 쿠키를 도메인 세션으로 번역한다. `InMemorySessionAuthAdapter`는 mock이 아니라 계약 전체를 구현한다. 세션 FSM은 인메모리 어댑터로 테스트하므로 Firebase 호출이나 에뮬레이터가 필요 없다.

## Key Takeaways

- **인증은 preValidation(upgrade 전)에서 검사한다.** 인증되지 않은 소켓은 열지 않는다. `verifyClient`는 쓰지 않는다(`ws` maintainer가 deprecate했다). 이 검사는 E3-1의 라우트 옵션 SEAM 자리에 정확히 대응한다. message 핸들러는 await 전에 동기적으로 붙인다.
- **세션 쿠키는 서버가 제어하는 세션 프리미티브다(≤2주).** 검증 후의 권한 검사는 서버 책임이다. `checkRevoked`는 지연과 즉시 무효화 사이의 트레이드오프이므로 정책으로 정한다.
- **CSWSH(CWE-1385)는 쿠키 기반 WS의 이름 붙은 위협이다.** Origin allowlist(서버 측, 명시 목록), `SameSite`, `HttpOnly`/`Secure`의 삼중 방어를 같은 pre-upgrade 훅에 건다. Origin 검사는 브라우저 공격자만 막는다는 점을 스펙에 적는다.
- **세션 FSM은 상태 enum과 핸들러 맵(`onEnter`/`handleInput`/`onExit`)으로 만들고**, 부수효과는 전이 콜백에 둔다. 원작 `io->fn` 함수 포인터 상태머신을 관용적으로 대체하는 방식이며, A12 로그인/create_ply 상태와 대응한다.
- **prompt/response 다단 흐름은 correlation id로 처리한다.** E3-1 correlationId 규약을 재사용하고, 서버 prompt 이벤트와 클라이언트의 상관된 reply로 서브상태를 진행한다.
- **SessionAuthPort는 소비자가 소유하는 DIP seam이다.** 메서드는 도메인 어휘로 짓고, firebase-admin 어댑터와 인메모리 stub(실제 계약 구현)을 조립 루트에서 주입한다. Firebase Auth에 로컬 에뮬레이터가 없어서 이 seam이 꼭 필요하다(메모리 [[muhan-auth-firebase-decision]]과 일치).
- **경계 재확인**: 실제 firebase-admin 어댑터, `/session/login`, CSRF 토큰 발급 엔드포인트는 E5(#35)에서 한다. 라이브 캐릭터의 월드 인스턴스화는 E4(#34), 세션 레지스트리와 재연결은 E3-3(#47)에서 한다. E3-2는 SessionAuthPort와 인메모리 stub만으로 독립 동작한다.

## Sources

1. [Manage Session Cookies | Firebase](https://firebase.google.com/docs/auth/admin/manage-cookies) — 세션 쿠키 생성·검증·폐기와 보안 관행의 기준 문서
2. [Manage User Sessions | Firebase](https://firebase.google.com/docs/auth/admin/manage-sessions) — refresh 토큰 무효화와 세션 관리
3. [SessionCookieOptions | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.sessioncookieoptions) — API 시그니처
4. [TenantAwareAuth | Firebase Admin SDK](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.tenantawareauth) — verifySessionCookie 동작
5. [Verify ID Tokens | Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens) — 공개키 캐싱
6. [fastify-websocket README](https://github.com/fastify/fastify-websocket/blob/master/README.md) — preValidation 훅, 수명주기, message 리스너 동기 부착
7. [ws/doc/ws.md](https://github.com/websockets/ws/blob/master/doc/ws.md) — verifyClient discouraged, upgrade 이벤트에서 인증
8. [ws PR #1613](https://github.com/websockets/ws/pull/1613) — verifyClient deprecate 반영(2019-08)
9. [ws issue #377](https://github.com/websockets/ws/issues/377) — verifyClient와 handleUpgrade에 관한 근거
10. [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet) — CSWSH·Origin·SameSite 방어
11. [Cross-site WebSocket hijacking | PortSwigger](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking) — CSWSH 공격과 Origin의 한계
12. [CWE-1385 | MITRE](https://cwe.mitre.org/data/definitions/1385.html) — Missing Origin Validation in WebSockets
13. [CSRF Prevention Cheat Sheet | OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — CSRF 토큰
14. [SameSite | OWASP](https://owasp.org/www-community/SameSite) — SameSite 쿠키
15. [Generic Architecture for a Network Server/Client using a State Machine | Stack Overflow](https://stackoverflow.com/questions/300289/generic-architecture-for-a-network-server-client-using-a-state-machine) — 연결당 FSM 설계
16. [ellymud architecture.md](https://github.com/ellyseum/ellymud/blob/main/docs/architecture.md) — onEnter/handleInput/onExit 상태 객체(TS MUD)
17. [LuminariMUD PLAYER_MANAGEMENT_SYSTEM.md](https://github.com/LuminariMUD/Luminari-Source/blob/4b6550541db6dbb227f9b240d261c15417c19898/docs/systems/PLAYER_MANAGEMENT_SYSTEM.md) — nanny()의 연결 상태 enum, 계정/캐릭터 선택
18. [tinymudserver states.cpp](https://github.com/nickgammon/tinymudserver/blob/master/states.cpp) — 상태별 핸들러와 EnteredGame 전이 부수효과
19. [Persistent connections with gen_statem — Andrea Leopardi](https://andrealeopardi.com/posts/connection-managers-with-gen-statem/) — enter 전이 부수효과, request_id 상관, back-off
20. [takode WEBSOCKET_PROTOCOL_REVERSED.md](https://github.com/MrVPlusOne/takode/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md) — type 디스패치와 request_id 다단 상관
21. [h11._state](https://h11.readthedocs.io/en/latest/_modules/h11/_state.html) — 분리된 client/server 상태머신과 joint 전이표
22. [Dependency Inversion Implies Interfaces Are Owned by High-level Modules — Mikhail Shilkov](https://mikhail.io/2016/05/dependency-inversion-implies-interfaces-are-owned-by-high-level-modules/) — 포트 소유권
23. [DIP in the Wild — Martin Fowler](https://martinfowler.com/articles/dipInTheWild.html) — 인터페이스의 형태와 추상화 수준
24. [Dependency Inversion & Ports/Adapters — Synapse Studios](https://docs.synapsestudios.com/concepts/architecture/dependency-inversion) — 포트는 앱이 필요로 하는 것, test double로 교체
25. [Hexagonal Architecture in Practice — dev.to/tacoda](https://dev.to/tacoda/hexagonal-architecture-in-practice-ports-adapters-and-tests-that-skip-the-database-5b19) — 인메모리 어댑터는 실제 계약 구현
26. [Unit testing firebase admin SDK authentication — Stack Overflow](https://stackoverflow.com/questions/63163853/unit-testing-firebase-admin-sdk-authentication-on-node-js) — Firebase Auth 에뮬레이터가 없으므로 어댑터+test double 사용
27. [odysseon/auth](https://github.com/odysseon/auth/) — 헥사고날 identity-only 인증 모듈 선례

## Methodology

서브에이전트 2개가 Exa `/search`(type=auto, 8 results/query)로 서브질문 5개를 병렬 조사했다. 서브질문은 (1) Firebase 세션 쿠키 인증, (2) WS 핸드셰이크 쿠키 인증과 preValidation, (3) CSWSH와 Origin allowlist, (4) 세션 FSM과 server-driven prompt/response, (5) DIP/포트-어댑터 인증(SessionAuthPort)이다. 어댑터 실패는 없었다(exa만 사용). 공식 문서(firebase.google.com·fastify·ws·OWASP·MITRE)를 우선했고, 출처가 하나뿐인 주장은 본문에 표시했다. 고유 출처 27개를 분석했다.
