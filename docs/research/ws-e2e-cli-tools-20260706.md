# WebSocket(`ws`) 서버 E2E 테스트 CLI 도구 조사 보고서
*생성: 2026-07-06 | 소스: 30+ | 어댑터: exa | 실패: 없음*
*맥락: 이슈 #32 (E3 전송·세션 계층) — `ws`+TLS, 세션 FSM, Zod `domain:action` 프로토콜 래퍼, 5인자 파서, 재연결 테스트 수단 선정용*

## 요약 (Executive Summary)

WebSocket 서버를 커맨드라인에서 테스트하는 도구는 **목적별로 5개 층위**로 갈린다: (1) 수동 디버깅 CLI 클라이언트(`wscat`·`websocat`), (2) 프로그래매틱 통합/E2E(테스트 러너 + `ws` 클라이언트), (3) 브라우저 E2E(Playwright `routeWebSocket`), (4) 프로토콜 적합성(autobahn-testsuite `wstest`), (5) 부하 테스트(Artillery·k6). **assertion 기반 자동화 E2E**를 원한다면 "전용 CLI 도구"는 없고, 실제 `ws` 서버를 포트 0에 띄우고 실제 `ws` 클라이언트를 붙여 **Vitest/Jest로 구동**(`vitest run`)하는 것이 이 프로젝트(TS+`ws`+Zod) 스택에 가장 정합한 답이다 ([tests.ws Best Practices](https://tests.ws/testing/websocket-testing-best-practices), [ITenthusiasm/testing-websockets](https://github.com/ITenthusiasm/testing-websockets)). `wscat`/`websocat`은 스모크 테스트·수동 프로빙용이고, autobahn은 RFC 6455 적합성 1회 검증용, Artillery/k6는 재연결·동시성 부하 시나리오용으로 상호 보완적이다.

## 1. 수동 디버깅 CLI 클라이언트 — `wscat` · `websocat`

두 도구 모두 **대화형 클라이언트**로 설계됐으며 assertion 프레임워크가 아니다. 자동화는 제한적으로 가능하지만 "테스트 통과/실패 판정"은 외부 스크립트가 떠맡아야 한다.

- **`wscat`** (Node.js, `npm i -g wscat`): `ws` 라이브러리 공식 CLI. `-c`(connect)/`-L`(listen), 헤더(`-H`), 인증(`--auth`), 서브프로토콜(`-s`), TLS 옵션(`--ca/--cert/--key`), 그리고 **연결 후 명령 실행(`-x`)·대기(`-w`)** 를 지원한다. `-x`+`-w` 조합으로 "연결→메시지 전송→N초 대기→응답 출력"까지 스크립트화되지만 응답 검증은 별도 처리다 ([wscat README](https://github.com/websockets/wscat/blob/master/README.md)).
- **`websocat`** (Rust, netcat/socat의 ws판): `wscat`의 상위 호환. **stdin/stdout 파이핑**으로 로컬 프로세스와 WebSocket을 연결, `--jsonrpc` 프레이밍, **자동 재연결**, `--oneshot`/`--exit-on-eof`, `log:` 필터 트래픽 디버깅, 지속 연결 세션 등 자동화·CI 파이프라인에 유리한 기능이 많다 ([vi/websocat](https://github.com/vi/websocat), [Baeldung](https://www.baeldung.com/linux/shell-read-websocket-response)).

**판정**: `domain:action` JSON 래퍼를 손으로 찔러보는 스모크 테스트엔 `websocat`(파이핑·재연결·JSON-RPC) 권장. 회귀 테스트 스위트로는 부적합.

## 2. 프로그래매틱 통합/E2E — 테스트 러너 + `ws` 클라이언트 (★이 프로젝트 최적)

Node/TS 생태계의 **표준 관행**은 실제 `ws` 서버를 테스트 프로세스 안에서 띄우고 실제 클라이언트로 붙어 메시지 흐름을 검증하는 것이다. `vitest run`/`jest`가 곧 "CLI 실행 진입점"이 된다.

- **패턴** ([tests.ws Best Practices](https://tests.ws/testing/websocket-testing-best-practices)): 테스트 피라미드에 맞춰 ─ 핸들러·직렬화는 유닛, **인프로세스 실제 서버 + 실제 클라이언트는 통합, 풀스택은 E2E**. `beforeAll`에서 서버 기동(**포트 0**으로 랜덤 할당 → 병렬·포트 충돌 회피), `afterAll`에서 정리(소켓·서버 close로 flaky 방지), 이벤트 기반 API를 `connectClient`/`waitForMessage` 프로미스 헬퍼로 감싸 가독성 확보. **재연결 후 상태 복원(`onReconnect`) 테스트**도 이 층에서 다룬다.
- **레퍼런스 구현** ([ITenthusiasm/testing-websockets](https://github.com/ITenthusiasm/testing-websockets), [Medium: Jest+ws 통합 테스트](https://thomason-isaiah.medium.com/writing-integration-tests-for-websocket-servers-using-jest-and-ws-8e5c61726b2a)): `TestWebSocket` 래퍼로 open/close 타이밍·메시지 이벤트 관리, `waitUntil`·`waitForMessage`·`waitForMessageCount` 헬퍼로 비동기 메시지 assertion. echo·다중 응답(ECHO_TIMES_3) 시나리오 예시 포함.
- **매처 라이브러리**: `jest-websocket-mock`/`vitest-websocket-mock`은 `.toReceiveMessage()`(비동기, 1초 타임아웃)·`.toHaveReceivedMessages()` 매처와 `verifyClient`(접근 제어 시뮬레이션)·`selectProtocol`(프로토콜 협상) 옵션 제공. **단, `mock-socket` 기반이라 서버를 모킹**하므로 진짜 E2E가 아니라 클라이언트 측 테스트에 적합. Node의 `ws`(비브라우저) 클라이언트와 쓰려면 `__mocks__` 수동 목이 필요하다 ([npm: vitest-websocket-mock](https://www.npmjs.com/package/vitest-websocket-mock), [npm: jest-websocket-mock](https://www.npmjs.com/package/jest-websocket-mock)).

**판정**: 세션 FSM·Zod 래퍼·5인자 파서·권한 미들웨어 골격의 서버 측 계약 검증은 **실제 서버 + 실제 `ws` 클라이언트 + Vitest**가 정답. 매처 목 라이브러리는 서버를 가짜로 만드므로 E3 서버 검증엔 부적합(프론트엔드 클라이언트 테스트에서 재활용 가능).

## 3. 브라우저 E2E — Playwright `routeWebSocket`

무한의 **구조화 웹 UI**를 브라우저째 통과시키는 풀스택 E2E용. `page.routeWebSocket()`(v1.48+)으로 양방향(page↔server) 메시지 가로채기·모킹, `connectToServer()`로 실제 서버 연결 유지하며 in-flight 변조 가능 ([Playwright WebSocketRoute](https://playwright.dev/docs/api/class-websocketroute)). 순수 관찰은 `page.on('websocket')` + `ws.on('framesent'/'framereceived')`로 프레임 캡처·순서·내용 assertion ([tests.ws Playwright](https://tests.ws/testing/playwright-websocket)).

**주의**: 라우팅 활성 시 WS 트래픽이 DevTools·trace에서 숨겨지고, 양방향을 한 테스트에서 다루기 까다로워 케이스 분할이 권장된다 ([adequatica 분석](https://adequatica.github.io/2024/11/05/is-it-worth-mocking-websockets-by-playwright.html)). MSW와 결합해 결정적 테스트도 가능 ([Egghead+MSW](https://egghead.io/lessons/test-web-sockets-in-playwright-with-msw~rdsus)).

**판정**: 서버 계약 검증엔 과함. UI가 붙은 뒤 "브라우저→서버→UI 갱신" 풀스택 흐름 검증 단계에서 도입.

## 4. 프로토콜 적합성 — autobahn-testsuite (`wstest`)

RFC 6455 **프로토콜 적합성·견고성** 전용. 500+ 케이스(프레이밍, ping/pong, 예약 비트, opcode, 프래그멘테이션, UTF-8, 종료/개시 핸드셰이크, permessage-deflate)를 단일 CLI `wstest`로 실행. Docker 권장(`crossbario/autobahn-testsuite`), Python은 레거시(2.7). `-m fuzzingclient`(서버 테스트)/`fuzzingserver`(클라이언트 테스트) 모드, HTML 리포트 생성 ([autobahn-testsuite](https://github.com/crossbario/autobahn-testsuite), [문서](https://autobahn-testsuite.readthedocs.io/)).

**판정**: `ws` 라이브러리 자체가 이미 통과하는 스펙 레벨이라 **애플리케이션 프로토콜(`domain:action`)에는 무관**. TLS 핸드셰이크·프레이밍 견고성을 인프라 1회 검증할 때만 선택. 상시 스위트엔 불필요.

## 5. 부하·시나리오 테스트 — Artillery · k6

재연결·동시 세션·massconnect 같은 **동시성/부하** 시나리오용.

- **Artillery** ([WebSocket Engine](https://www.artillery.io/docs/reference/engines/websocket)): YAML 시나리오에 `engine: ws`. `connect`/`send`/`think`/`loop`/`function` 액션, 서브프로토콜·헤더(`Sec-WebSocket-Protocol`)·프록시 설정, `DEBUG=ws` 디버깅. **YAML 선언형**이라 CI 통합·시나리오 스크립트가 간결.
- **k6** ([Grafana k6 WebSockets](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/)): `k6/websockets` 모듈(신규, `k6/ws`는 deprecated), VU별 비동기 이벤트 루프. `ws.connect(url, params, fn)` + `socket.on('open'/'message'/'close'/'error')`, `setInterval`/`setTimeout`. JS 스크립트 기반. autobahn 서버를 띄우고 k6로 구동하는 통합 예시도 존재 ([k6 autobahn_tests](https://fossies.org/linux/k6/internal/js/modules/k6/websockets/autobahn_tests/README.md)).

**판정**: 기능 정합성 아닌 **재연결 폭주·동시 세션 상한** 검증용. E3 초기 스코프보다는 성능 게이트 단계에서 도입. 선언형 CI엔 Artillery, JS 정밀 제어엔 k6.

## 핵심 결론 (Key Takeaways)

- **자동화 E2E 전용 "CLI 도구"는 없다.** 이 스택(TS+`ws`+Zod)에선 **실제 `ws` 서버(포트 0) + 실제 `ws` 클라이언트 + Vitest(`vitest run`)** 가 CLI 진입점이자 최적 조합이다 — 세션 FSM·프로토콜 래퍼·파서·권한 골격의 서버 계약을 그대로 검증.
- **`waitForMessage`류 프로미스 헬퍼를 자체 유틸로 두라.** 이벤트 기반 `ws`를 assertion 가능하게 만드는 얇은 래퍼가 핵심(라이브러리 교체에도 강건). `ITenthusiasm/testing-websockets`가 복붙 가능한 레퍼런스.
- **목 매처 라이브러리(`*-websocket-mock`)는 서버를 가짜로 만든다** — E3 서버 검증엔 부적합, 프론트엔드 클라이언트 테스트에서만 재활용.
- **수동 프로빙은 `websocat`** (파이핑·재연결·JSON-RPC·`log:` 디버깅). `wscat`은 `ws` 공식이지만 기능이 더 좁다.
- **autobahn은 1회성 인프라 적합성**, **Artillery/k6는 부하 단계** — 둘 다 상시 스위트가 아닌 게이트 시점 보완재.
- **Playwright `routeWebSocket`는 UI 완성 후 풀스택 E2E** 단계로 유보.

## 소스 (Sources)

1. [tests.ws — WebSocket Testing Best Practices](https://tests.ws/testing/websocket-testing-best-practices) — 테스트 피라미드·포트 0·인프로세스 실서버 패턴
2. [ITenthusiasm/testing-websockets](https://github.com/ITenthusiasm/testing-websockets) — Vitest/Jest+`ws` 통합 테스트 레퍼런스 구현
3. [Medium — Jest+ws 통합 테스트](https://thomason-isaiah.medium.com/writing-integration-tests-for-websocket-servers-using-jest-and-ws-8e5c61726b2a) — `TestWebSocket`·`waitForMessage` 헬퍼
4. [npm: vitest-websocket-mock](https://www.npmjs.com/package/vitest-websocket-mock) / [jest-websocket-mock](https://www.npmjs.com/package/jest-websocket-mock) — 매처·목 한계
5. [wscat README](https://github.com/websockets/wscat/blob/master/README.md) — `-x`/`-w` 스크립팅 옵션
6. [vi/websocat](https://github.com/vi/websocat) — 파이핑·재연결·JSON-RPC CLI
7. [Baeldung — Read WebSocket in Linux Shell](https://www.baeldung.com/linux/shell-read-websocket-response) — CLI 클라이언트 비교
8. [Playwright WebSocketRoute](https://playwright.dev/docs/api/class-websocketroute) / [tests.ws Playwright](https://tests.ws/testing/playwright-websocket) — 브라우저 WS 인터셉트·assertion
9. [adequatica — Playwright WS 모킹 검토](https://adequatica.github.io/2024/11/05/is-it-worth-mocking-websockets-by-playwright.html) — 한계·케이스 분할
10. [autobahn-testsuite](https://github.com/crossbario/autobahn-testsuite) / [문서](https://autobahn-testsuite.readthedocs.io/) — `wstest` RFC 6455 적합성
11. [Artillery WebSocket Engine](https://www.artillery.io/docs/reference/engines/websocket) — YAML 부하 시나리오
12. [Grafana k6 WebSockets](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/) — `k6/websockets` 이벤트 루프

## 방법론 (Methodology)

Exa `/search`로 4개 하위질문(수동 CLI 클라이언트 / Playwright WS / Node 테스트 러너+`ws` / autobahn+부하) 병렬 검색, 각 8결과. 어댑터: exa. 실패 없음. 총 30+ 소스에서 도구별 용도·스크립트 가능성·assertion·CI 통합을 대조. firecrawl 딥리드는 스니펫만으로 판정 근거가 충분해 생략.
