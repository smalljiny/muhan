# 전송·프로토콜 기반 (E3-1)

> `@fastify/websocket` 게임 소켓 배선·`shared` Zod 프로토콜 계약(단일 출처)·1회 버전 협상 핸드셰이크·서버 주도 하트비트·`Map<type,handler>` 라우터의 정본. 무인증 `debug:echo` 왕복으로 end-to-end 검증한다.

## 개요

무한 포팅의 실시간 전송·프로토콜 계층 토대다. [`persistence.md`](persistence.md)(E2)가 세운 `buildApp()` Fastify 호스트와 `shared` 도메인 패키지 위에, ADR([`architecture.md`](architecture.md) D0 전송·D4 프로토콜)이 규정한 **구조화 WebSocket+JSON** 배선을 구체화한다. 원작 무한의 telnet `parse()`+`cmdlist[]` 선형 탐색·`str_compare` deepness·IAC 에코 협상·identd는 전부 **형상**으로 폐기하고(게임 분석 A2·A12 §7), 클라이언트가 명령과 인자를 이미 분리해 보내는 구조화 프로토콜로 재설계한다.

이 토픽은 **transport-only**다 — 연결 수락·종료 수명주기, 프로토콜 봉투 계약, 버전 협상, 하트비트, 라우팅만 확립한다. 세 경계가 핵심이다.

1. **client→server 명령 ↔ server→client 이벤트 경계** — `shared/protocol/`이 두 방향을 명시 분리된 두 판별 유니온(`clientCommandSchema`·`serverEventSchema`)으로 둔다. 서버 입력 검증은 command 유니온으로만, 클라 입력 검증은 event 유니온으로만 한다.
2. **핸드셰이크 ↔ 라우팅 경계** — 첫 프레임은 버전 협상(`handleHandshakeFrame`)이 소비하고, 핸드셰이크 완료(`ctx.ready=true`) 이후 프레임만 라우터(`dispatch`)로 넘어간다. 두 단계 모두 부수효과 없는 순수 함수가 상태 전이·응답을 계산하고, message 핸들러가 I/O를 실행한다.
3. **transport ↔ 인증 경계(seam)** — E3-1은 `verifyClient`·`preValidation`을 쓰지 않고 인증 seam만 라우트 옵션 자리에 주석으로 남겼다. **T2([`auth-session.md`](auth-session.md))가 이 자리에 `preValidation` 인증 게이트(세션 쿠키 검증·Origin allowlist)와 `SessionAuthPort`를 얹었다** — 여전히 `verifyClient`는 미사용이며 인증은 Fastify 수명주기 훅으로 upgrade 전에 게이트한다.

**범위 밖**(후속 토픽): 세션 쿠키 검증·세션 FSM(`characterSelect→create→command`)·prompt/response 다단 대화는 **T2로 구현됨**([`auth-session.md`](auth-session.md)), 재연결·세션 레지스트리·상태 복원은 T3, 실제 124 게임 명령 핸들러는 후속 명령 구현 토픽, 브로드캐스트 채널은 월드 상태 엔진 에픽, 프로덕션 TLS 종단·프록시 설정은 배포/인프라 토픽이다.

## 구조 / 스키마

### 프로토콜 계약 (`packages/shared/src/protocol/`)

`shared`의 기존 `schema/`(영속·도메인)와 **별개 모듈**이다 — 프로토콜은 와이어 메시지 계약, `schema/`는 저장 도메인 모델이다. 모든 TS 타입은 `z.infer`로만 파생하며 병렬 수기 타입을 두지 않는다. `index.ts` 배럴이 스키마·타입·`PROTOCOL_VERSION`을 함께 재노출하고, `shared/src/index.ts`가 이를 `export *`로 상위 노출한다. DOM 전역(`Event`·`Command`)과 충돌하지 않도록 파생 타입은 `ClientCommand`·`ServerEvent`로 한정 명명한다.

**`version.ts`** — `PROTOCOL_VERSION = 3`. 계약이 하위 비호환으로 바뀔 때마다 1씩 단조 증가시키는 정수(semver 미채택 — 와이어 호환성만 판단하면 되므로 정수 동등 비교가 단순). 핸드셰이크가 이 값을 실어 client·server가 같은 계약 세대를 쓰는지 대조한다.

**`payloads.ts`** — 명령 인자 패턴 building block 4종. 무한 명령 어휘가 인자 구조상 수렴하는 4패턴을 독립 `z.strictObject`로 못박아 command 봉투가 재사용한다. 다단 대화(prompt/response) payload는 T2 경계라 여기 두지 않는다.

| 스키마 | shape | 용도 |
|------|------|------|
| `noArgsPayloadSchema` | `{}` | (a) 무인자 — 대상·텍스트 없이 동작만(예: 둘러보기) |
| `targetOrdinalPayloadSchema` | `{ target: string, ordinal?: int }` | (b) 대상+서수 — 동명 대상이 여럿일 때 n번째 지목(생략 시 첫 번째) |
| `targetSecondaryPayloadSchema` | `{ target: string, secondary: string }` | (c) 대상+보조대상 — 두 대상을 엮음(예: 상자에 열쇠 사용) |
| `freeTextPayloadSchema` | `{ text: string }` | (d) 자유 텍스트 — 임의 문자열 한 덩어리(예: 말하기·echo) |

**`session.ts`** (T2) — 세션 계열 와이어 building block. `events.ts`가 `session:prompt`·`session:characterList` variant에서 재사용한다(import 방향은 events → session 단방향, 순환 없음). 영속 스키마(`schema/character.ts`)와 독립한 와이어 전용 신설이다(Pick/파생하지 않음).

| 스키마 | shape | 용도 |
|------|------|------|
| `promptKindSchema` | `z.enum(['selectCharacter', 'createField'])` | prompt 종류 — 선택 단계·생성 필드 입력 단계(확인도 createField) |
| `promptOptionSchema` | `{ value: string(min 1), label: string(min 1) }` | prompt 선택지 — `value`는 `session:reply.value`와 정합하는 기계값, `label`은 사람용 표시 |
| `characterSummarySchema` | `{ characterId, name, class: int, race: int, level: int }` | 캐릭터 선택 화면 와이어 요약 — 영속 `_id` 대신 `characterId`, persistence엔 없는 `level` 포함 |

**`commands.ts`** — `clientCommandSchema = z.discriminatedUnion('type', [...])`. top-level `type` 리터럴로 명령을 판별하며, 각 variant는 리터럴 discriminator를 둔 `strictObject`다.

- `{ type: 'system:ready', protocolVersion: int }` — 핸드셰이크 개시. client가 아는 프로토콜 버전을 실어 첫 메시지로 보낸다.
- `{ type: 'debug:echo', text: string(min 1), id?: string }` — 진단용 echo 요청. `freeTextPayloadSchema.shape`를 새 strictObject에 spread해 재사용하되 리터럴 discriminator·strict를 보존한다. `id`는 client가 응답을 짝짓는 optional 상관 키.
- `{ type: 'session:reply', promptId: string(min 1), value: string(min 1, max 256), id?: string }` — 세션 prompt 응답(T2). `promptId`가 지목한 질문에 `value`로 답한다. `value`는 자유 사용자 입력이라 거친 외곽 상한 `max 256`을 두고, 도메인별 세부 상한(캐릭터 이름 `max 40` 등)은 세션 핸들러가 추가로 강제한다(다층 방어).
- `{ type: 'session:selectCharacter', characterId: string(min 1), id?: string }` — 캐릭터 선택(T2). `characterId`로 입장할 캐릭터를 지목한다.
- `{ type: 'chat:message', channel: 'say'|'yell'|'broadcast', text: string(min 1, max 512), id?: string }` — 자유채팅(E3-4). `channel`로 전파 범위를 판별하고 `text`는 발화 내용. 채널 전파 대상 필드라 프레임 상한과 별개로 필드 단위 길이 상한을 둔다(DoS floor).
- `{ type: 'chat:emote', emote: string(min 1, max 64), target?: string(min 1, max 64), text?: string(min 1, max 512), id?: string }` — 감정표현(E3-4, A2 감정표현 action). `emote`가 주 콘텐츠(별칭, 값 검증은 채널 어댑터/E7), `target`은 대상 캐릭터, `text`는 선택적 부가 메시지. `freeTextPayloadSchema.shape`를 spread하지 않는다(그 shape의 text는 필수라 optional 의도와 충돌). 검증된 채팅 명령은 `ChannelPort`로 핸드오프된다([`freechat-permission-seam.md`](freechat-permission-seam.md)).
- `{ type: 'world:move', direction: string(min 1, max 32), id?: string }` — 이동. `direction`은 방 그래프 출구 **이름**과 정확 일치할 문자열이며, 상한 32는 입력 위생이다(어떤 출구 이름도 이 안에 든다). 방향 별칭·단축키 해소는 클라 책임이라 서버는 해소된 최종 문자열만 받고 `resolveExit` mode를 `directional`로 고정한다 — flee/sneak/named를 와이어에 노출하지 않는다. `targetOrdinalPayloadSchema`를 재사용하지 않는 이유가 이것이다. 정본 [`live-world-foundation.md`](live-world-foundation.md).
- `{ type: 'progress:train', id?: string }` — 연마. **인자가 없다** — 훈련방 여부·클래스 일치·exp·gold 게이트를 전부 서버(`progression/train`)가 소유하므로 클라는 의도만 보내고 대상·수량 같은 인자 표면을 두지 않는다(입력 위생 부담 0). `id`는 상관 키(선택) — 성공 통지 `progress:trained`는 상태 이벤트라 상관 키를 싣지 않고, 거부 시 `error` 이벤트가 이 `id`를 `correlationId`로 반향한다. 정본 [`progression.md`](progression.md).

**`events.ts`** — `serverEventSchema = z.discriminatedUnion('type', [...])` + `errorCodeSchema`.

- `{ type: 'system:hello', protocolVersion: int }` — 연결 직후 서버가 자기 버전을 push.
- `{ type: 'system:reload', reason: string(min 1) }` — 버전 불일치 시 재연결·재동기 지시. `reason`은 사람용 사유.
- `{ type: 'debug:echo:result', text: string(min 1), correlationId?: string }` — echo 응답. `correlationId`는 요청 `id`와 짝짓는 상관 키.
- `{ type: 'error', code: ErrorCode, message: string(min 1), correlationId?: string }` — 오류 통지. `code`는 기계 판독, `message`는 사람용.
- `{ type: 'session:prompt', promptId: string(min 1), kind: PromptKind, options?: PromptOption[] }` — 세션 prompt 제시(T2). `promptId`로 질문을 식별, `kind`로 단계(`selectCharacter`/`createField`)를, `options`로 선택지를 싣는다.
- `{ type: 'session:characterList', characters: CharacterSummary[] }` — 캐릭터 선택 화면이 실을 와이어 전용 요약 배열(T2).
- `{ type: 'session:entered', characterId: string(min 1) }` — 지목한 캐릭터로 월드 입장 확정 통지(T2).
- `{ type: 'world:room', roomId: int(min 0), exits: string[] }` — 최소 방 통지. 입장·이동 성공 시 본인에게 1회 발화한다. `exits`는 출구 **이름** 목록(인덱스가 아니다 — `world:move.direction`과 같은 어휘). 주변 점유자·아이템·방 설명은 싣지 않으며 상세 월드뷰는 후속 에픽이 확장한다. 정본 [`live-world-foundation.md`](live-world-foundation.md).
- `{ type: 'chat:said', channel: 'say'|'yell'|'broadcast'|'emote', speakerCharacterId: string(min 1), text: string(min 1, max 512), target?: string(min 1, max 64) }` — 채널 fan-out 수신측 통지. `ChannelDeliveryContext`와 1:1 매핑(발화자를 `speakerCharacterId`로 평탄화)이며, 인바운드 `chat:message`와 이름을 달리해(said vs message) 방향을 판별한다. 길이 상한은 인바운드 chat 명령과 동일 값을 아웃바운드에도 적용한다.
- `{ type: 'progress:trained', level: int(min 1), levelsGained: int(min 0), experience: int(min 0), gold: int(min 0), hpCurrent: int(min 0), mpCurrent: int(min 0), stats: [int×5], prestige: 'invincible'|'caretaker'|'none' }` — 연마 성공 통지. `train()`이 확정한 성장 결과 스냅샷을 본인에게 1회 발화한다. `world:room` 선례를 따라 **`correlationId`를 싣지 않는다**(상태 이벤트 — 거부만 `error`로 상관 키를 반향한다). train이 실제로 바꾸는 필드만 싣고 전체 캐릭터 상태 직렬화는 후속 토픽 몫이다. `levelsGained`가 0인 것은 유효하다 — 승급(무적·초인) 경로는 레벨을 올리지 않고 전이만 한다. `stats`는 `characterSchema.stats`와 동일한 5-튜플이며 numeric 하한도 `characterSchema`를 미러한다(클라 `wsClient`가 인바운드 프레임을 이 스키마로 `safeParse`하므로 형식적 정합이 아니라 실 입력 검증 표면이다). 정본 [`progression.md`](progression.md).

`errorCodeSchema = z.enum(['handshake_required', 'unknown_type', 'bad_payload', 'internal', 'unauthorized', 'session_state', 'forbidden', 'rate_limited'])` — `handshake_required`(핸드셰이크 전 명령 수신), `unknown_type`(미지 discriminator), `bad_payload`(payload 형식 위반), `internal`(핸들러/처리 중 서버 내부 오류), `unauthorized`(소유하지 않은 캐릭터 지목 등 **미인증** 세션의 인가 실패, T2), `session_state`(현재 세션 단계에서 허용되지 않는 명령, T2), `forbidden`(**인증됐으나** RBAC 권한 부족으로 거부, E3-4), `rate_limited`(인바운드 프레임이 연결·계정 속도 상한을 초과해 `JSON.parse` 전에 drop됨, #64 — 연속 폐기 구간의 첫 폐기에만 1회 통지, 정본 [`ws-rate-limit.md`](ws-rate-limit.md)). `unauthorized`(신원 없음, 재인증 유도)와 `forbidden`(신원 있으나 자격 없음, 권한 없음 안내)은 client-visible 의미가 다르다. WS upgrade **전** 게이트의 거부(`401 unauthenticated`·`403 forbidden_origin`)는 프로토콜 error 이벤트가 아니라 HTTP 응답이며 이 열거에 없다(auth-session.md 참조).

### 전송 배선 (`packages/server/src/ws/`)

`plugin.ts`가 배선의 중심이다. `GAME_SOCKET_PATH = '/game'`, `MAX_FRAME_BYTES = 64 * 1024`.

- **`connection.ts`** — per-connection 컨텍스트. `ConnectionContext { protocolVersion: number(불변, 서버 권위), ready: boolean(핸드셰이크 완료 여부), heartbeat: NodeJS.Timeout | null }`. `createConnectionContext()`가 `PROTOCOL_VERSION`·`ready=false`·`heartbeat=null`로 초기화. `cleanupConnection()`이 남은 ping 타이머를 `clearInterval`(멱등)로 정리하고 레지스트리에서 컨텍스트를 제거한다.
- **`frame.ts`** — 파싱된 프레임(`unknown`)에서 payload 스키마 검증 이전에 필드를 안전하게 읽는 primitive. `readField(parsed, key)`(객체·non-null·키 존재 가드 후 값 반환, 아니면 undefined), `readStringField(parsed, key)`(문자열일 때만 반환, 빈 문자열은 유효). null 가드가 load-bearing이다 — 없으면 `key in null`이 message 핸들러 안에서 throw한다. `key`는 호출부 리터럴이라 동적 키 주입 표면이 아니다.
- **`heartbeat.ts`** — per-connection 하트비트 매니저. 아래 §동작 참조.
- **`router.ts`** — `Map<type, handler>` 레지스트리·`dispatch` 순수 함수. 아래 §동작 참조. E3-4가 actor·permission threading + chat 엔트리를 얹었다([`freechat-permission-seam.md`](freechat-permission-seam.md)).
- **`handlers/echo.ts`** — 무인증 `echoHandler`. **`handlers/chat.ts`** — 자유채팅 `createChatHandler`(E3-4). 명령 디스패치 seam(`actorContext.ts`·`channelPort.ts`·`permissionPort.ts` + no-op/permissive 어댑터)은 [`freechat-permission-seam.md`](freechat-permission-seam.md) 정본.

`FastifyInstance`에 `wsConnections: Map<WebSocket, ConnectionContext>`를 module augmentation으로 선언하고 `app.decorate`로 노출한다 — 진단·하트비트 스윕·테스트 관찰의 단일 출처다.

## 동작

### 앱 배선 (`packages/server/src/app.ts`)

`buildApp(deps?)`가 `/health` REST 뒤에 `registerWebsocket(app)`을 무조건 호출한다. `deps.https`(`node:https` `ServerOptions`)를 넘기면 Fastify가 https 서버를 만들어 `wss` 종단을 지원한다(TLS-ready pass-through) — Fastify 타입 오버로드가 http 경로에 https 키를 거부하므로 분기한다. dev는 평문 loopback을 쓰므로 미주입이 기본이다.

`registerWebsocket(app)`은 `@fastify/websocket`을 `{ options: { maxPayload: MAX_FRAME_BYTES } }`로 먼저 등록한 뒤, 별도 encapsulated 플러그인에서 `/game` 라우트를 `{ websocket: true }`로 마운트한다("라우트보다 먼저 플러그인 등록" 관례를 top-level await 없이 만족). `verifyClient`은 쓰지 않는다(transport-only). `MAX_FRAME_BYTES`는 프로토콜 레이어(`maxPayload`)로 강제해 버퍼 완성 전에 초과 프레임을 1009 close로 거부한다 — 핸들러 안에서 크기를 재면 이미 버퍼링된 뒤라 방어가 안 된다.

명령 레지스트리는 무상태 핸들러 배선표라 연결 간 공유 안전하다 — E3-4가 `ChannelPort`를 클로저 주입하면서 모듈 싱글턴을 `registerWebsocket` 스코프의 `createCommandRegistry(channelPort)` 1회 조립으로 이동했다(레지스트리는 stateless Map이라 이동 비용 zero).

### 연결 수명주기

소켓 accept 시 message 핸들러가 다음을 배선한다.

1. `createConnectionContext()`로 컨텍스트를 만들어 `wsConnections`에 등록.
2. `getConfig()`의 튜닝값으로 `createHeartbeat(socket, ...)`을 만들고 `start()` 타이머 핸들을 `ctx.heartbeat`에 배선. `socket.on('pong')`이 `notePong()`으로 미스 카운터를 리셋.
3. `setImmediate`로 `system:hello{protocolVersion}`를 push. 동기 push는 injectWS 클라이언트가 message 리스너를 붙이기 전에 발화해 프레임이 드롭되는 레이스를 만들므로, 리스너 부착(promise 기반, `process.nextTick`보다 늦음) 뒤로 지연시킨다. 버전은 per-connection 권위인 `ctx.protocolVersion`을 단일 출처로 쓴다.
4. `socket.on('close')`가 `heartbeat.stop()` + `cleanupConnection()`으로 타이머를 정지·정리한다.

모든 서버→클라 전송은 `safeSend(socket, event)`를 거친다 — `readyState === OPEN`만 전송하고, 프레임 수신과 응답 사이에 피어가 닫아 `send`가 throw하는 경우를 삼킨다(곧 `close`가 발화해 cleanup이 돈다). 여기에 아웃바운드 backpressure 가드가 얹혀 있다 — payload를 미리 직렬화해 `bufferedAmount + payloadBytes > WS_MAX_BUFFERED_BYTES`면 느린 소비자로 판정해 `close(1013)`하고, send 콜백 오류는 로깅 후 코드 없는 `close()`로 잘라낸다(정본 [`ws-resource-guard.md`](ws-resource-guard.md)). 서버 종료 시 소켓 닫기는 `@fastify/websocket` 기본 `preClose`가 맡는다.

### 메시지 처리 파이프라인

`socket.on('message')`가 프레임마다 다음 순서를 실행한다.

0. **인바운드 유량 게이트**(#64) — `JSON.parse`보다 **앞**에 둔다. `ctx.rateLimiter.check(performance.now())`가 연결·계정 토큰 버킷을 AND 판정해 `accept`가 아니면 파싱·dispatch·idle 재-arm을 모두 우회하고 early-return한다(정본 [`ws-rate-limit.md`](ws-rate-limit.md)). flood 방어의 핵심이 파싱 CPU 소진 차단이므로 파싱 비용 이전에 초과분을 버려야 방어가 성립한다.
1. **JSON 파싱** — `frameToText(RawData)`(nodebuffer/Array/기타를 UTF-8로 정규화) 후 `JSON.parse`. 실패 시 `error{bad_payload}`로 응답하고 종료(type 판별보다 우선).
2. **핸드셰이크 게이트** — `handleHandshakeFrame(ctx, parsed)`가 반환한 `HandshakeResult`를 message 핸들러가 해석한다. 전체를 try/catch로 감싸 어떤 throw든 `error{internal}`로 격리하고 소켓을 생존시킨다(fastify errorHandler가 message 핸들러 예외를 잡지 못하므로 방어적 확장).

`handleHandshakeFrame`은 부수효과 없는 순수 함수이며, 상태 전이표는(malformed JSON은 이 함수 도달 전에 걸러진다):

| 상태 | 입력 | 결과 action | 부수효과 |
|------|------|-------------|----------|
| pre-ready | `system:ready` + 버전 정확 일치 | `accept` | `ctx.ready = true` |
| pre-ready | `system:ready` + 버전 불일치(누락·문자열·소수 포함) | `reload` | `system:reload` push 후 다음 tick에 `socket.close()` |
| pre-ready | `system:ready` 아님 | `error` | `error{handshake_required}` push |
| ready | `system:ready`(중복) | `error` | `error{handshake_required}` push |
| ready | 그 외 | `pass` | 라우터로 디스패치 |

버전 대조는 **서버 권위 정확 비교**(`readField(parsed, 'protocolVersion') === ctx.protocolVersion`, 강제 변환 없음)다. 핸드셰이크는 type+버전만 게이트하고 `clientCommandSchema` strict 파싱을 돌리지 않는다 — 여분 필드가 실려도 `ready`로 전이하나, ready 이후 모든 command는 라우터가 strict 검증하므로 우회 표면이 없다. `reload`는 프레임을 먼저 보내고 `setImmediate`로 close한다(같은 tick close가 프레임 플러시를 앞질러 클라이언트가 reload를 못 받는 injectWS 특이 동작 회피).

3. **`pass` 위임 분기** — 핸드셰이크를 통과한 프레임의 위임처는 세션 상태로 갈린다. `ctx.state === command`면 라우터(`dispatch`)로, 그 이전(`characterSelect`·`create`)이면 FSM `handleInput`으로 보낸다. 이미 파싱된 객체를 재파싱 없이 넘긴다.

**바인딩 신원 가드 (dispatch 직전)** — `ctx.state === command` 확인만으로는 부족하다. 서버 주도 종료(같은 캐릭터 재로그인 evict·grace 만료·shutdown 수렴)의 teardown은 transport만 정리하고(`cleanupConnection` + `socket.close`) 옛 `ctx`의 `state`·`boundCharacterId`는 되돌리지 않으며, `ctx.closed`도 소켓 `'close'` 이벤트(별개 리스너, 다음 tick)에서야 `true`가 된다. 그 창에서 이미 버퍼된 프레임의 `'message'`가 발화하면 승계된 옛 소켓이 `command` 상태·바인딩 키를 그대로 쥔 채 dispatch에 도달하고, 라이브 레지스트리는 `characterId` 키라 그 명령이 **새 세션의** 엔트리를 변이한다(이동·gold 소비 — 세션 신뢰 경계 침범). 따라서 이 `ctx`가 여전히 해당 캐릭터의 **현재 live 바인딩**일 때만 명령을 실행한다.

```ts
const binding = registry.get(actor.characterId)
const isCurrentBinding =
  binding !== undefined && binding.connection === ctx && binding.link === 'live'
if (!isCurrentBinding || ctx.closed) break   // 조용히 무시, idle 재-arm 없음
```

응답을 보내지 않는다 — 이 소켓은 이미 종결 중이라 `safeSend`가 OPEN 가드로 no-op이 될 공산이 크고, 승계된 연결에 응답을 돌려줄 계약도 없다. **idle 재-arm도 하지 않는다**(무효 명령이 새 세션의 무입력 창을 연장하지 못하게 한다 — rejected-nonrearm·rate-limit drop과 같은 원리). `binding.link === 'live'` 절은 defense-in-depth다: `markLinkDead`는 `'close'` 핸들러에서만 실행되고 그 핸들러가 `ctx.closed = true`를 먼저 세우므로 link-dead 케이스는 `|| ctx.closed`가 이미 차단한다. 세션 바인딩 계약은 [`session-lifecycle.md`](session-lifecycle.md)가 정본이다.

4. **idle 재-arm 정책** — `dispatch` 결과가 `handled`인 **유효 명령 처리 성공만** 무입력 타이머를 재-arm한다. 거부(`unknown_type`·`bad_payload`·`forbidden`·`internal`)는 flood로 타이머를 무한 연장하지 못한다.

### 라우터·핸들러 레지스트리 (`router.ts`)

`dispatch(registry, parsed, actor, permission)`는 핸드셰이크를 통과(`pass`)한 프레임을 O(1) 디스패치하는 순수 함수다. E3-4가 `actor: ActorContext`(3번째)·`permission: PermissionPort`(4번째) 파라미터를 threading했다([`freechat-permission-seam.md`](freechat-permission-seam.md)). 레이어 순서가 distinct error code를 강제하기 위해 load-bearing이다.

1. `readStringField(parsed, 'type')` 없음 → `error{unknown_type}`(상관 키 없음).
2. `registry.get(type)` 실패 → `error{unknown_type}`. **allowlist 가드** — 미등록/미지 type 차단. 레지스트리가 plain object가 아닌 실제 `Map`이라 `get('__proto__')`가 prototype 속성에 도달하지 않고 undefined를 반환해 prototype-pollution 우회를 원천 차단한다.
3. `clientCommandSchema.safeParse` 실패 → `error{bad_payload}`. 등록된 type이지만 payload 위반. discriminator가 등록 type임을 확인한 뒤 파싱하므로 정확히 그 variant를 검증한다(shared 계약 단일 출처).
4. `permission.check(command, actor)` false → `error{forbidden}`(E3-4). 검증된 명령(`parseResult.data`)만 권한 판정에 넘긴다 — payload 검증 이후, 핸들러 이전. E3 permissive 어댑터는 항상 allow라 이 레이어는 inert(회귀 없음).
5. `permission.check`·`handler(command, actor)` throw → `error{internal}`. 권한 판정·핸들러 예외를 같은 try/catch 격리 경계에서 잡아 소켓을 생존시킨다. `check`가 false를 반환하면 `forbidden`, throw하면 `internal`로 구분한다(throw하는 실 어댑터(E5)의 예외가 dispatch를 탈출해 correlationId를 잃지 않도록 격리).

상관 키 `id`는 type 판별 직후·payload 검증 이전에 `readStringField`로 추출해(빈 문자열도 유효 → `typeof`로 판별), `bad_payload`·`forbidden`·`internal` 응답도 상관 키를 실어 클라이언트가 실패를 상관지을 수 있게 한다. `unknown_type`은 type 판별 이전이라 상관 키를 싣지 않는다. `errorEvent()`는 `correlationId`가 있을 때만 키를 포함한다(undefined 키 금지).

`createCommandRegistry(channelPort, deps?)`는 무인증 `debug:echo`와 자유채팅 `chat:message`·`chat:emote`(→ `createChatHandler(channelPort)` 클로저)를 무조건 배선한다. E3-4가 `channelPort`를 필수 파라미터로 받으며(레지스트리 팩토리가 어댑터를 소유하지 않고 `registerWebsocket`이 default 주입), 모듈 싱글턴이던 레지스트리를 `registerWebsocket` 스코프로 이동했다. 레지스트리는 의도적으로 `clientCommandSchema`보다 좁은 런타임 디스패치 집합이다 — `system:ready`는 스키마에 있으나 핸드셰이크가 `pass` 이전에 소비하므로 등록하지 않는다. 신규 핸들러는 반드시 `clientCommandSchema`에도 variant를 추가해야 한다(스키마에 없는 type의 핸들러는 `safeParse`가 매칭하지 못해 영구히 `bad_payload`로 떨어진다).

**조건부 등록 deps 번들 (`GameCommandDeps`)** — 라이브 상태 seam을 요구하는 게임 명령은 deps가 주입될 때만 등록된다. 명령 하나당 필드 하나를 갖는 번들 객체로 받는다.

```ts
export interface GameCommandDeps {
  readonly move?: MoveHandlerDeps
  readonly train?: TrainHandlerDeps
}
createCommandRegistry(channelPort: ChannelPort, deps?: GameCommandDeps): HandlerRegistry
```

명령이 늘 때마다 팩토리에 optional **위치 파라미터**를 덧붙이면 호출부가 인자 순서에 결합되고, 중간 명령만 미주입하려면 `undefined` 자리 채우기가 필요해진다. 필드 번들이 그 결합을 끊는다 — 호출부는 배선할 명령의 필드만 채우고, 필드가 없으면 그 명령은 미등록으로 남아 dispatch가 `unknown_type`을 반환한다(방 배치·영속 seam이 아직 없는 컨텍스트의 기본 동작). 모든 필드가 optional이라 번들 자체도 optional이며, 무-deps 호출부(라우터 순수 단위 테스트 등)는 1-인자 형태 그대로다. 현재 `deps.move`(→ `world:move`)·`deps.train`(→ `progress:train`) 둘을 받고, 후속 규칙 명령(teach·study·attack·cast)이 같은 형상으로 필드를 더한다.

`echoHandler(command, _actor)`는 `debug:echo{text, id?}` → `debug:echo:result{text, correlationId?}`로 되돌린다. `actor`를 받되 무시하는 무권한 진단 핸들러다. 라우터가 이미 검증한 `ClientCommand`만 받으므로 payload를 재검증하지 않는다. `id`가 있을 때만(`!== undefined`, 빈 문자열도 유효) `correlationId` 키를 싣는다.

### 하트비트 (`heartbeat.ts`)

서버 주도 canonical 패턴(`ws` `isAlive`/`ping`/`terminate`)의 **단일 인터벌(isAlive) 모델**이다. `createHeartbeat(socket, opts)`가 상태(미스 카운트·`awaitingPong`·타이머 핸들)를 클로저에 캡슐화하고 `{ start, stop, notePong }`을 반환한다.

- `start()` — `missedPongs=0`·`awaitingPong=false`로 초기화하고 `pingIntervalMs`마다 `tick`을 도는 인터벌 타이머 핸들을 반환.
- `tick()` — `awaitingPong`이면(직전 ping의 pong 미수신) `missedPongs += 1`, `maxMissed` 도달 시 `socket.terminate()` + `stop()`. 이후 `awaitingPong=true`로 세우고 `socket.ping()`.
- `notePong()` — `missedPongs=0`·`awaitingPong=false`로 리셋(연결 생존 신호).
- `stop()` — 타이머 clear(멱등).

타이머는 `clock?: SchedulerClock` 단일 seam으로 주입 가능(`util/clock.ts` 공유 계약 — saveScheduler·WorldClock과 동일 관용구)이라 fake clock으로 결정적 단위 테스트가 가능하고, 미주입 시 `defaultClock`(전역 타이머)을 쓴다. 첫 인터벌은 미스를 세지 않고 ping만 보내므로 종료까지 ≈ `pingIntervalMs × (maxMissed + 1)`이다(기본값 25s·3 → ≈ 100s).

### Env config (`packages/server/src/config/env.ts`)

`EnvSchema`에 하트비트 튜닝 3필드를 추가한다(모두 `z.coerce.number().int().min(1)`).

- `WS_HEARTBEAT_PING_INTERVAL_MS`(기본 25000) — ping 간격·유효 per-pong 마감.
- `WS_HEARTBEAT_MAX_MISSED`(기본 3) — 연속 미스 종료 임계.
- `WS_HEARTBEAT_PONG_TIMEOUT_MS`(기본 10000) — **예약 seam**. 현재 단일 인터벌 모델은 소비하지 않는다(유효 마감은 이 값이 아니라 `PING_INTERVAL`) — 향후 이중 타이머 모델 도입 시 소비. 운영자 오도를 막기 위해 무효임을 스키마 주석에 명시한다.

`getConfig()`는 `plugin.ts`가 연결마다 읽어 `createHeartbeat`에 `pingIntervalMs`·`maxMissed`를 넘긴다.

E3 하드닝(#54)이 자원 한도 3필드(`WS_MAX_CONNECTIONS`·`WS_MAX_CONNECTIONS_PER_ACCOUNT`·`WS_MAX_BUFFERED_BYTES`)를 같은 `EnvSchema`에 더했다 — 연결 정원·아웃바운드 backpressure 튜닝값이며 정본은 [`ws-resource-guard.md`](ws-resource-guard.md)다. E3 하드닝 후속(#64)이 인바운드 유량 상한 5필드(`WS_MSG_RATE_CAPACITY`·`WS_MSG_RATE_REFILL_PER_SEC`·`WS_MSG_RATE_ACCOUNT_CAPACITY`·`WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC`·`WS_MSG_RATE_MAX_VIOLATIONS`)를 더했다 — 연결·계정 토큰 버킷 튜닝값이며 정본은 [`ws-rate-limit.md`](ws-rate-limit.md)다.

### 테스트 전략 (`packages/server/src/ws/`)

**실서버(포트 0)+실 `ws` 클라이언트+Vitest**가 이 스택 최적이다(리서치 `ws-e2e-cli-tools-20260706.md` 확정). `wsTestClient.testutil.ts`가 injectWS 클라이언트(단위)와 실 `ws` 클라이언트(E2E)를 함께 관찰하는 헬퍼를 제공한다.

- `waitForMessage(ws)`/`waitForClose(ws)`/`waitForOpen(ws)` — 최소 emitter 계약(`{ once(event, cb) }`)에만 의존해 injectWS·실 `ws` 클라이언트가 동일하게 충족. `waitForMessage`는 `serverEventSchema.parse`로 검증·파싱하고 계약 밖 이벤트는 clean reject한다. `send` 전에 리스너를 먼저 걸어 `system:hello` 드롭 레이스를 없앤다.
- `waitFor(predicate)` — 서버측 상태 전이(연결 레지스트리 크기 등)를 경합 없이 폴링.
- `startTestServer(app)` — 포트 0·`127.0.0.1`(IPv4 loopback 명시, `localhost`의 ::1 resolve로 인한 간헐 ECONNREFUSED 회피)로 리슨시켜 `ws://` URL 반환.
- `newClient(url, opts)` — open을 기다리지 않고 동기 반환해 리스너를 먼저 걸게 함. `autoPong: false`로 프로토콜 레벨 자동 pong을 억제해 하트비트-miss terminate를 실 소켓으로 강제할 수 있다.

각 패키지 vitest 커버리지 80%+ 게이트(배선 엔트리 제외, 앱 팩토리는 injectWS 스모크).

## 제약사항

- **인증·세션은 T2에서 구현됨** — E3-1 handshake 자체는 transport-only다. 세션 쿠키 검증·Origin 체크·`SessionAuthPort`·`preValidation` 훅·세션 FSM(`characterSelect→create→command`)·prompt/response 다단 대화는 T2([`auth-session.md`](auth-session.md))가 이 위에 얹었다. 평문→해시 비밀번호 교체는 Firebase Auth 위임(발급 E5)으로 해소, checkdouble 동시접속 방어는 T3 세션 레지스트리 경계다.
- **재연결은 T3** — 세션 레지스트리·상태 복원(onReconnect)은 이 토픽에 없다.
- **실 게임 명령 핸들러는 후속 토픽** — 이 계층은 5 인자 패턴 스키마 + 무인증 `debug:echo` 하나만 배선한다. 실제 124 게임 명령(이동·전투·마법·아이템·소셜·DM) 핸들러와 명령→구조화 이벤트 매핑은 후속 명령 구현 토픽. 어떤 실게임 command가 "직접 응답 있음(질의형)"인지의 correlationId 반향 대상 목록도 그때 정해진다.
- **다단 대화 payload 없음** — `payloads.ts`는 4패턴(무인자/대상+서수/대상+보조대상/자유텍스트)만 정의한다. 5번째 prompt/response 다단 payload는 T2 경계다.
- **`debug:echo`는 무권한 노출** — 진단·파이프라인 검증 전용이다. 프로덕션 빌드 제거/플래그 게이트 여부는 후속 하드닝에서 재검토한다.
- **`WS_HEARTBEAT_PONG_TIMEOUT_MS`는 미소비 예약 seam** — 현재 단일 인터벌 모델의 유효 per-pong 마감은 `PING_INTERVAL`이다. 이 필드를 낮춰도 종료 타이밍은 바뀌지 않는다.
- **TLS는 TLS-ready pass-through만** — `buildApp`이 `https` 서버 옵션을 Fastify로 pass-through해 `wss`를 지원한다. dev는 평문 loopback `ws`. 프로덕션 TLS 종단 지점(Fastify https vs 리버스 프록시)과 하트비트 인터벌 확정값(프록시 idle timeout 75% 규칙)은 배포/인프라 토픽에서 재조정한다.
- **`protocolVersion` bump 정책 미확정** — 형식은 단조 증가 정수로 확정(현재 `2` — 라이브 월드 foundation의 `world:move`·`world:room`·`chat:said` 신설에서 1→2). *언제* 올리는가(호환 불가 변경 기준·문서화)는 프로토콜이 커질 때 별도로 정한다.
- **한글 자유 텍스트 파서 없음** — E3-4가 자유채팅 입력을 `ChannelPort`로 핸드오프하는 seam을 얹었고([`freechat-permission-seam.md`](freechat-permission-seam.md)) 라이브 월드 foundation이 실 방 채널 어댑터를 결선해 같은 방 전파는 동작한다([`live-world-foundation.md`](live-world-foundation.md)). 전서버 방송·외쳐 1홉 인접 전파·구독 필터는 소셜 에픽(#37), 동사-후치 자유 텍스트 파서는 자유 모드 UI 토픽(구조화 명령은 클라가 이미 분리 전송), 조사 i18n 렌더·클라이언트 UI는 프론트엔드 토픽이다.
