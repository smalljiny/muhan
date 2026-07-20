# 인증·세션 계층 (E3-2)

> E3-1 전송 위에 "누가 접속했나"를 얹는다 — WS upgrade 전 `preValidation` 인증 게이트(Firebase 세션 쿠키 + Origin allowlist), 원작 `io->fn` 함수 포인터 상태머신을 대체하는 3층 세션 FSM(`characterSelect → create → command`), 서버 주도 prompt/response 다단 대화, `SessionAuthPort` DIP seam(인메모리 어댑터), 연결 진행 데드라인. 실 firebase-admin 어댑터·Mongo 영구화는 E5, 라이브 월드 인스턴스화는 E4, 세션 레지스트리·재연결은 E3-3 경계다.

## 개요

무한 포팅의 세션 계층이다. [`transport-protocol.md`](transport-protocol.md)(E3-1)가 확립한 transport-only WS(핸드셰이크·라우터·하트비트) 위에, ADR([`architecture.md`](architecture.md) D6 세션/인증)이 규정한 **Firebase Auth 위임 + 세션 쿠키 검증**을 구체화한다. 원작 무한의 이름+평문 비밀번호·identd는 **형상**으로 폐기하고(게임 분석 A12), `io->fn` **함수 포인터 상태머신**은 상태 enum + 핸들러 맵으로 재설계하되, **접속 라이프사이클 의미**(상태 전이 순서·캐릭터 선택→생성→입장 흐름)는 **콘텐츠**로 충실 재현한다.

계층 경계는 세 가지다.

1. **transport ↔ 인증** — WS upgrade **전** Fastify `preValidation` 훅이 Origin allowlist·세션 쿠키를 게이트한다. 미인증 소켓은 열리지 않는다(`verifyClient` 미사용, 인증은 수명주기 훅).
2. **인증 ↔ 세션 상태** — 핸드셰이크가 account를 확정하고, FSM이 그 account 위에서 상태를 진행하며, `SessionAuthPort`가 신원·캐릭터 요약을 공급한다.
3. **순수 결정 ↔ 부수효과** — FSM은 3층(순수 decider → 주입 emit StateHandler → 배선)으로 functional-core/imperative-shell을 확장한다. 소켓은 셸에만 있다.

인증 결정 자체(ADR D6 → Firebase Auth)는 이슈 #14·#32에서 확정됐으며 여기서 재논쟁하지 않는다.

## 구조 / 스키마

### 인증 게이트 (`packages/server/src/ws/plugin.ts`, `cookies.ts`)

`gameAuthPreValidation(sessionAuth, quota)`가 `/game` 라우트 옵션의 `preValidation` 훅을 만든다. 다층 guard 순서:

1. **Origin 게이트** — `req.headers.origin`을 `config.WS_ALLOWED_ORIGINS`와 대조한다. 부재·불일치 모두 `403 forbidden_origin`(fail-closed). 중복 Origin 헤더는 배열로 정규화돼 `includes(array)`가 항상 false를 반환하므로 fail-closed로 떨어진다.
2. **세션 쿠키 게이트** — `extractSessionCookie(req.headers.cookie)`로 `__session` 값을 추출해 `sessionAuth.validateSessionCookie`로 검증한다. 부재·무효 모두 `401 unauthenticated`.
3. **정원 게이트**(E3 하드닝 #54) — 확정된 accountId로 `quota.reserve`를 호출해 동시 연결 슬롯 1개를 점유한다. 전역 초과 `503 server_busy`, 계정별 초과 `429 too_many_connections`. 계정별 판정에 확정 accountId가 필요하므로 쿠키 게이트 뒤에 둔다. 정본은 [`ws-resource-guard.md`](ws-resource-guard.md)다.

세 거부 모두 `reply.code().send()` 후 return이라 라이프사이클이 단락돼 upgrade가 완료되지 않는다. 통과하면 확정된 `AccountIdentity`를 `req.account`에 대입한다 — `app.decorateRequest('account', null)`로 요청별 null 슬롯을 심고 훅에서 대입한다(객체 리터럴 데코레이트 금지: 요청 간 공유 참조 교차 오염). 소켓 핸들러가 `ctx.account = req.account`로 재사용한다.

`extractSessionCookie`는 `Cookie` 헤더를 파싱해 `__session`을 읽되, `__proto__`/`constructor`/`prototype` 예약 키를 차단하고(`RESERVED_KEYS` + `Object.hasOwn`) 중복 키는 first-wins를 취한다(prototype-pollution 방어, `.harness/rules/security.md` 정합).

거부 응답은 HTTP `{ error: 'forbidden_origin' | 'unauthenticated' }`이며 프로토콜 `error` 이벤트가 아니다(upgrade 전이라 소켓·프로토콜 계약 밖).

### SessionAuthPort DIP (`packages/server/src/auth/`)

`sessionAuthPort.ts`가 **소비자(server 게임 패키지) 소유** 인터페이스를 정의한다 — 메서드는 firebase-admin API가 아니라 게임 세션/계정 어휘로 표현한다(DIP: 추상화는 고수준 모듈 소유).

| 메서드 | 계약 |
|------|------|
| `validateSessionCookie(cookie)` | `AccountIdentity \| null` — 유효 쿠키면 신원, 아니면 null |
| `listCharacters(accountId)` | `CharacterSummary[]` — 계정 캐릭터 요약(얕은 복사본) |
| `createCharacter(accountId, dto)` | `CharacterSummary` — 생성 후 요약 반환 |
| `assertOwnership(accountId, characterId)` | `void` — 미소유 시 `OwnershipError` throw |

`OwnershipError`는 not-found와 not-owned를 **하나의 결과로 collapse**한다(존재 비공개 — 열거 oracle 차단). 상세 메시지(accountId/characterId 포함)는 내부 전용이며 클라이언트로 나가지 않는다.

`InMemorySessionAuthAdapter`는 **mock이 아니라 포트 전체 계약의 실 구현**이다 — 쿠키→accountId, accountId→캐릭터 요약을 자체 `Map`으로 소유한다(생성자 주입, 전역 싱글턴 미조회). `listCharacters`·`createCharacter`는 내부 참조를 노출하지 않고 얕은 복사본을 반환한다(불변성). `app.ts`의 `buildApp`이 `sessionAuth` 미주입 시 **빈** 어댑터로 폴백하므로, E3-2 시점의 부트 경로는 유효 쿠키가 0개다(fail-closed by omission).

**E5 실현**([`account-character.md`](account-character.md)): 이 포트 표(sync)는 E5에서 Promise 반환으로 마이그레이션됐고 `deleteCharacter`(soft-delete)가 추가됐으며, firebase 세션쿠키 실 어댑터(`FirebaseSessionAuthAdapter`, 주입 verifier seam + Mongo repository)가 landed했다. `assertOwnership`은 status='deleted'까지 거부해 삭제 캐릭터 재진입을 차단한다. 부트는 `DEV_LOGIN_ENABLED` off면 실 firebase 어댑터를, on이면 dev 시드 인메모리 어댑터를 주입한다.

### 시드 테스트 유틸 (`packages/server/src/auth/seedSessionAuth.testutil.ts`)

`SEED_VALID_COOKIE`·`SEED_ACCOUNT_ID`·`SEED_CHARACTER_ID` 상수와 `createSeededAuthAdapter()` 팩토리는 프로덕션 어댑터 모듈이 아니라 `.testutil.ts`에 격리한다 — `tsconfig.build.json`이 `*.testutil.ts`를 프로덕션 빌드(`dist/`)에서 제외하므로 알려진 유효 쿠키가 배포 산출물에 실리지 않는다(잠재 인증 우회 표면 제거). 실 소켓·FSM 테스트가 결정적 유효 쿠키를 이 팩토리로 확보한다.

### 세션 FSM (`packages/server/src/ws/fsm/sessionFsm.ts`)

`ConnectionState` enum(`characterSelect`/`create`/`command`) + `Record<ConnectionState, StateHandler>` 핸들러 맵이 `io->fn`을 대체한다. 3층 구조:

- **1층 순수 decider** — `decideCharacterSelectInput(frame)`·`decideCreateInput(progress, frame)`. 포트·emit·소켓 없이 (상태 기준) 프레임→결정만 계산한다. `clientCommandSchema.safeParse` + variant narrow로만 판별하고 필드를 hand-parse하지 않는다(우회 표면 재도입 금지). plain-data로 단위 테스트한다.
- **2층 StateHandler** — `onEnter`(prompt 발화)·`handleInput`(포트 호출 후 다음 상태 반환)·선택 `onExit`. 이벤트는 주입 `emit` 콜백으로만 내보낸다(소켓 직접 접근 금지).
- **3층 배선** — `enterState`(ctx.state 대입 + onEnter 구동, 유일한 상태 변이 지점)·`applyTransition`·`enterInitialState`·`handleSessionFrame`. 셸(plugin)이 `emit = (e) => safeSend(socket, e)`를 주입해 호출한다.

`SessionContext`는 `account`(게이트 확정 신원)·`sessionAuth`·`emit`·`rearmDeadline`·`clearDeadline`을 담는다(데드라인 콜백은 required — 주입 누락 시 컴파일에서 걸려 silent DoS 방지). create 대화 서브상태(`createProgress`)는 소켓 수명 동안 유지되는 `FsmContext`에 둔다.

**prompt 규약**: `SELECT_CHARACTER_PROMPT_ID = 'session:select-character'`, create 서브상태별 고정 `CREATE_PROMPT_IDS`(`name`/`class`/`race`/`confirm`). step만 저장하고 promptId는 step에서 파생한다(derivable-state 중복 저장 금지). `CREATE_SENTINEL = 'create'`(선택 화면에서 신규 생성 신호), `CREATE_CONFIRM_VALUE = 'yes'`(확인 승인값).

**입력 검증**: 이름은 `z.string().trim().min(1).max(40)`(원작 creature name 80바이트 EUC-KR ≈ 40 한글자 기준 방어적 상한), class·race는 `z.coerce.number().int()`, 확인 단계에서 누적 dto를 최종 재검증한다.

### 연결 진행 데드라인 (`packages/server/src/ws/deadline.ts`)

`createDeadline(socket, opts)`가 per-connection 논리 진행 데드라인을 만든다 — 단발 `setTimeout` 모델로, `deadlineMs` 안에 진행(상태 전이·create 서브상태 전진)이 없으면 소켓을 graceful `close`한다(하트비트의 `terminate`와 달리 정상 종료 프레임). `{ rearm, clear }` 핸들을 반환한다: `rearm`은 기존 타이머를 clear한 뒤 새 타이머를 설정(첫 설정·재설정 동일 동작), `clear`는 idempotent 해제다. 타이머는 주입 가능(`setTimeoutFn`/`clearTimeoutFn`)이라 fake clock으로 결정적 단위 테스트가 된다. 하트비트(물리 생존, `setInterval`·`terminate`)와 **별도 슬롯**이다.

### ConnectionContext 확장 (`packages/server/src/ws/connection.ts`)

E3-1 컨텍스트에 `account: AccountIdentity | null`(게이트 확정 신원)과 `deadline: Deadline | null`(진행 데드라인 핸들) 슬롯을 더한다. `cleanupConnection`이 `ctx.heartbeat`와 `ctx.deadline`을 모두 정리한다(idempotent 방어선).

### Env config (`packages/server/src/config/env.ts`)

`EnvSchema`에 세션 계층 2필드를 더한다.

- `WS_ALLOWED_ORIGINS` — **default 없이 fail-fast**(미설정 부팅 거부, CSWSH 방어 정책을 명시 설정으로 강제). 콤마 구분 문자열을 trim·빈 항목 제거로 origin 배열로 transform하고 `.refine`으로 최소 1개를 보장한다.
- `WS_SESSION_DEADLINE_MS`(기본 60000, `.int().min(1)`) — 진행 데드라인 시간. 0이면 진입 즉시 reap되어 무의미하므로 최소 1을 강제한다.

## 동작

### upgrade 인증 흐름

브라우저가 `wss + Cookie(__session) + Origin`으로 upgrade를 요청하면, `preValidation` 훅이 (1) Origin allowlist 대조(부재·불일치 403), (2) `__session` 검증(부재·무효 401), (3) 정원 reserve(전역 초과 503·계정별 초과 429, E3 하드닝 #54)를 순서대로 돈다. 통과 시 `req.account`에 신원을 실어 소켓 핸들러가 `ctx.account`로 확정한다. `auth.gate.test.ts`가 거부 시 `wsConnections.size === 0`(HTTP status뿐 아니라 소켓 미개방)을 단언한다.

### 세션 FSM 흐름

E3-1 버전 협상(`system:ready`) 완료(`accept`) 시 셸이 `enterInitialState`를 호출해 `characterSelect`로 진입시킨다 — 같은 message-handler 턴에 `session:characterList` + 선택 prompt를 동기 발화한다. 이후 pass 프레임은 셸이 세션 상태로 갈라 위임한다: `command` 상태면 E3-1 라우터(`dispatch`), 그 이전(characterSelect·create)이면 `handleSessionFrame`(FSM).

- **characterSelect** — `session:selectCharacter{characterId}`를 받으면 `assertOwnership`으로 소유권을 검증(통과 시 `session:entered` 발화 + `command` 전이, `OwnershipError`면 `unauthorized` error + 상태 유지). 선택 prompt에 `CREATE_SENTINEL`로 답하면 `create`로 전이한다.
- **create** — 이름→클래스→종족→확인 다단 대화. 각 단계에서 `session:reply{promptId, value}`의 `promptId`가 현재 step의 고정 promptId와 일치해야 하고(미일치·stale reply 거부), `value`를 Zod로 검증·누적한다. 확인 통과 시 `createCharacter`로 생성하고 `session:entered` 발화 후 `command` 전이. 무효 값·미일치는 `session_state` error + 현재 단계 유지(재응답 가능).
- **command** — E3-1 라우터로 위임하는 종단 상태(FSM 스텁 핸들러는 완전성용).

`ctx.state` 변이는 `enterState` 단일 지점에서만 일어난다. create 이탈 시 `onExit`이 `createProgress`를 정리한다(create 밖에선 null 불변식).

### prompt/response 상관

서버가 `session:prompt{promptId, kind, options?}`를 push → 클라가 `session:reply{promptId, value}`로 상관 응답 → 핸들러가 `promptId` 일치를 확인하고 서브상태를 진행한다. create 진행 필드는 서버 권위(`createProgress`)이며 클라 reply로 왕복시키지 않는다.

### 데드라인 수명주기

소켓 open 즉시 `deadline.rearm()`으로 최초 설정한다 — pre-handshake 창(open → `system:ready`)까지 묶어, 인증 게이트를 통과했으나 핸드셰이크를 완료하지 않는 미진행 연결이 영구 잔존(auto-pong이 하트비트 reap을 무력화)하는 것을 막는다. 상태 전이·create 서브상태 전진마다 `enterState`/`advanceCreate`가 재설정하고, `command`(월드 진입) 도달 시 `enterState`가 해제한다(이후 유휴는 하트비트 관할). `close` 시 `cleanupConnection`이 한 번 더 clear한다.

### 메시지 핸들러 방어선

message 핸들러는 JSON 파싱 실패를 `bad_payload`로 우선 응답하고, handshake/dispatch/FSM 경로의 예상치 못한 throw를 방어 `catch`로 격리한다 — 원인은 클라이언트에 노출하지 않되(정적 `internal` 메시지) `app.log.error({ err })`로 서버에 로깅한다(`buildSession`의 배선 불변식 위반 등이 무증상 실패가 되지 않게).

### 보안 자세

- **인가**: `assertOwnership` collapse로 캐릭터 존재/소유 비공개, FSM은 generic `unauthorized` 메시지만 발화.
- **입력 검증**: 프로토콜 스키마는 `strictObject` 판별 유니온(passthrough 없음), decider가 모든 값을 Zod 재검증. 자유 입력 문자열에 다층 길이 상한(`value` max 256, 이름 max 40).
- **prototype pollution**: 쿠키 파서 예약 키 차단 + `Object.hasOwn` 가드.
- **정보 미노출**: 에러 경로가 내부 상세를 노출하지 않음. 시드 자격증명은 프로덕션 빌드 제외.
- **프레임 상한**: E3-1 `maxPayload`(64KB)가 인바운드 프레임 크기를 서버측 강제.
- **자원 고갈 방어**: E3 하드닝(#54)이 연결 정원(전역·계정별)과 아웃바운드 backpressure로 유효 쿠키 1개의 무제한 연결·무제한 송신 버퍼 누적을 차단([`ws-resource-guard.md`](ws-resource-guard.md)).

### 테스트 전략

E3-1 `wsTestClient.testutil.ts`(실서버 포트 0 + 실 `ws` + `injectWS`)를 재사용하고 쿠키/Origin 헤더 주입 + 시드 어댑터 배선 헬퍼를 더한다. 검증: 게이트(유효 쿠키 통과·무효 401·Origin 403), FSM 전이(select→command, create 다단→command), prompt/response 상관(일치/미일치), 진행 데드라인 close(80ms fake). decider·핸들러는 순수 함수 단위 테스트, 인메모리 시드 어댑터로 Firebase 없이 결정적 실행. 커버리지 80%+ 게이트(배선 엔트리 제외).

## 제약사항

- **실 firebase-admin 어댑터·`accountId` Mongo 영구화는 E5(#35, [`account-character.md`](account-character.md) 구현 완료)** — E3-2는 세션 쿠키 **검증**만 하고 `validateSessionCookie`는 인메모리 `Map` 조회였다. E5가 firebase-admin `verifySessionCookie` 기반 실 어댑터(주입 verifier seam)·account 승급·Mongo character 영구화로 교체했다. `checkRevoked` 정책은 프로덕션 credential 프로비저닝과 함께 하드닝 defer([#89](https://github.com/smalljiny/muhan/issues/89)). 세션 쿠키 **발급**(`HttpOnly`/`Secure`/`SameSite`)은 여전히 발급자 책임으로 이 계층 밖이다.
- **세션 쿠키 속성(`HttpOnly`/`Secure`/`SameSite`)은 E5 발급자 책임** — 이 계층은 `__session`을 읽기만 하고 발급하지 않는다.
- **라이브 캐릭터 월드 인스턴스화(`WorldEntryPort`)는 E4(#34)** — 포트는 신원·소유권·요약까지만.
- **세션 레지스트리·중복 로그인 방어·재연결·상태 복원은 E3-3(#47)**.
- **실제 캐릭터 생성 규칙(스탯 롤·클래스/종족 코드 테이블 검증)은 E6/후속** — `create`는 최소 필드 다단만. class/race 범위 검증은 E5에서 `port/templates.js` 대조 후 확정.
- **정원 게이트(동시 접속 상한)·per-connection rate limiting·아웃바운드 send backpressure는 하드닝 토픽(#54)** — 미진행 유휴 연결은 진행 데드라인이 방어하나, 인증 쿠키 1개로 무제한 연결·응답 큐 무제한 증가 같은 자원 고갈 방어는 이 토픽 밖 seam이다. `plugin.ts`가 정원 게이트 자리를 주석 seam으로 남긴다.
- **`WS_SESSION_DEADLINE_MS` 단발 타이머 모델** — #50(SchedulerClock 공유 모듈)·#51(heartbeat 소유권) 타이머 계층 정리와 정합하도록 타이머 주입 seam을 둔다.
