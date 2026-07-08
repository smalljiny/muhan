# 리서치 보고서: MUD 서버 Transport + Protocol 계층 설계 (E3-1)

- **주제**: Node.js MUD 게임 서버의 transport + protocol 계층 설계 가이드
- **스택 컨텍스트**: Fastify HTTP 호스트, `@fastify/websocket`(`ws` 래핑) 게임 소켓, Zod v4 단일 진실 원천 스키마, TypeScript, `shared` 패키지를 둔 pnpm monorepo
- **범위 제외**: 인증/세션(별도 토픽) — 본 보고서는 transport-only 관점만 다룬다
- **작성일**: 2026-07-06

---

## Executive Summary

`@fastify/websocket`(Fastify v5)은 `ws`를 얇게 감싸 라우트 옵션 `{ websocket: true }`만으로 WS 핸들러를 마운트하며, 게임 소켓을 handshake에서 인증 게이팅하지 않는 transport-only 구성이 오히려 권장 경로다 — 플러그인의 `verifyClient` 지원은 "Reply already sent" 버그와 함께 `wontfix`로 처리되었고 상위 `ws` 문서도 사용을 만류한다 ([fastify-websocket#182](https://github.com/fastify/fastify-websocket/issues/182), [@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)). TLS는 Fastify 인스턴스의 `https` 옵션으로 종단하거나(플러그인이 동일 서버에 바인딩) 리버스 프록시에서 종단해 내부는 평문 `ws`로 두는 두 갈래가 표준이다 ([wss vs ws](https://websocket.org/reference/wss-vs-ws/)). 프로토콜 계층은 `discriminatedUnion("type")` 봉투(envelope)로 설계하고, client→server(command/Action)와 server→client(event/Emission) 유니온을 분리해 `z.infer`로 타입을 파생시키는 것이 검증된 최신 패턴이다 — WS-Kit, zod-sockets가 정확히 이 구조를 프로덕션 라이브러리로 구현한다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema), [zod-sockets](https://github.com/RobinTail/zod-sockets)). Heartbeat은 server-initiated `ws` `isAlive`/`ping`/`terminate` 캐노니컬 패턴을 쓰되, 인터벌은 "가장 짧은 프록시 idle timeout의 75%" 규칙으로 정하고(대개 25~45초) pong 미수신 3회 상당을 dead로 판정한다 ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/), [websockets/ws](https://github.com/websockets/ws)). 라우팅은 `Map<type, handler>` 기반 O(1) 디스패치 + lookup 전 allowlist 가드 + 핸들러 실패 격리 + correlationId 에코 요청/응답 패턴이 정석이다 ([Server-Side Routing](https://www.real-time-websocket.com/backend-websocket-connection-management/server-side-routing-patterns/), [Jsonic](https://jsonic.io/guides/json-websocket)).

---

## Theme 1 — @fastify/websocket + TLS transport 배선 (핸드셰이크 인증 없이)

### 1.1 라우트 마운트와 연결 라이프사이클

`@fastify/websocket`은 플러그인 등록 후 라우트 옵션에 `websocket: true`를 붙이면 해당 라우트를 WS 서버로 승격시킨다. 핸들러는 `(socket, req)` 두 인자를 받으며, `socket.on('message', ...)`로 프레임을 수신한다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)). 핵심 배선 규칙:

- **등록 순서**: 플러그인은 모든 라우트보다 **먼저** 등록해야 한다 — 그래야 기존 라우트로 오는 upgrade 요청을 가로채고, 비-WS 라우트로 온 연결은 닫을 수 있다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).
- **미등록 라우트**: 등록되지 않은 경로의 upgrade 요청에는 404로 응답하고 연결을 닫는다. 필요 시 wildcard 라우트를 기본 핸들러로 둘 수 있다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).
- **HTTP+WS 동일 경로**: 한 경로에서 HTTP와 WS를 모두 받으려면 full declaration 문법으로 `handler`(HTTP)와 `wsHandler`(WS)를 함께 선언한다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).
- **캡슐화·라이프사이클**: WS 라우트 핸들러는 통상적인 Fastify 요청 라이프사이클(hooks, error handler, decorator)을 그대로 따른다. 핸들러 내부에서 `this`로 Fastify 서버 인스턴스에 접근할 수 있다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).
- **종료 처리(`preClose`)**: 기본적으로 서버 종료 시 모든 WS 연결이 닫힌다. 커스텀 graceful shutdown이 필요하면 `preClose` 함수를 전달하며, 이 함수가 모든 연결과 WS 서버를 닫을 책임을 진다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)). MUD처럼 상태 저장 세션이 많은 서버에서 재시작 시 세이브 flush 훅을 걸 지점으로 적합하다.
- **`ws` 옵션 노출**: 커스텀 서버가 필요하면 `server` 옵션을 쓰되, `@fastify/websocket`의 목적이 Fastify 서버에서 listen하는 것이므로 `ws`의 `noServer` 옵션은 전달하지 말라고 명시한다. 더 세밀한 제어가 필요하면 `ws`를 직접 쓰라고 안내한다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).

### 1.2 Transport-only: handshake에서 인증 게이팅하지 않기 (설계 정당성)

본 토픽의 명시적 요구(인증은 별도 토픽)와 라이브러리 방향이 일치한다. `ws`의 `verifyClient`는 fastify-websocket에서 "Reply already sent" 오류를 유발했고, 이슈 #182는 `wontfix`(behavior is intended)로 닫히며 "`ws` 문서 자체가 verifyClient 사용을 만류한다"고 기록한다 ([fastify-websocket#182](https://github.com/fastify/fastify-websocket/issues/182)). 따라서 handshake 단계에서 인증을 막지 않고 소켓을 열어 두는 것이 이 플러그인의 권장 경로다. 인증이 필요한 미래 토픽에서는 handshake 이전 단계(`onRequest`/`preValidation` 훅)에서 처리하도록 설계 여지를 남긴다 — 플러그인 문서도 "WS 연결이 established 되기 *전에* 발생한 에러(onRequest 훅, preValidation 핸들러 등)는 Fastify의 일반 에러 처리 메커니즘을 타고, established 이후에는 fastify-websocket의 `errorHandler`가 인계받는다"고 경계를 명확히 한다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)). 즉 transport 계층은 소켓 수립까지만 책임지고, 인증 seam은 pre-established 훅으로 자연스럽게 분리된다.

### 1.3 TLS 종단 옵션

`@fastify/websocket`은 별도 `server` 옵션이 없으면 WS 서버를 Fastify 인스턴스에 바인딩한다. 두 가지 표준 종단 전략:

1. **Fastify에서 직접 종단**: Fastify를 `https` 옵션(키/인증서)으로 기동하면 동일 서버에 바인딩된 WS도 자동으로 `wss://`가 된다. 플러그인이 Fastify 서버에 붙으므로 별도 WSS 설정이 불필요하다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket), [issue with @fastify/websocket and HTTPS](https://stackoverflow.com/questions/76850584/issue-with-fastify-websocket-and-https)).
2. **프록시에서 종단(권장 프로덕션)**: nginx/ALB/Cloudflare 등 리버스 프록시에서 TLS를 종단하고 내부는 평문 `ws`로 둔다. `wss`는 TLS 위의 WebSocket이며, 브라우저는 HTTPS 페이지에서 평문 `ws`를 혼합 콘텐츠로 차단하므로 공개 엔드포인트는 반드시 `wss`여야 한다 ([wss vs ws](https://websocket.org/reference/wss-vs-ws/)). 프록시 종단 시에는 프록시의 idle timeout이 heartbeat 설계(Theme 3)에 직접 영향을 준다.

---

## Theme 2 — Zod discriminatedUnion 구조화 프로토콜 봉투

### 2.1 discriminatedUnion("type") 봉투 패턴

모든 메시지에 `type` 문자열 판별자를 두는 discriminated union은 TypeScript의 narrowing과 1:1로 매핑되어, `switch (msg.type)` 또는 `handlers[msg.type]` 내부에서 캐스트 없이 완전한 타입 안전을 제공한다. 판별자가 없으면 수신자가 형태(shape)로 종류를 추론해야 하는데, 두 메시지가 필드를 공유하는 순간 깨진다 ([Jsonic](https://jsonic.io/guides/json-websocket)). Zod에서 이는 `z.discriminatedUnion("type", [...])`로 표현하며, WS-Kit은 `message("PING")`, `message("PONG", { reply: z.string() })` 헬퍼로 만든 스키마들을 `z.discriminatedUnion("type", [PingMsg, PongMsg])`로 결합한다 — "discriminated union은 export-with-helpers 패턴과 자연스럽게 동작한다(모든 스키마가 동일 validator 인스턴스로 생성되므로)"고 명시한다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema), [Zod API](https://zod.dev/api)). `type`을 `domain:action` 단일 문자열(예: `"chat:message"`)로 쓰면 리터럴 하나가 판별자가 되어 이 패턴에 그대로 부합한다 ([Jsonic](https://jsonic.io/guides/json-websocket)).

### 2.2 command(client→server) vs event(server→client) 유니온 분리

인바운드와 아웃바운드를 별도 유니온으로 나누는 것이 검증된 구조다. Jsonic 예시는 `ClientMessage = PingMessage | ChatMessage | SubscribeMessage`와 `ServerMessage = PongMessage | ChatBroadcast | ErrorMessage`를 분리한다 ([Jsonic](https://jsonic.io/guides/json-websocket)). zod-sockets는 이 분리를 라이브러리 1급 개념으로 승격한다 — **인바운드를 "Actions", 아웃바운드를 "Emission"**이라 부르고, Emission을 먼저 구성한 뒤 그 타입을 인지하는 Actions Factory로 Action을 만든다. 이 계약은 프론트엔드로 export되어 client·server가 동일 스키마를 공유한다 ([zod-sockets](https://github.com/RobinTail/zod-sockets)). MUD의 command/event 이분법에 그대로 대응된다.

### 2.3 z.infer 타입 파생 (병렬 수기 타입 금지)

두 라이브러리 모두 "스키마가 단일 진실 원천, 타입은 파생물"을 강제한다. WS-Kit은 `InferMessage`(전체 메시지), `InferPayload`(payload shape), `InferMeta`(예약 필드 제외 meta), `InferResponse`(RPC 응답)를 제공해 `z.infer` 계열로 모든 타입을 파생시킨다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema)). zod-sockets는 zod-to-ts에서 영감받아 client 측 타입을 생성한다 ([zod-sockets](https://github.com/RobinTail/zod-sockets)). 핵심 운영 규칙: **동일 validator를 client·server·스키마에서 일관되게 사용**해야 하며 validator를 섞으면 타입 호환성이 깨진다(TypeScript가 컴파일 타임에 강제). WS-Kit은 이를 "single canonical source"로 부르고 dual-package hazard 방지를 위해 `z`, `message()`, `createRouter()`를 한 곳에서 import하라고 권한다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema)) — pnpm monorepo의 `shared` 패키지가 이 canonical source 역할을 하기에 적합하다.

### 2.4 공통 에러 봉투 `{code, message, correlationId?}`

에러도 유니온의 한 variant(`type: "error"`)로 두고 구조화한다. Jsonic 디스패처는 `{ type: "error", code: 1003, message: "Invalid JSON" }`, `{ type: "error", code: 1004, message: "Unknown type: ..." }`를 반환한다 ([Jsonic](https://jsonic.io/guides/json-websocket)). Server-Side Routing 가이드는 `{ type: 'ERROR', code, ts }` 형태의 `sendError`를 표준 실패 응답으로 쓴다 ([Server-Side Routing](https://www.real-time-websocket.com/backend-websocket-connection-management/server-side-routing-patterns/)). `correlationId`는 요청/응답 상관에 쓰이며(Theme 4), WS-Kit은 `timestamp`와 `correlationId`를 **예약 meta 필드**로 지정해 봉투 표준의 일부로 취급한다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema)). 따라서 `{code, message, correlationId?}` 에러 래퍼는 프레임워크 관행과 정합한다.

---

## Theme 3 — 프로토콜 버전 협상 + 서버 주도 heartbeat

### 3.1 일회성 버전 협상

프로토콜 버전 필드를 봉투에 두어 하위 호환 업그레이드를 지원한다. Jsonic은 `v`(version) 필드로 "기존 클라이언트를 깨지 않고 프로토콜 업그레이드"를 가능케 하며, 새 메시지 타입을 이해 못 하는 클라이언트가 버전을 확인해 graceful fallback할 수 있다고 설명한다 ([Jsonic](https://jsonic.io/guides/json-websocket)). handshake 시점 협상의 선례는 Socket.IO로, 서버가 handshake에서 `pingInterval` 등 파라미터를 클라이언트에 통지한다 ([Socket.IO how it works](https://socket.io/docs/v4/how-it-works/)). MUD 설계 권고: 연결 직후 서버가 보내는 welcome/hello 메시지에 프로토콜 버전을 실어 보내거나, 클라이언트의 첫 `hello` command에 버전을 요구하고 **불일치 시 명시적 에러 후 close**한다. Jsonic 예시가 연결 즉시 `{ type: "welcome", ts }`를 보내는 패턴이 이 협상 프레임의 자연스러운 자리다 ([Jsonic](https://jsonic.io/guides/json-websocket)).

### 3.2 세 계층의 keep-alive와 server-initiated 원칙

WebSocket keep-alive는 세 계층으로 나뉜다: (1) **프로토콜 레벨 ping/pong**(RFC 6455 opcode 0x9/0xA, 2바이트 오버헤드, 그러나 브라우저 JS에서 접근 불가), (2) **애플리케이션 레벨 heartbeat**(`{"type":"ping"}` 같은 일반 메시지, 브라우저에서 유일하게 보이는 방식, 15~20바이트), (3) **TCP keepalive**(`SO_KEEPIDLE` 기본 7200초로 사실상 무용) ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/)). **Server-initiated가 올바른 기본값**이다 — 서버가 연결당 리소스를 쥐고 있으므로 어느 연결이 살아있는지 알아야 하고, 서버는 ping을 여러 연결에 stagger할 수 있으며, N개 클라이언트 타이머를 서버의 단일 타이머 루프 하나로 대체할 수 있다. pong이 timeout(10초가 합리적) 내에 안 오면 서버가 연결을 닫고 리소스를 회수한다 ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/)). 게임 서버는 프로세스 메모리에 방·세션 상태를 쥐므로 이 원칙이 직접 적용된다.

### 3.3 `ws` isAlive/terminate 캐노니컬 패턴과 인터벌 산정

`ws`의 공식 broken-connection 감지 패턴은 연결마다 `isAlive` 플래그를 두고, 인터벌마다 `isAlive === false`인 소켓을 `terminate()`하고 나머지는 `isAlive = false` 후 `ping()`하며, `pong` 이벤트에서 `isAlive = true`로 리셋하는 것이다 ([websockets/ws](https://github.com/websockets/ws), [WebSocket Heartbeat](https://websocket.org/guides/heartbeat/)):

```js
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
wss.on('close', () => clearInterval(interval));
```

**인터벌 산정 — 75% 규칙**: heartbeat 인터벌을 "가장 짧은 프록시 idle timeout의 75%"로 잡는다. Nginx/ALB/Azure 60초 → 45초, Google Cloud LB 30초 → 22초 ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/)). 본 토픽이 제시한 25~30초 ping은 대부분의 프록시(60초 이상)에서 안전하며, GCLB 경로가 아니라면 여유가 있다. 참고로 Python `websockets`의 기본은 `ping_interval=20`, `ping_timeout=20`, 표준 문서는 20초 ping/20초 timeout을 예로 든다 ([websockets keepalive](https://websockets.readthedocs.io/en/stable/topics/keepalive.html)). **3-miss 감지**: 위 캐노니컬 패턴은 "직전 ping에 응답 안 한" 연결을 매 인터벌마다 terminate하므로 사실상 1-miss + 1 인터벌 유예다. 본 토픽의 "3회 미수신 후 disconnect"를 원하면 `missedPongs` 카운터를 두어 인터벌마다 pong 없으면 증가시키고 임계(3)에서 terminate하는 변형이 필요하다 — 즉 캐노니컬 패턴을 카운터로 확장한다 ([Implementing WebSocket Ping-Pong in Node.js](https://www.real-time-websocket.com/backend-websocket-connection-management/connection-lifecycle-heartbeats/implementing-websocket-ping-pong-in-nodejs/)). 애플리케이션 레벨(`{"type":"ping"}`) vs 프로토콜 레벨 선택: `ws`는 프로토콜 레벨 `ping()`/`pong` 이벤트를 직접 노출하므로 서버-서버/네이티브 클라이언트 간에는 프로토콜 레벨이 효율적이고, 브라우저 클라이언트가 heartbeat 타이밍을 앱 로직에서 봐야 하면 애플리케이션 레벨을 추가한다 ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/)).

---

## Theme 4 — Command 라우터 / 핸들러 레지스트리

### 4.1 type→handler 1:1 맵 (switch보다 우수)

`switch`보다 `Map`/객체 레지스트리가 확장성에서 우수하다 — 새 메시지 타입 추가가 새 case 블록 삽입이 아니라 키 하나 추가로 끝나고 O(1) 조회다 ([Jsonic](https://jsonic.io/guides/json-websocket)). Jsonic 디스패처의 핵심 골격:

```ts
const handlers: Record<string, Handler<ClientMessage>> = { /* "ping", "chat.message", ... */ };
function dispatch(raw: string, ws: WebSocket): void {
  let msg; try { msg = JSON.parse(raw); } catch { /* send error 1003 */ return; }
  const handler = handlers[msg.type];
  if (!handler) { /* send error 1004 Unknown type */ return; }
  handler(msg, ws);
}
```

([Jsonic](https://jsonic.io/guides/json-websocket))

### 4.2 프로덕션급 레지스트리 하드닝

Server-Side Routing 가이드는 이 맵 패턴을 프로덕션 품질로 강화한다 ([Server-Side Routing](https://www.real-time-websocket.com/backend-websocket-connection-management/server-side-routing-patterns/)):

- **레지스트리 = `Map<string, RouteHandler>`**, 시작 시 `registerRoute(name, handler)`로 한 번만 구축.
- **lookup 전 allowlist 가드**: `typeof route !== 'string' || !routes.has(route)` → 미지 라우트는 protocol error로 처리. 이는 prototype-pollution류 키가 Map을 탐침하는 것을 차단한다(보안 규칙 §CLI Dynamic Key Access와 동일 정신).
- **프레임 크기 상한**: `MAX_FRAME_BYTES`(예 64KB) 초과 프레임은 파싱 전에 close code 1009로 거부 → 무제한 `JSON.parse`로 CPU 100% 고정 방지.
- **핸들러 실패 격리**: `Promise.resolve(handler(...)).catch(...)`로 감싸 한 payload의 예외가 소켓 루프(그리고 그 워커의 다른 소켓들)를 죽이지 않게 한다.
- **연결 컨텍스트는 `WeakMap<WebSocket, ConnContext>`**: 소켓이 닫히면 수동 정리 없이 GC된다. 컨텍스트의 tenant/user 식별자는 handshake에서 pin하고 **메시지 본문에서 읽지 않는다**(향후 인증 토픽과의 seam).

### 4.3 correlationId 요청/응답 에코

봉투에 상관 ID(`id` 또는 `correlationId`)를 두면 단일 WS 연결 위에서 요청/응답을 구현할 수 있다 — 서버가 응답에 같은 `id`를 에코하고, 클라이언트는 그 ID로 keying된 대기 중 `Promise`를 resolve한다. 이는 서버의 비요청(unsolicited) 이벤트 푸시 능력을 유지하면서 WS를 요청/응답 프로토콜로 전환한다 ([Jsonic](https://jsonic.io/guides/json-websocket)). WS-Kit은 이 개념을 `rpc("QUERY", {...}, "QUERY_RESULT", {...})` 헬퍼로 승격해 요청·응답 스키마를 바인딩하고 `correlationId`를 예약 meta로 관리한다 ([WS-Kit schema](https://kriasoft.com/ws-kit/specs/schema)). 표준 request/reply 모델링의 상위 레퍼런스로 AsyncAPI의 WebSocket request/reply 튜토리얼도 correlation을 1급으로 다룬다 ([AsyncAPI request/reply](https://www.asyncapi.com/docs/tutorials/websocket/websocket-request-reply)). 권고: MUD command 대부분은 fire-and-forget이되, "인벤토리 조회" 같은 질의형 command에 한해 `correlationId`를 선택 필드로 두고 event 응답에 에코한다.

---

## Key Takeaways

1. **Transport-only가 권장 경로다** — `@fastify/websocket`의 `verifyClient`는 `wontfix`이고 `ws` 문서도 만류하므로, handshake에서 인증 게이팅하지 말고 소켓을 연 뒤 인증은 pre-established 훅(`onRequest`/`preValidation`)에 남긴다 ([fastify-websocket#182](https://github.com/fastify/fastify-websocket/issues/182)).
2. **플러그인은 라우트보다 먼저 등록**하고, `{ websocket: true }`로 마운트하며, graceful shutdown·세이브 flush 훅은 `preClose`에 건다 ([@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket)).
3. **TLS는 Fastify `https` 옵션 종단 또는 프록시 종단** 중 택1. 공개 엔드포인트는 반드시 `wss`. 프록시 idle timeout이 heartbeat 인터벌을 결정한다 ([wss vs ws](https://websocket.org/reference/wss-vs-ws/)).
4. **`discriminatedUnion("type")` 봉투 + command/event 유니온 분리 + `z.infer` 파생**이 검증된 최신 패턴이며, WS-Kit·zod-sockets가 라이브러리로 구현(Actions=인바운드, Emission=아웃바운드) ([WS-Kit](https://kriasoft.com/ws-kit/specs/schema), [zod-sockets](https://github.com/RobinTail/zod-sockets)).
5. **스키마는 `shared` 패키지를 단일 canonical source로** — validator를 섞으면 타입 호환성이 깨지므로 client·server가 동일 Zod 인스턴스를 공유한다 ([WS-Kit](https://kriasoft.com/ws-kit/specs/schema)).
6. **에러 봉투 `{code, message, correlationId?}`는 관행과 정합** — 에러를 `type:"error"` variant로 두고, `correlationId`·`timestamp`를 예약 meta로 취급 ([Jsonic](https://jsonic.io/guides/json-websocket), [WS-Kit](https://kriasoft.com/ws-kit/specs/schema)).
7. **버전 협상은 연결 직후 welcome/hello 프레임에** 버전을 실어 불일치 시 명시적 에러 후 close ([Jsonic](https://jsonic.io/guides/json-websocket), [Socket.IO](https://socket.io/docs/v4/how-it-works/)).
8. **Heartbeat은 server-initiated `isAlive`/`ping`/`terminate` 캐노니컬 패턴** + 75% 규칙(25~45초) + 10초 pong timeout. "3-miss disconnect"는 캐노니컬 패턴에 `missedPongs` 카운터를 더한 변형으로 구현 ([WebSocket Heartbeat](https://websocket.org/guides/heartbeat/), [websockets/ws](https://github.com/websockets/ws)).
9. **라우터는 `Map<type,handler>` O(1) + lookup 전 allowlist + `MAX_FRAME_BYTES` 거부 + 핸들러 예외 격리 + `WeakMap` 컨텍스트**로 하드닝. 미지 타입 키 차단은 prototype-pollution 방어와 겹친다 ([Server-Side Routing](https://www.real-time-websocket.com/backend-websocket-connection-management/server-side-routing-patterns/)).
10. **correlationId 에코 요청/응답**으로 단일 소켓 위에서 RPC를 얹되, unsolicited event push 능력은 유지. 질의형 command에 한해 선택 적용 ([Jsonic](https://jsonic.io/guides/json-websocket), [WS-Kit rpc](https://kriasoft.com/ws-kit/specs/schema)).

---

## Sources

1. [@fastify/websocket — npm](https://www.npmjs.com/package/@fastify/websocket) — 라우트 마운트(`websocket:true`), `wsHandler`, 등록 순서, `preClose`, 캡슐화, `server`/`noServer` 옵션, errorHandler 경계
2. [`verifyClient` isn't working and support should likely be removed · fastify-websocket#182](https://github.com/fastify/fastify-websocket/issues/182) — verifyClient wontfix, "Reply already sent", ws 문서가 사용 만류
3. [issue with @fastify/websocket and HTTPS — Stack Overflow](https://stackoverflow.com/questions/76850584/issue-with-fastify-websocket-and-https) — Fastify `https` 옵션으로 WSS 종단
4. [wss vs ws: Secure WebSocket vs Unencrypted — WebSocket.org](https://websocket.org/reference/wss-vs-ws/) — TLS 종단, 혼합 콘텐츠 차단
5. [Message Schema Specification — WS-Kit](https://kriasoft.com/ws-kit/specs/schema) — `message()`/`discriminatedUnion`/`rpc()`, InferMessage/InferPayload, 예약 `correlationId`/`timestamp`, single canonical source, dual-package hazard
6. [RobinTail/zod-sockets — GitHub](https://github.com/RobinTail/zod-sockets) — Actions(인바운드) vs Emission(아웃바운드), Zod 4.x, AsyncAPI, client 타입 생성
7. [JSON WebSocket Messages — Jsonic](https://jsonic.io/guides/json-websocket) — type 판별자 handler map 디스패처, `id` 에코 correlation, `v` 버전 필드, ws heartbeat, 에러 봉투
8. [WebSocket Heartbeat: Ping/Pong, Keep-Alive & Zombie Detection — WebSocket.org](https://websocket.org/guides/heartbeat/) — 세 계층 keep-alive, server-initiated 기본, 75% 규칙, ws isAlive/terminate, 30s/10s
9. [websockets/ws — GitHub README](https://github.com/websockets/ws) — 캐노니컬 broken-connection 감지(isAlive/ping/terminate)
10. [Server-Side WebSocket Routing Patterns — Real-Time WebSocket Engineering](https://www.real-time-websocket.com/backend-websocket-connection-management/server-side-routing-patterns/) — `Map` 라우터, allowlist 가드, MAX_FRAME_BYTES, 핸들러 격리, WeakMap 컨텍스트
11. [Implementing WebSocket Ping-Pong in Node.js — Real-Time WebSocket Engineering](https://www.real-time-websocket.com/backend-websocket-connection-management/connection-lifecycle-heartbeats/implementing-websocket-ping-pong-in-nodejs/) — configurable intervals, missed-pong 임계, zombie 종료
12. [Keepalive and latency — websockets (Python) docs](https://websockets.readthedocs.io/en/stable/topics/keepalive.html) — ping_interval/ping_timeout 20s 기준값
13. [How it works — Socket.IO v4](https://socket.io/docs/v4/how-it-works/) — handshake에서 pingInterval 통지, 서버 주도 PING
14. [Defining schemas — Zod](https://zod.dev/api) — `z.discriminatedUnion` API
15. [Implement Request/Reply in an AsyncAPI document — AsyncAPI](https://www.asyncapi.com/docs/tutorials/websocket/websocket-request-reply) — WebSocket request/reply correlation 모델링

---

## Methodology

- **어댑터**: adapter-exa(`/search` type=auto, numResults 8; `/contents` deep-read)와 adapter-firecrawl(`/v1/search` limit 8; `/v1/scrape` deep-read)를 각 sub-question마다 병행 호출 후 정규화 URL 기준 중복 제거(더 긴 스니펫 보존).
- **커버리지**: 4개 sub-question × 2개 어댑터 = 8+ 검색 라운드, 이후 6개 최고 가치 소스를 full-page scrape로 심층 확인(Jsonic, WS-Kit, WebSocket.org heartbeat, Server-Side Routing, fastify-websocket#182, @fastify/websocket).
- **최신성**: 소스 대부분 2026년 갱신분(Jsonic 2026-05, WebSocket.org heartbeat 2026-03, WS-Kit·zod-sockets 현행). zod-sockets는 Zod 4.x 대상, `ws`/`@fastify/websocket`은 현행 릴리스 문서 기준.
- **어댑터 실패**: 없음. zod-sockets README scrape는 GitHub chrome UI만 반환해(본문 미노출) exa `/search`의 요약 텍스트로 대체(Actions/Emission·Zod 4.x 확인). 그 외 모든 호출 200 OK.
- **범위 제어**: 인증/세션은 지시대로 조사·인용 제외. 단, transport 계층이 인증 seam을 어디에 남기는지(pre-established 훅, handshake-pinned identity)만 설계 경계로 기록.
