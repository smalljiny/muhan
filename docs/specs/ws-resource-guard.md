# WS 자원 고갈 방어 (연결 정원 + 아웃바운드 backpressure)

> `/game` WebSocket 소켓의 두 자원 고갈 표면 — **연결 수**와 **아웃바운드 큐** — 에 상한을 걸어 유효 쿠키 1개로 무제한 연결·무제한 송신 버퍼 누적을 막는 E3 전송 계층 하드닝.

## 개요

E3-2(인증·세션 FSM) adversarial 리뷰가 자원 고갈(DoS) 표면 2건을 제기했다(#54). 둘 다 인증 우회·정합성 버그가 아니라 자원 고갈이며, E3-2가 명시적으로 유보한 seam이다.

- **연결 수 무제한** — upgrade 게이트가 동시 연결 수·계정별 연결 수를 검사하지 않아 유효 세션 쿠키 1개로 무제한 영구 연결이 가능해 파일 디스크립터·메모리를 고갈시킬 수 있다.
- **아웃바운드 큐 무제한** — `safeSend`가 소켓 OPEN 여부만 확인하고 `bufferedAmount` 상한·send 오류를 처리하지 않아, 읽기를 멈춘(slow consumer) 클라이언트에게 서버 push가 무제한 누적돼 OOM에 이를 수 있다. `maxPayload`(64KB)는 **인바운드** 프레임만 제한하고 **아웃바운드** 큐는 제한하지 않는다.

이 문서는 두 상한과 이를 튜닝하는 env 정책값을 정본으로 소유한다. 상한이 걸리는 지점은 [`auth-session.md`](auth-session.md)의 인증 게이트(정원 게이트가 세 번째 층)와 [`transport-protocol.md`](transport-protocol.md)의 `safeSend`(backpressure)이며, 각 문서는 이 문서를 교차 참조한다.

## 구조 / 스키마

### 연결 정원 모듈 (`packages/server/src/ws/connectionQuota.ts`)

`createConnectionQuota(getLimits)` 팩토리가 전역 카운터(number)와 계정별 카운터(`Map<accountId, number>`)를 클로저에 캡슐화하고 `ConnectionQuota` 핸들을 반환한다.

- `reserve(accountId): ReserveResult` — 동기 점유 시도. `{ ok: true }` 또는 `{ ok: false; code: 503 | 429 }`.
- `release(accountId): void` — idempotent 반납.
- `activeAccountCount(): number` — 테스트 전용 인스펙터(살아 있는 계정 Map 엔트리 수). 프로덕션 회계 미참여.

상한은 thunk(`getLimits`)로 지연 조회한다 — graceMs/idleMs 관례를 미러해 미설정 env가 팩토리 생성을 막지 않게 하고, `reserve` 시점의 최신값을 반영한다. 상태는 `registerWebsocket` 스코프에서 1회 생성해 연결 간 공유한다(sessionRegistry는 characterId 색인이라 재사용 불가 — 정원은 accountId 회계).

### 게이트 배선 (`packages/server/src/ws/plugin.ts`)

`gameAuthPreValidation(sessionAuth, quota)`가 `/game` 라우트의 `preValidation` 훅을 만든다. `app.decorateRequest('releaseQuota', null)`로 요청별 null 슬롯을 심고, reserve 성공 시 훅이 요청 전용 반납 클로저를 대입한다(객체 리터럴 데코레이트 금지).

### Env 정책값 (`packages/server/src/config/env.ts`)

`EnvSchema`에 자원 한도 3필드를 추가한다(모두 `z.coerce.number().int().min(1)`). `WS_ALLOWED_ORIGINS`(보안 정책, no default, fail-fast)와 달리 자원 한도는 운영 규모에 맞춰 튜닝하는 값이라 **sensible default**를 둔다.

| 필드 | 기본값 | 역할 |
|------|--------|------|
| `WS_MAX_CONNECTIONS` | 1000 | 전역 동시 연결 정원. 초과 시 신규 upgrade 503 거부. |
| `WS_MAX_CONNECTIONS_PER_ACCOUNT` | 5 | 계정별 동시 연결 정원. 초과 시 429 거부. 다중 탭·재연결 겹침 허용, 남용 차단 절충값. |
| `WS_MAX_BUFFERED_BYTES` | 1048576 (1MB) | 아웃바운드 큐 상한. `bufferedAmount + payloadBytes` 초과 시 소켓 close(1013). |

`min(1)`은 세 값 모두 load-bearing이다 — 0이면 각각 "어떤 연결도 수용 불가"·"어떤 계정도 접속 불가"·"어떤 아웃바운드도 즉시 초과"로 서버가 무의미해진다.

## 동작

### 연결 정원 — reserve/release (`connections.size` read 금지)

**핵심 설계 결정**: 상한 판정은 `connections.size`를 **읽지 않고** 카운터를 동기적으로 증가시킨다. upgrade 핸드셰이크는 macrotask 경계라, 동시 진행 중인 여러 pending upgrade가 같은 stale `size`를 읽어 모두 게이트를 통과하면 상한을 넘긴다(overshoot). check-then-increment를 같은 동기 스택에서 마쳐야 원자적이다.

**게이트 순서**(다층 guard): Origin(403) → 세션 쿠키(401) → **정원**. 계정별 상한 판정에 확정된 accountId가 필요하므로 쿠키 검증 뒤에 둔다([`auth-session.md`](auth-session.md) 인증 게이트 정본).

**reserve 판정**:
- 전역 카운터 ≥ `WS_MAX_CONNECTIONS` → 증가 없이 `503 server_busy`(서버 전체 포화).
- 계정 카운터 ≥ `WS_MAX_CONNECTIONS_PER_ACCOUNT` → 증가 없이 `429 too_many_connections`(해당 계정 과다 접속).
- 둘 다 통과 → 전역·계정 카운터를 함께 증가시키고 upgrade 진행. 두 카운터는 항상 함께 변해 원자적 회계를 유지한다.

**release 경로와 누수 방어**: reserve 성공 직후 요청 전용 `releaseOnce` 클로저를 만들어 raw 소켓 `'close'`에 배선하고 `req.releaseQuota`에 대입한다. `released` 멱등 플래그가 load-bearing이다 — 같은 연결의 release가 raw-close·ws-close로 두 번 발화해도 실제 `quota.release`는 한 번만 돈다.

- **게이트 거부** — 체크가 증가보다 앞서므로 거부 시 증가분 없음(release no-op).
- **소켓 정상 종료** — 소켓 핸들러가 `socket.on('close', req.releaseQuota)`로 배선, close 시 반납.
- **게이트 통과 후 upgrade abort** — leak-prone 경로. `@fastify/websocket`의 wsHandler 호출 보장에 의존하지 않고, preValidation 훅 리턴 직전 `req.raw.socket?.destroyed`를 체크해 놓친 반납을 직접 수행한다(released 플래그가 이중 반납을 차단하므로 살아 있는 소켓에 무해).

`release`는 계정 엔트리가 있을 때만 두 카운터를 함께 감소시킨다 — 부재 계정 release나 이중 반납은 완전 no-op(음수·desync 없음). 전역만 먼저 깎으면 다른 계정이 슬롯을 쥔 상황에서 중복 release가 전역 카운터를 per-account 합과 desync시켜 전역 상한을 초과 점유하게 만든다. 계정 카운터가 0 도달 시 Map 엔트리를 삭제해 churn 계정의 무한 엔트리 누적을 막는다.

### 아웃바운드 backpressure — safeSend close (1013)

`safeSend` 단일 병목에서 이번 payload를 미리 직렬화해 `socket.bufferedAmount + payloadBytes > WS_MAX_BUFFERED_BYTES`면 느린 소비자로 판정해 `socket.close(1013)`(Try Again Later)하고 전송하지 않는다. enqueue 직전에 대기 payload 크기까지 회계에 넣는 hard cap이라, 단일 이벤트가 큐를 상한 너머로 밀어넣고도 살아남는 one-message overshoot가 없다.

권위적 이벤트를 push하는 서버라 프레임을 드롭·유예하면 클라이언트 상태가 어긋나므로 close가 유일하게 안전한 응답이다. close는 close 핸들러를 핸들러 중간에 재진입 발화시키지만, 기존 idempotent teardown(`cleanupConnection` + `binding.connection === ctx` 가드)이 이를 흡수한다.

**send 콜백 오류**: `socket.send(payload, cb)`의 콜백 err를 받아 `log.error({ err }, 'ws send failed')`로 로깅하고 코드 없는 `close()`로 잘라낸다 — 정책적 backpressure(1013)와 달리 transport 실패이므로 코드 없이 닫는다(deadline 관례 미러). 콜백형 send에서 not-OPEN 전송은 동기 throw 대신 콜백 err로 오지만, 잔여 동기 throw를 방어하기 위해 try/catch를 defense-in-depth로 유지한다.

상한은 `getConfig()`로 호출 시점에 조회한다(팩토리 생성 시점 캡처 금지) — 테스트가 env를 덮어쓸 수 있게 한다.

### 거부 응답 형식

정원 거부는 upgrade 전이라 프로토콜 `error` 이벤트가 아니라 HTTP 응답이다: `503 { error: 'server_busy' }`, `429 { error: 'too_many_connections' }`. Origin(403)·쿠키(401) 거부와 같은 계층(소켓·프로토콜 계약 밖).

## 제약사항

- **정원은 accountId 회계** — 계정별 상한이 "중복 연결" 방어를 커버하므로 재연결 정책(#47)이 별도 중복 연결 정책을 재구현하지 않는다.
- **인바운드 메시지 속도 제한은 범위 밖** — 다른 자원(CPU)·다른 공격면. 후속 이슈 #64. 정원은 연결 수, backpressure는 아웃바운드 큐만 관할한다.
- **graceful shutdown 세션 수렴은 범위 밖**(#56) — 본 토픽 이후 [`runtime-foundation.md`](runtime-foundation.md)이 구현했다(서버 주도 종료 시 전체 live 바인딩 일괄 수렴 + 월드 틱 정지). 자원 가드 계층은 이를 다루지 않는다.
- **command 상태 유휴 종료는 범위 밖** — `WS_IDLE_TIMEOUT_MS`가 이미 커버.
- **결정적 테스트** — fake socket 주입·env 오버라이드로 검증하며 부하 테스트가 아니다.

## 관련 문서

- [`auth-session.md`](auth-session.md) — 정원 게이트가 세 번째 층으로 얹히는 인증 게이트 정본.
- [`transport-protocol.md`](transport-protocol.md) — backpressure가 얹히는 `safeSend` 전송 배선 정본.
- 이슈 #54(본 토픽), #64(rate limit 후속), #56(shutdown), #47(재연결). ADR #14.
