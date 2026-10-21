# 전송·프로토콜 기반 (E3-1)

> 다음을 정한 기준 문서다: `@fastify/websocket` 게임 소켓 연결, `shared` Zod 프로토콜 계약(단일 출처), 1회 버전 협상 핸드셰이크, 서버 주도 하트비트, `Map<type,handler>` 라우터. 무인증 `debug:echo` 왕복으로 end-to-end 검증한다.

## 개요

무한 포팅의 실시간 전송·프로토콜 계층의 기반이다. [`persistence.md`](persistence.md)(E2)가 만든 `buildApp()` Fastify 호스트와 `shared` 도메인 패키지를 그대로 쓰고, ADR([`architecture.md`](architecture.md) D0 전송·D4 프로토콜)이 규정한 **구조화 WebSocket+JSON** 연결을 구체화한다. 원작 무한의 telnet 방식, 곧 `parse()`+`cmdlist[]` 선형 탐색, `str_compare` deepness, IAC 에코 협상, identd는 전부 **구현 방식**으로 분류해 폐기한다(게임 분석 A2·A12 §7). 대신 클라이언트가 명령과 인자를 이미 분리해 보내는 구조화 프로토콜로 재설계한다.

이 토픽은 **transport-only**다. 연결 수락·종료 수명주기, 프로토콜 봉투 계약, 버전 협상, 하트비트, 라우팅만 확립한다. 핵심은 세 경계다.

1. **client→server 명령 ↔ server→client 이벤트 경계** — `shared/protocol/`은 두 방향을 명시적으로 분리된 두 판별 유니온(`clientCommandSchema`·`serverEventSchema`)으로 둔다. 서버는 입력을 command 유니온으로만 검증하고, 클라는 입력을 event 유니온으로만 검증한다.
2. **핸드셰이크 ↔ 라우팅 경계** — 첫 프레임은 버전 협상(`handleHandshakeFrame`)이 소비한다. 핸드셰이크가 완료된(`ctx.ready=true`) 뒤의 프레임만 라우터(`dispatch`)로 넘어간다. 두 단계 모두 부수효과 없는 순수 함수가 상태 전이와 응답을 계산하고, I/O는 message 핸들러가 실행한다.
3. **transport ↔ 인증 경계(seam)** — E3-1은 `verifyClient`나 `preValidation`을 쓰지 않고, 라우트 옵션 자리에 인증 seam만 주석으로 남겼다. 이후 **T2([`auth-session.md`](auth-session.md))가 이 자리에 `preValidation` 인증 게이트(세션 쿠키 검증·Origin allowlist)와 `SessionAuthPort`를 더했다**. `verifyClient`는 여전히 쓰지 않으며, 인증은 Fastify 수명주기 훅으로 upgrade 전에 게이트한다.

**범위 밖**(후속 토픽):

- 세션 쿠키 검증, 세션 FSM(`characterSelect→create→command`), prompt/response 다단 대화: **T2로 구현됨**([`auth-session.md`](auth-session.md))
- 재연결, 세션 레지스트리, 상태 복원: T3
- 실제 124 게임 명령 핸들러: 후속 명령 구현 토픽
- 브로드캐스트 채널: 월드 상태 엔진 에픽
- 프로덕션 TLS 종단, 프록시 설정: 배포/인프라 토픽

## 구조 / 스키마

### 프로토콜 계약 (`packages/shared/src/protocol/`)

`shared`의 기존 `schema/`(영속·도메인)와는 **별개 모듈**이다. 프로토콜은 와이어 메시지 계약이고, `schema/`는 저장 도메인 모델이다. 모든 TS 타입은 `z.infer`로만 파생하며 병렬로 손으로 쓴 타입을 두지 않는다. `index.ts` 배럴이 스키마, 타입, `PROTOCOL_VERSION`을 함께 재노출하고, `shared/src/index.ts`가 이를 `export *`로 상위에 노출한다. 파생 타입 이름은 DOM 전역(`Event`·`Command`)과 충돌하지 않도록 `ClientCommand`·`ServerEvent`로 한정한다.

**`version.ts`** — `PROTOCOL_VERSION = 6`. 계약이 하위 비호환으로 바뀔 때마다 1씩 단조 증가시키는 정수다. semver는 쓰지 않는다. 와이어 호환성만 판단하면 되므로 정수 동등 비교가 더 단순하기 때문이다. 핸드셰이크가 이 값을 실어 보내, client와 server가 같은 계약 세대를 쓰는지 대조한다.

- 직전 bump(5 → 6)는 #121의 `combat:attack` 명령과 `combat:attacked`·`character:stats` 이벤트 신설이다. 판별 union에 variant를 더하면 구버전 서버가 신규 `type`을 `unknown_type`으로 거부하기 때문에 올렸다.
- 그 전 bump는 #120의 `progress:study` 명령·`progress:studied` 이벤트 신설(4 → 5)이었다.
- 그 전은 E11(#60)의 `world:room` 페이로드 확장이었다. 기존 variant가 `z.strictObject`라 required 필드를 추가하면 구버전 클라의 `safeParse`가 깨진다.

**`payloads.ts`** — 명령 인자 패턴의 building block 4종이다. 무한의 명령 어휘는 인자 구조로 보면 4패턴으로 수렴한다. 이 4패턴을 독립된 `z.strictObject`로 고정해 command 봉투가 재사용한다. 다단 대화(prompt/response) payload는 T2 경계라 여기에 두지 않는다.

| 스키마 | shape | 용도 |
|------|------|------|
| `noArgsPayloadSchema` | `{}` | (a) 무인자. 대상이나 텍스트 없이 동작만 한다(예: 둘러보기) |
| `targetOrdinalPayloadSchema` | `{ target: string(1..32), ordinal?: int(1..99) }` | (b) 대상+서수. 같은 이름의 대상이 여럿일 때 n번째를 지목한다(생략 시 첫 번째). 상한은 모듈 상수 `COMMAND_TARGET_MAX`(32)·`COMMAND_ORDINAL_MAX`(99)가 정하고, `progress:study`·`combat:attack`이 이 블록을 spread한다(#121) |
| `targetSecondaryPayloadSchema` | `{ target: string, secondary: string }` | (c) 대상+보조대상. 두 대상을 엮는다(예: 상자에 열쇠 사용) |
| `freeTextPayloadSchema` | `{ text: string }` | (d) 자유 텍스트. 임의 문자열 한 덩어리다(예: 말하기·echo) |

**`session.ts`** (T2) — 세션 계열 와이어 building block이다. `events.ts`가 `session:prompt`·`session:characterList` variant에서 재사용한다. import 방향은 events → session 단방향이라 순환이 없다. 영속 스키마(`schema/character.ts`)와 독립된 와이어 전용 스키마로 새로 만들었다(Pick이나 파생을 쓰지 않음).

| 스키마 | shape | 용도 |
|------|------|------|
| `promptKindSchema` | `z.enum(['selectCharacter', 'createField'])` | prompt 종류. 선택 단계와 생성 필드 입력 단계(확인도 createField) |
| `promptOptionSchema` | `{ value: string(min 1), label: string(min 1) }` | prompt 선택지. `value`는 `session:reply.value`와 일치하는 기계값, `label`은 사람이 보는 표시 |
| `characterSummarySchema` | `{ characterId, name, class: int, race: int, level: int }` | 캐릭터 선택 화면의 와이어 요약. 영속 `_id` 대신 `characterId`를 쓰고, persistence에는 없는 `level`을 포함 |

**`commands.ts`** — `clientCommandSchema = z.discriminatedUnion('type', [...])`. top-level `type` 리터럴로 명령을 판별하며, 각 variant는 리터럴 discriminator를 둔 `strictObject`다.

- `{ type: 'system:ready', protocolVersion: int }` — 핸드셰이크 개시. client가 아는 프로토콜 버전을 실어 첫 메시지로 보낸다.
- `{ type: 'debug:echo', text: string(min 1), id?: string }` — 진단용 echo 요청. `freeTextPayloadSchema.shape`를 새 strictObject에 spread해 재사용하되, 리터럴 discriminator와 strict는 유지한다. `id`는 client가 응답을 짝짓는 optional 상관 키다.
- `{ type: 'session:reply', promptId: string(min 1), value: string(min 1, max 256), id?: string }` — 세션 prompt 응답(T2). `promptId`가 가리키는 질문에 `value`로 답한다. `value`는 자유 사용자 입력이라 바깥쪽에 거친 상한 `max 256`을 둔다. 도메인별 세부 상한(캐릭터 이름 `max 40` 등)은 세션 핸들러가 추가로 강제한다(다층 방어).
- `{ type: 'session:selectCharacter', characterId: string(min 1), id?: string }` — 캐릭터 선택(T2). `characterId`로 입장할 캐릭터를 지목한다.
- `{ type: 'chat:message', channel: 'say'|'yell'|'broadcast', text: string(min 1, max 512), id?: string }` — 자유채팅(E3-4). `channel`이 전파 범위를 정하고 `text`는 발화 내용이다. 채널로 전파되는 필드라 프레임 상한과 별도로 필드 단위 길이 상한을 둔다(DoS floor).
- `{ type: 'chat:emote', emote: string(min 1, max 64), target?: string(min 1, max 64), text?: string(min 1, max 512), id?: string }` — 감정표현(E3-4, A2 감정표현 action).
  - `emote`가 주 콘텐츠(별칭)이며, 값 검증은 채널 어댑터/E7이 한다. `target`은 대상 캐릭터, `text`는 선택적인 부가 메시지다.
  - `freeTextPayloadSchema.shape`를 spread하지 않는다. 그 shape의 text는 필수라 optional로 두려는 의도와 맞지 않는다.
  - 검증된 채팅 명령은 `ChannelPort`로 넘겨진다([`freechat-permission-seam.md`](freechat-permission-seam.md)).
- `{ type: 'world:move', direction: string(min 1, max 32), id?: string }` — 이동.
  - `direction`은 방 그래프 출구 **이름**과 정확히 일치해야 하는 문자열이다. 상한 32는 입력 위생용이다(어떤 출구 이름도 이 안에 든다).
  - 방향 별칭과 단축키 해석은 클라 책임이다. 서버는 해석된 최종 문자열만 받고 `resolveExit` mode를 `directional`로 고정한다. flee/sneak/named는 와이어에 노출하지 않는다. `targetOrdinalPayloadSchema`를 재사용하지 않는 이유가 이것이다.
  - 기준은 [`live-world-foundation.md`](live-world-foundation.md)다.
- `{ type: 'progress:train', id?: string }` — 연마.
  - **인자가 없다.** 훈련방 여부, 클래스 일치, exp·gold 게이트를 전부 서버(`progression/train`)가 담당한다. 그래서 클라는 의도만 보내고, 대상이나 수량 같은 인자를 두지 않는다(입력 위생 부담 0).
  - `id`는 선택적인 상관 키다. 성공 통지 `progress:trained`는 상태 이벤트라 상관 키를 싣지 않는다. 거부하면 `error` 이벤트가 이 `id`를 `correlationId`로 돌려준다.
  - 기준은 [`progression.md`](progression.md)다.
- `{ type: 'progress:study', target: string(min 1, max 32), ordinal?: int(min 1, max 99), id?: string }` — 비법서 연마(#120).
  - `progress:train`과 달리 **대상 인자가 있다**. 오라클이 소지품에서 이름으로 책을 지목하기 때문이다. `target`은 아이템 이름이나 별칭(`keys`)과 대조할 문자열이고, 상한 32는 입력 위생용이다(어떤 아이템 이름도 이 안에 든다).
  - `ordinal`은 같은 이름의 아이템 중 몇 번째인지를 나타낸다(`비법서 2 연마`). 아이템 id는 와이어로 받지 않는다. 클라가 남의 아이템 id를 지목할 여지 자체를 없애기 위해서다. 대상 해석은 서버가 행위자 인벤 스코프 안에서만 한다.
  - 하한 `min 1`은 오라클 파서가 서수가 없을 때 `val[1]=1`을 넣는 것과 일치한다.
  - 기준은 [`magic-progression.md`](magic-progression.md)다.

- `{ type: 'combat:attack', target: string(min 1, max 32), ordinal?: int(min 1, max 99), id?: string }` — 근접 공격(#121).
  - `targetOrdinalPayloadSchema.shape`를 spread해 `progress:study`와 같은 지목 문법을 쓴다(상한 정의를 두 곳에 흩지 않는다). `target`은 방 안 몬스터 이름이나 별칭과 대조할 문자열이고, `ordinal`은 같은 이름의 몬스터 중 몇 번째인지다.
  - **몬스터 `instanceId`를 와이어로 받지 않는다.** 클라가 다른 방 개체를 지목할 여지 자체를 없애기 위해서다. 대상 해석은 서버가 행위자의 현재 방 스코프 안에서만 한다.
  - 사람을 지목하면 PvP는 범위 밖이므로 `rule_rejected`로 거부한다.
  - 기준은 [`combat.md`](combat.md)다.

**`events.ts`** — `serverEventSchema = z.discriminatedUnion('type', [...])` + `errorCodeSchema`.

- `{ type: 'system:hello', protocolVersion: int }` — 연결 직후 서버가 자기 버전을 push한다.
- `{ type: 'system:reload', reason: string(min 1) }` — 버전이 맞지 않을 때 재연결과 재동기를 지시한다. `reason`은 사람이 읽는 사유다.
- `{ type: 'debug:echo:result', text: string(min 1), correlationId?: string }` — echo 응답. `correlationId`는 요청 `id`와 짝을 맞추는 상관 키다.
- `{ type: 'error', code: ErrorCode, message: string(min 1), correlationId?: string }` — 오류 통지. `code`는 기계가 읽고 `message`는 사람이 읽는다.
- `{ type: 'session:prompt', promptId: string(min 1), kind: PromptKind, options?: PromptOption[] }` — 세션 prompt 제시(T2). `promptId`로 질문을 식별하고, `kind`로 단계(`selectCharacter`/`createField`)를, `options`로 선택지를 싣는다.
- `{ type: 'session:characterList', characters: CharacterSummary[] }` — 캐릭터 선택 화면에 보낼 와이어 전용 요약 배열(T2).
- `{ type: 'session:entered', characterId: string(min 1) }` — 지목한 캐릭터로 월드에 입장했음을 확정하는 통지(T2).
- `{ type: 'world:room', roomId: int(min 0), exits: string[], name: string, longDesc: string, occupants: {characterId: string(min 1), name: string(min 1)}[], items: {instanceId: string(min 1), name: string}[], creatures: {instanceId: string(min 1), name: string, level: int(min 0)}[] }` — 방 상태 스냅샷. 입장이나 이동에 성공하면 본인에게 1회 보낸다.
  - `exits`는 출구 **이름** 목록이다(인덱스가 아니며, `world:move.direction`과 같은 어휘). 문 상태(`XLOCKD`/`XCLOSD`)를 노출하지 않도록 `z.array(z.string())`을 유지한다. 잠긴 문은 이동을 시도했을 때 `error{rule_rejected}`로 답한다.
  - `name`·`longDesc`는 빈 문자열도 유효하다(각각 97방·433방). 그래서 `.min(1)`을 걸지 않고, 표시 fallback은 클라이언트가 맡는다.
  - `occupants`는 **본인을 포함**하며, 본인을 빼는 것은 클라이언트 책임이다. 수신자마다 다른 페이로드를 만들면 방 단위 fan-out 캐시를 쓸 수 없기 때문이다.
  - `shortDesc`는 싣지 않는다(2341방 중 2327방이 빈 문자열).
  - 서버가 싣는 목록은 오라클 방 표시 규칙으로 걸러진 것이다. [`movement-rooms.md`](movement-rooms.md) §방 표시 가시성 필터를 참조한다. 기준은 [`live-world-foundation.md`](live-world-foundation.md)다.
- `{ type: 'chat:said', channel: 'say'|'yell'|'broadcast'|'emote', speakerCharacterId: string(min 1), text: string(min 1, max 512), target?: string(min 1, max 64) }` — 채널 fan-out을 받는 쪽에 보내는 통지. `ChannelDeliveryContext`와 1:1로 매핑되며, 발화자는 `speakerCharacterId`로 평탄화한다. 인바운드 `chat:message`와 이름을 다르게 해(said vs message) 방향을 구분한다. 길이 상한은 인바운드 chat 명령과 같은 값을 아웃바운드에도 적용한다.
- `{ type: 'progress:trained', level: int(min 1), levelsGained: int(min 0), experience: int(min 0), gold: int(min 0), hpCurrent: int(min 0), mpCurrent: int(min 0), stats: [int×5], prestige: 'invincible'|'caretaker'|'none' }` — 연마 성공 통지. `train()`이 확정한 성장 결과 스냅샷을 본인에게 1회 보낸다.
  - `world:room` 선례를 따라 **`correlationId`를 싣지 않는다**. 상태 이벤트이기 때문이다. 거부할 때만 `error`로 상관 키를 돌려준다.
  - train이 실제로 바꾸는 필드만 싣는다. 전체 캐릭터 상태 직렬화는 후속 토픽이 맡는다.
  - `levelsGained`가 0이어도 유효하다. 승급(무적·초인) 경로는 레벨을 올리지 않고 전이만 하기 때문이다.
  - `stats`는 `characterSchema.stats`와 같은 5-튜플이며, numeric 하한도 `characterSchema`를 그대로 따른다. 클라 `wsClient`가 인바운드 프레임을 이 스키마로 `safeParse`하므로, 형식상의 일치가 아니라 실제 입력 검증 지점이다.
  - 기준은 [`progression.md`](progression.md)다.

- `{ type: 'progress:studied', spellNo: int(0..127), spellName: string(min 1), spells: [int(0..255) × 16], consumedObjectId: string(min 1) }` — 비법서 연마 성공 통지(#120). `study()`가 확정한 지식 상태를 본인에게 1회 보낸다.
  - `progress:trained` 선례를 따라 **`correlationId`를 싣지 않는다**(상태 이벤트).
  - `spells`는 갱신된 주문 지식 비트마스크 전체다. `consumedObjectId`는 소멸한 비법서의 인스턴스 id이며, 클라가 인벤 뷰에서 해당 항목을 지우는 데 쓴다.
  - `spellNo` 상한과 `spells` 길이는 모듈 상수 `SPELL_MASK_BYTES = 16`에서 파생한다. 이 상수는 `magic/spellStore.ts`·`schema/character.ts`와 같은 값이지만, import하지 않고 따로 선언한다. 와이어 계약이 도메인 상수를 따라 조용히 바뀌면 안 되기 때문이다(바뀌면 version bump 대상).
  - 형태가 어긋나면 `events.test.ts`의 `characterSchema.spells` 교차 드리프트 테스트가 잡는다.
  - 기준은 [`magic-progression.md`](magic-progression.md)다.

- `{ type: 'combat:attacked', targetName: string(min 1), targetInstanceId: int(min 0), hit: boolean, damage: int(min 0), critical: boolean, fumble: boolean, died: boolean, attacks: {hit, damage, critical, fumble, durabilityHit, weaponDropped}[] }` — 공격 결과 통지(#121). 공격한 본인에게 1회 보낸다.
  - `world:room` 선례를 따라 **`correlationId`를 싣지 않는다**(상태 이벤트).
  - `targetInstanceId`를 이름과 함께 싣는 이유는, 같은 이름의 몬스터가 방에 여럿일 때 클라가 어느 개체를 맞혔는지 짝지어야 하기 때문이다.
  - `attacks`는 타격별 배열이다. 지금은 `PUPDMG`가 영속되지 않아 항상 원소가 1개다(다중공격은 구조상 동작하지 않음). 그래도 배열 형태를 지금 고정해 두면, #61이 타격별 연출을 붙일 때 version bump를 다시 하지 않아도 된다.
  - 서버측 원천은 `combat/resolveAttack.ts`의 `AttackDescriptor`다. shared는 server를 import할 수 없으므로, 일치 여부는 반대편(`combat/attackDescriptorWire.test.ts` 컴파일타임 대조)에서 강제한다.
  - 기준은 [`combat.md`](combat.md)다.
- `{ type: 'character:stats', hpCurrent: int(min 0), hpMax: int, mpCurrent: int(min 0), mpMax: int, experience: int(min 0), level: int(min 1) }` — 스탯 스냅샷(#121).
  - `combat:attack`·`progress:train`·`progress:study` **세 명령 모두** 성공하면 이 이벤트를 함께 보낸다. 스탯 변화 통지 경로를 하나로 통일해, 클라이언트가 이벤트 한 종만 보고 패널을 갱신하게 한다.
  - 상태 이벤트라 `correlationId`를 싣지 않는다.
  - 최대치(`hpMax`·`mpMax`)는 저장하지 않고 `resolveHpMax`·`resolveMpMax`로 파생한다(`progression/maxResolvers.ts`의 compute-on-read 계약 유지). numeric 하한은 `characterSchema`를 그대로 따른다.
  - `progress:trained`·`progress:studied`의 기존 필드는 그대로 둔다. 두 이벤트는 "무엇이 일어났는지"를 서술하는 도메인 이벤트이고, 이 이벤트는 현재 스탯 스냅샷이라 역할이 다르다.

`errorCodeSchema = z.enum(['handshake_required', 'unknown_type', 'bad_payload', 'internal', 'unauthorized', 'session_state', 'forbidden', 'rate_limited', 'rule_rejected'])`의 각 코드는 다음과 같다.

- `handshake_required`: 핸드셰이크 전에 명령을 받음
- `unknown_type`: 알 수 없는 discriminator
- `bad_payload`: payload 형식 위반
- `internal`: 핸들러나 처리 중 서버 내부 오류
- `unauthorized`: 소유하지 않은 캐릭터를 지목하는 등 **미인증** 세션의 인가 실패(T2)
- `session_state`: 현재 세션 단계에서 허용되지 않는 명령(T2)
- `forbidden`: **인증됐지만** RBAC 권한이 부족해 거부(E3-4)
- `rate_limited`: 인바운드 프레임이 연결·계정 속도 상한을 넘어 `JSON.parse` 전에 drop됨(#64). 연속으로 버려지는 구간에서 첫 폐기에만 1회 통지한다. 기준은 [`ws-rate-limit.md`](ws-rate-limit.md)다.
- `rule_rejected`: 형식, 권한, 단계는 옳지만 **게임 세계의 규칙**이 명령을 막음(잠긴 문, 소지하지 않은 비법서, study 게이트 탈락)

`unauthorized`(신원 없음, 재인증 유도)와 `forbidden`(신원은 있으나 자격 없음, 권한 없음 안내)은 클라이언트에 보이는 의미가 다르다. WS upgrade **전** 게이트의 거부(`401 unauthenticated`·`403 forbidden_origin`)는 프로토콜 error 이벤트가 아니라 HTTP 응답이므로 이 열거에 없다(auth-session.md 참조).

### 전송 연결 (`packages/server/src/ws/`)

`plugin.ts`가 연결의 중심이다. `GAME_SOCKET_PATH = '/game'`, `MAX_FRAME_BYTES = 64 * 1024`.

- **`connection.ts`** — 연결마다 하나씩 두는 컨텍스트. `ConnectionContext { protocolVersion: number(불변, 서버가 기준), ready: boolean(핸드셰이크 완료 여부), heartbeat: NodeJS.Timeout | null }`. `createConnectionContext()`가 `PROTOCOL_VERSION`·`ready=false`·`heartbeat=null`로 초기화한다. `cleanupConnection()`은 남은 ping 타이머를 `clearInterval`(멱등)로 정리하고 레지스트리에서 컨텍스트를 제거한다.
- **`frame.ts`** — 파싱된 프레임(`unknown`)에서 payload 스키마 검증 전에 필드를 안전하게 읽는 primitive.
  - `readField(parsed, key)`: 객체이고 null이 아니며 키가 있는지 확인한 뒤 값을 반환한다. 아니면 undefined를 반환한다.
  - `readStringField(parsed, key)`: 문자열일 때만 반환한다. 빈 문자열도 유효하다.
  - null 가드는 반드시 필요하다. 없으면 `key in null`이 message 핸들러 안에서 throw한다. `key`는 호출부의 리터럴이라 동적 키를 주입할 수 있는 지점이 아니다.
- **`heartbeat.ts`** — 연결별 하트비트 매니저. 아래 §동작을 참조한다.
- **`router.ts`** — `Map<type, handler>` 레지스트리와 `dispatch` 순수 함수. 아래 §동작을 참조한다. E3-4가 actor·permission threading과 chat 엔트리를 더했다([`freechat-permission-seam.md`](freechat-permission-seam.md)).
- **`handlers/echo.ts`** — 무인증 `echoHandler`. **`handlers/chat.ts`** — 자유채팅 `createChatHandler`(E3-4). 명령 디스패치 seam(`actorContext.ts`·`channelPort.ts`·`permissionPort.ts`와 no-op/permissive 어댑터)은 [`freechat-permission-seam.md`](freechat-permission-seam.md)를 기준으로 한다.

`FastifyInstance`에 `wsConnections: Map<WebSocket, ConnectionContext>`를 module augmentation으로 선언하고 `app.decorate`로 노출한다. 진단, 하트비트 스윕, 테스트 관찰이 모두 이것을 단일 출처로 쓴다.

## 동작

### 앱 연결 (`packages/server/src/app.ts`)

`buildApp(deps?)`는 `/health` REST 다음에 `registerWebsocket(app)`을 무조건 호출한다. `deps.https`(`node:https` `ServerOptions`)를 넘기면 Fastify가 https 서버를 만들어 `wss` 종단을 지원한다(TLS-ready pass-through). Fastify 타입 오버로드가 http 경로에서 https 키를 거부하므로 두 경우를 분기한다. dev는 평문 loopback을 쓰므로 기본은 미주입이다.

`registerWebsocket(app)`은 먼저 `@fastify/websocket`을 `{ options: { maxPayload: MAX_FRAME_BYTES } }`로 등록한다. 그다음 별도의 encapsulated 플러그인에서 `/game` 라우트를 `{ websocket: true }`로 마운트한다. 이렇게 하면 "라우트보다 먼저 플러그인 등록" 관례를 top-level await 없이 지킬 수 있다. `verifyClient`는 쓰지 않는다(transport-only). `MAX_FRAME_BYTES`는 프로토콜 레이어(`maxPayload`)에서 강제하므로, 버퍼가 다 차기 전에 초과 프레임을 1009 close로 거부한다. 핸들러 안에서 크기를 재면 이미 버퍼링된 뒤라 방어가 되지 않는다.

명령 레지스트리는 상태 없는 핸들러 연결표라 연결끼리 공유해도 안전하다. E3-4가 `ChannelPort`를 클로저로 주입하면서, 모듈 싱글턴이던 레지스트리를 `registerWebsocket` 스코프에서 `createCommandRegistry(channelPort)`로 1회 조립하도록 옮겼다. 레지스트리는 stateless Map이라 옮기는 비용은 없다(zero).

### 연결 수명주기

소켓을 accept하면 message 핸들러가 다음을 연결한다.

1. `createConnectionContext()`로 컨텍스트를 만들어 `wsConnections`에 등록한다.
2. `getConfig()`의 튜닝값으로 `createHeartbeat(socket, ...)`을 만들고, `start()`의 타이머 핸들을 `ctx.heartbeat`에 연결한다. `socket.on('pong')`은 `notePong()`으로 미스 카운터를 리셋한다.
3. `setImmediate`로 `system:hello{protocolVersion}`를 push한다. 동기적으로 push하면 injectWS 클라이언트가 message 리스너를 붙이기 전에 프레임이 나가 드롭되는 레이스가 생긴다. 그래서 리스너 부착(promise 기반이라 `process.nextTick`보다 늦음) 뒤로 미룬다. 버전은 연결별 기준 값인 `ctx.protocolVersion`을 단일 출처로 쓴다.
4. `socket.on('close')`가 `heartbeat.stop()`과 `cleanupConnection()`으로 타이머를 멈추고 정리한다.

서버에서 클라로 가는 전송은 모두 `safeSend(socket, event)`를 거친다. `readyState === OPEN`일 때만 전송하고, 프레임을 받은 뒤 응답하기 전에 피어가 닫아서 `send`가 throw하는 경우는 삼킨다(곧 `close`가 발생해 cleanup이 실행된다). 여기에 아웃바운드 backpressure 가드가 더해져 있다. payload를 미리 직렬화해 `bufferedAmount + payloadBytes > WS_MAX_BUFFERED_BYTES`이면 느린 소비자로 보고 `close(1013)`한다. send 콜백 오류는 로깅한 뒤 코드 없는 `close()`로 끊는다(기준 [`ws-resource-guard.md`](ws-resource-guard.md)). 서버가 종료될 때 소켓 닫기는 `@fastify/websocket` 기본 `preClose`가 맡는다.

### 메시지 처리 파이프라인

`socket.on('message')`는 프레임마다 다음 순서로 실행한다.

0. **인바운드 유량 게이트**(#64) — `JSON.parse`보다 **앞**에 둔다. `ctx.rateLimiter.check(performance.now())`가 연결 토큰 버킷과 계정 토큰 버킷을 AND로 판정한다. 결과가 `accept`가 아니면 파싱, dispatch, idle 재-arm을 모두 건너뛰고 바로 반환한다(기준 [`ws-rate-limit.md`](ws-rate-limit.md)). flood 방어의 핵심은 파싱 CPU 소진을 막는 것이다. 그래서 파싱 비용이 들기 전에 초과분을 버려야 방어가 된다.
1. **JSON 파싱** — `frameToText(RawData)`로 nodebuffer/Array/기타를 UTF-8로 정규화한 뒤 `JSON.parse`한다. 실패하면 `error{bad_payload}`로 응답하고 끝낸다(type 판별보다 먼저).
2. **핸드셰이크 게이트** — `handleHandshakeFrame(ctx, parsed)`가 반환한 `HandshakeResult`를 message 핸들러가 해석한다. 전체를 try/catch로 감싸, 어떤 throw든 `error{internal}`로 격리하고 소켓을 살려 둔다. fastify errorHandler가 message 핸들러의 예외를 잡지 못하므로 방어 범위를 넓힌 것이다.

`handleHandshakeFrame`은 부수효과 없는 순수 함수이며, 상태 전이표는 다음과 같다. malformed JSON은 이 함수에 오기 전에 걸러진다.

| 상태 | 입력 | 결과 action | 부수효과 |
|------|------|-------------|----------|
| pre-ready | `system:ready` + 버전 정확 일치 | `accept` | `ctx.ready = true` |
| pre-ready | `system:ready` + 버전 불일치(누락·문자열·소수 포함) | `reload` | `system:reload` push 후 다음 tick에 `socket.close()` |
| pre-ready | `system:ready` 아님 | `error` | `error{handshake_required}` push |
| ready | `system:ready`(중복) | `error` | `error{handshake_required}` push |
| ready | 그 외 | `pass` | 라우터로 디스패치 |

버전 대조는 **서버 값이 기준인 정확 비교**다(`readField(parsed, 'protocolVersion') === ctx.protocolVersion`, 강제 변환 없음). 핸드셰이크는 type과 버전만 게이트하고 `clientCommandSchema` strict 파싱은 하지 않는다. 그래서 여분 필드가 있어도 `ready`로 전이한다. 하지만 ready 이후의 모든 command는 라우터가 strict 검증하므로 우회 경로는 없다. `reload`는 프레임을 먼저 보내고 `setImmediate`로 close한다. 같은 tick에 close하면 프레임 플러시보다 close가 먼저 일어나 클라이언트가 reload를 받지 못하는 injectWS 특이 동작이 있어서다.

3. **`pass` 위임 분기** — 핸드셰이크를 통과한 프레임을 어디로 넘길지는 세션 상태에 따라 갈린다. `ctx.state === command`이면 라우터(`dispatch`)로, 그 이전 단계(`characterSelect`·`create`)이면 FSM `handleInput`으로 보낸다. 이미 파싱된 객체를 다시 파싱하지 않고 넘긴다.

**바인딩 신원 가드 (dispatch 직전)** — `ctx.state === command`만 확인해서는 부족하다.

- 서버가 주도하는 종료(같은 캐릭터 재로그인 evict, grace 만료, shutdown 정리)의 teardown은 transport만 정리한다(`cleanupConnection` + `socket.close`). 옛 `ctx`의 `state`·`boundCharacterId`는 되돌리지 않는다. `ctx.closed`도 소켓 `'close'` 이벤트(별개 리스너, 다음 tick)가 와야 `true`가 된다.
- 그 사이에 이미 버퍼된 프레임의 `'message'`가 발생할 수 있다. 그러면 밀려난 옛 소켓이 `command` 상태와 바인딩 키를 그대로 가진 채 dispatch에 도달한다.
- 라이브 레지스트리는 `characterId`를 키로 쓰므로, 그 명령은 **새 세션의** 엔트리를 변경한다(이동, gold 소비). 세션 신뢰 경계를 침범하는 것이다.

따라서 이 `ctx`가 여전히 해당 캐릭터의 **현재 live 바인딩**일 때만 명령을 실행한다.

```ts
const binding = registry.get(actor.characterId)
const isCurrentBinding =
  binding !== undefined && binding.connection === ctx && binding.link === 'live'
if (!isCurrentBinding || ctx.closed) break   // 조용히 무시, idle 재-arm 없음
```

응답은 보내지 않는다. 이 소켓은 이미 종결 중이라 `safeSend`가 OPEN 가드 때문에 no-op이 될 가능성이 크고, 밀려난 연결에 응답할 계약도 없다. **idle 재-arm도 하지 않는다.** 무효 명령이 새 세션의 무입력 창을 늘리지 못하게 하기 위해서다(rejected-nonrearm, rate-limit drop과 같은 원리). `binding.link === 'live'` 조건은 defense-in-depth다. `markLinkDead`는 `'close'` 핸들러에서만 실행되고, 그 핸들러가 `ctx.closed = true`를 먼저 세운다. 그래서 link-dead인 경우는 이미 `|| ctx.closed`가 막는다. 세션 바인딩 계약은 [`session-lifecycle.md`](session-lifecycle.md)를 기준으로 한다.

4. **idle 재-arm 정책** — `dispatch` 결과가 `handled`인 경우, 곧 **유효한 명령을 성공적으로 처리한 경우에만** 무입력 타이머를 재-arm한다. 거부(`unknown_type`·`bad_payload`·`forbidden`·`internal`)로는 재-arm하지 않으므로, flood로 타이머를 끝없이 늘릴 수 없다.

### 라우터·핸들러 레지스트리 (`router.ts`)

`dispatch(registry, parsed, actor, permission)`는 핸드셰이크를 통과(`pass`)한 프레임을 O(1)로 디스패치하는 순수 함수다. E3-4가 `actor: ActorContext`(3번째)와 `permission: PermissionPort`(4번째) 파라미터를 추가했다([`freechat-permission-seam.md`](freechat-permission-seam.md)). 서로 다른 error code를 보장하려면 아래 레이어 순서를 반드시 지켜야 한다.

1. `readStringField(parsed, 'type')`이 없으면 `error{unknown_type}`(상관 키 없음).
2. `registry.get(type)`이 실패하면 `error{unknown_type}`. 등록되지 않았거나 알 수 없는 type을 막는 **allowlist 가드**다. 레지스트리가 plain object가 아니라 실제 `Map`이라 `get('__proto__')`가 prototype 속성에 닿지 않고 undefined를 반환한다. 그래서 prototype-pollution 우회가 원천적으로 막힌다.
3. `clientCommandSchema.safeParse`가 실패하면 `error{bad_payload}`. 등록된 type이지만 payload가 잘못된 경우다. discriminator가 등록된 type인지 확인한 뒤 파싱하므로 정확히 그 variant를 검증한다(shared 계약이 단일 출처).
4. `permission.check(command, actor)`가 false이면 `error{forbidden}`(E3-4). 검증을 통과한 명령(`parseResult.data`)만 권한 판정에 넘긴다. 순서는 payload 검증 다음, 핸들러 이전이다. E3 permissive 어댑터는 항상 allow하므로 지금 이 레이어는 inert다(회귀 없음).
5. `permission.check`나 `handler(command, actor)`가 throw하면 `error{internal}`. 권한 판정과 핸들러의 예외를 같은 try/catch 격리 경계에서 잡아 소켓을 살려 둔다. `check`가 false를 반환하면 `forbidden`, throw하면 `internal`로 구분한다. throw하는 실제 어댑터(E5)의 예외가 dispatch 밖으로 빠져나가 correlationId를 잃지 않게 하려는 격리다.

상관 키 `id`는 type 판별 직후, payload 검증 전에 `readStringField`로 꺼낸다(빈 문자열도 유효하므로 `typeof`로 판별). 그래서 `bad_payload`·`forbidden`·`internal` 응답에도 상관 키를 실어, 클라이언트가 어느 요청이 실패했는지 짝지을 수 있다. `unknown_type`은 type 판별 이전 단계라 상관 키를 싣지 않는다. `errorEvent()`는 `correlationId`가 있을 때만 키를 넣는다(undefined 키 금지).

`createCommandRegistry(channelPort, deps?)`는 무인증 `debug:echo`와 자유채팅 `chat:message`·`chat:emote`(→ `createChatHandler(channelPort)` 클로저)를 무조건 연결한다. E3-4부터 `channelPort`는 필수 파라미터다. 레지스트리 팩토리가 어댑터를 소유하지 않고, `registerWebsocket`이 default를 주입한다. 또 모듈 싱글턴이던 레지스트리를 `registerWebsocket` 스코프로 옮겼다. 레지스트리는 의도적으로 `clientCommandSchema`보다 좁은 런타임 디스패치 집합이다. `system:ready`는 스키마에 있지만 핸드셰이크가 `pass` 전에 소비하므로 등록하지 않는다. 새 핸들러를 넣으면 반드시 `clientCommandSchema`에도 variant를 추가해야 한다. 스키마에 없는 type의 핸들러는 `safeParse`가 매칭하지 못해 언제나 `bad_payload`로 떨어진다.

**조건부 등록 deps 번들 (`GameCommandDeps`)** — 라이브 상태 seam이 필요한 게임 명령은 deps가 주입될 때만 등록된다. 명령 하나당 필드 하나를 갖는 번들 객체로 받는다.

```ts
export interface GameCommandDeps {
  readonly move?: MoveHandlerDeps
  readonly train?: TrainHandlerDeps
  readonly study?: StudyHandlerDeps
  readonly attack?: AttackHandlerDeps
}
createCommandRegistry(channelPort: ChannelPort, deps?: GameCommandDeps): HandlerRegistry
```

**핸들러 반환 계약 (#121에서 다중 이벤트로 확장)** — 한 명령이 여러 이벤트를 보내야 하는 경우가 생겨 계약을 넓혔다. `combat:attack`은 `combat:attacked`와 `character:stats`를 보내고, 사망 시에는 `world:room`까지 3종을 보낸다.

```ts
type CommandHandler = (command, actor) => ServerEvent | readonly ServerEvent[] | undefined
type DispatchResult = { outcome: 'handled'; events: readonly ServerEvent[] }
                    | { outcome: 'rejected'; events: readonly [ServerEvent] }
```

성공과 거부 두 경로 모두 `events` 배열로 통일한다. 모양이 다르면 소비하는 곳에서 분기해야 하기 때문이다. `rejected`는 **길이-1 튜플**로 좁혀, "거부에는 error가 정확히 하나"라는 규칙을 타입으로 강제한다. 세 반환 형태(`undefined`·단일·배열)를 배열로 바꾸는 `normalizeHandlerEvents`를 export해, 테스트 하네스가 같은 정규화를 다시 구현하지 않게 한다. 소비하는 곳은 `ws/plugin.ts` 한 곳뿐이라 변경 범위가 거기서 끝난다(`result.events`를 순회해 `safeSend`).

명령이 늘 때마다 팩토리에 optional **위치 파라미터**를 덧붙이면, 호출부가 인자 순서에 묶인다. 중간 명령만 빼려면 `undefined`로 자리를 채워야 한다. 필드 번들은 이 결합을 끊는다.

- 호출부는 연결할 명령의 필드만 채운다. 필드가 없으면 그 명령은 등록되지 않고, dispatch가 `unknown_type`을 반환한다. 방 배치나 영속 seam이 아직 없는 컨텍스트에서는 이것이 기본 동작이다.
- 모든 필드가 optional이라 번들 자체도 optional이다. deps 없이 부르는 호출부(라우터 순수 단위 테스트 등)는 1-인자 형태 그대로 쓴다.
- 현재 받는 필드는 넷이다: `deps.move`(→ `world:move`), `deps.train`(→ `progress:train`), `deps.study`(→ `progress:study`), `deps.attack`(→ `combat:attack`). 후속 규칙 명령(teach·cast)도 같은 형태로 필드를 더한다.

`echoHandler(command, _actor)`는 `debug:echo{text, id?}`를 `debug:echo:result{text, correlationId?}`로 되돌려 준다. `actor`를 받지만 쓰지 않는, 권한 검사 없는 진단 핸들러다. 라우터가 이미 검증한 `ClientCommand`만 받으므로 payload를 다시 검증하지 않는다. `id`가 있을 때만(`!== undefined`, 빈 문자열도 유효) `correlationId` 키를 싣는다.

### 하트비트 (`heartbeat.ts`)

서버 주도 canonical 패턴(`ws` `isAlive`/`ping`/`terminate`)의 **단일 인터벌(isAlive) 모델**이다. `createHeartbeat(socket, opts)`는 상태(미스 카운트, `awaitingPong`, 타이머 핸들)를 클로저 안에 감추고 `{ start, stop, notePong }`을 반환한다.

- `start()` — `missedPongs=0`·`awaitingPong=false`로 초기화하고, `pingIntervalMs`마다 `tick`을 실행하는 인터벌 타이머 핸들을 반환한다.
- `tick()` — `awaitingPong`이면(직전 ping의 pong을 받지 못함) `missedPongs += 1`하고, `maxMissed`에 도달하면 `socket.terminate()`와 `stop()`을 실행한다. 그다음 `awaitingPong=true`로 세우고 `socket.ping()`한다.
- `notePong()` — `missedPongs=0`·`awaitingPong=false`로 리셋한다(연결이 살아 있다는 신호).
- `stop()` — 타이머를 clear한다(멱등).

타이머는 `clock?: SchedulerClock` 단일 seam으로 주입할 수 있다(`util/clock.ts` 공유 계약, saveScheduler·WorldClock과 같은 관용구). 그래서 fake clock으로 결정적인 단위 테스트를 할 수 있고, 주입하지 않으면 `defaultClock`(전역 타이머)을 쓴다. 첫 인터벌은 미스를 세지 않고 ping만 보내므로, 종료까지 걸리는 시간은 ≈ `pingIntervalMs × (maxMissed + 1)`이다(기본값 25s·3 → ≈ 100s).

### Env config (`packages/server/src/config/env.ts`)

`EnvSchema`에 하트비트 튜닝 필드 3개를 추가한다(모두 `z.coerce.number().int().min(1)`).

- `WS_HEARTBEAT_PING_INTERVAL_MS`(기본 25000) — ping 간격이자 실질적인 pong별 마감 시간.
- `WS_HEARTBEAT_MAX_MISSED`(기본 3) — 연속으로 몇 번 놓치면 종료할지 정하는 임계값.
- `WS_HEARTBEAT_PONG_TIMEOUT_MS`(기본 10000) — **예약 seam**. 현재 단일 인터벌 모델은 이 값을 쓰지 않는다. 실질 마감은 이 값이 아니라 `PING_INTERVAL`이다. 나중에 이중 타이머 모델을 도입하면 쓴다. 운영자가 오해하지 않도록 지금은 효과가 없다는 점을 스키마 주석에 밝혀 둔다.

`plugin.ts`는 연결마다 `getConfig()`를 읽어 `createHeartbeat`에 `pingIntervalMs`·`maxMissed`를 넘긴다.

E3 하드닝(#54)은 자원 한도 필드 3개(`WS_MAX_CONNECTIONS`·`WS_MAX_CONNECTIONS_PER_ACCOUNT`·`WS_MAX_BUFFERED_BYTES`)를 같은 `EnvSchema`에 더했다. 연결 정원과 아웃바운드 backpressure 튜닝값이며, 기준은 [`ws-resource-guard.md`](ws-resource-guard.md)다. E3 하드닝 후속(#64)은 인바운드 유량 상한 필드 5개를 더했다.

- `WS_MSG_RATE_CAPACITY`
- `WS_MSG_RATE_REFILL_PER_SEC`
- `WS_MSG_RATE_ACCOUNT_CAPACITY`
- `WS_MSG_RATE_ACCOUNT_REFILL_PER_SEC`
- `WS_MSG_RATE_MAX_VIOLATIONS`

연결·계정 토큰 버킷 튜닝값이며, 기준은 [`ws-rate-limit.md`](ws-rate-limit.md)다.

### 테스트 전략 (`packages/server/src/ws/`)

이 스택에는 **실서버(포트 0)+실 `ws` 클라이언트+Vitest** 조합이 가장 알맞다(리서치 `ws-e2e-cli-tools-20260706.md`에서 확정). `wsTestClient.testutil.ts`는 injectWS 클라이언트(단위)와 실 `ws` 클라이언트(E2E)를 함께 관찰하는 헬퍼를 제공한다.

- `waitForMessage(ws)`/`waitForClose(ws)`/`waitForOpen(ws)` — 최소 emitter 계약(`{ once(event, cb) }`)에만 의존하므로 injectWS와 실 `ws` 클라이언트가 똑같이 충족한다. `waitForMessage`는 `serverEventSchema.parse`로 검증·파싱하고, 계약 밖 이벤트는 깔끔하게 reject한다. `send` 전에 리스너를 먼저 걸어 `system:hello` 드롭 레이스를 없앤다.
- `waitFor(predicate)` — 서버측 상태 전이(연결 레지스트리 크기 등)를 경합 없이 폴링한다.
- `startTestServer(app)` — 포트 0과 `127.0.0.1`로 리슨시키고 `ws://` URL을 반환한다. IPv4 loopback을 명시하는 이유는 `localhost`가 ::1로 resolve되어 생기는 간헐적인 ECONNREFUSED를 피하기 위해서다.
- `newClient(url, opts)` — open을 기다리지 않고 동기적으로 반환해, 리스너를 먼저 걸 수 있게 한다. `autoPong: false`로 프로토콜 레벨의 자동 pong을 끄면, 하트비트 miss로 인한 terminate를 실제 소켓으로 일으킬 수 있다.

각 패키지에 vitest 커버리지 80%+ 게이트를 둔다(연결 엔트리 제외, 앱 팩토리는 injectWS 스모크).

## 제약사항

- **인증·세션은 T2에서 구현됨** — E3-1 handshake 자체는 transport-only다. 세션 쿠키 검증, Origin 체크, `SessionAuthPort`, `preValidation` 훅, 세션 FSM(`characterSelect→create→command`), prompt/response 다단 대화는 T2([`auth-session.md`](auth-session.md))가 이 계층에 더했다. 평문→해시 비밀번호 교체는 Firebase Auth에 위임해(발급은 E5) 해소했다. checkdouble 동시접속 방어는 T3 세션 레지스트리 경계다.
- **재연결은 T3** — 세션 레지스트리와 상태 복원(onReconnect)은 이 토픽에 없다.
- **실 게임 명령 핸들러는 후속 토픽** — 이 계층은 5 인자 패턴 스키마와 무인증 `debug:echo` 하나만 연결한다. 실제 124 게임 명령(이동, 전투, 마법, 아이템, 소셜, DM) 핸들러와 명령→구조화 이벤트 매핑은 후속 명령 구현 토픽에서 한다. 어떤 실게임 command가 "직접 응답 있음(질의형)"이라 correlationId를 돌려줘야 하는지도 그때 정한다.
- **다단 대화 payload 없음** — `payloads.ts`는 4패턴(무인자/대상+서수/대상+보조대상/자유텍스트)만 정의한다. 5번째인 prompt/response 다단 payload는 T2 경계다.
- **`debug:echo`는 무권한 노출** — 진단과 파이프라인 검증 전용이다. 프로덕션 빌드에서 제거할지, 플래그로 게이트할지는 후속 하드닝에서 다시 검토한다.
- **`WS_HEARTBEAT_PONG_TIMEOUT_MS`는 미소비 예약 seam** — 현재 단일 인터벌 모델에서 pong별 실질 마감은 `PING_INTERVAL`이다. 이 필드를 낮춰도 종료 타이밍은 바뀌지 않는다.
- **TLS는 TLS-ready pass-through만** — `buildApp`이 `https` 서버 옵션을 Fastify로 그대로 넘겨 `wss`를 지원한다. dev는 평문 loopback `ws`를 쓴다. 프로덕션 TLS 종단 지점(Fastify https vs 리버스 프록시)과 하트비트 인터벌 확정값(프록시 idle timeout 75% 규칙)은 배포/인프라 토픽에서 다시 조정한다.
- **`protocolVersion` bump 정책 미확정** — 형식은 단조 증가 정수로 확정했다(현재 `6`). 지금까지의 변경 이력은 다음과 같다.
  - 1→2: 라이브 월드 foundation의 `world:move`·`world:room`·`chat:said` 신설
  - 2→3: `progress:train` 명령·`progress:trained` 이벤트 신설
  - 3→4: E11 `world:room` 페이로드 확장
  - 4→5: #120 `progress:study` 명령·`progress:studied` 이벤트 신설
  - 5→6: #121 `combat:attack` 명령과 `combat:attacked`·`character:stats` 이벤트 신설

  *언제* 올리는가(호환 불가 변경의 기준과 문서화)는 프로토콜이 커질 때 따로 정한다. 지금까지의 실제 관행은 "`strictObject` variant에 required 필드가 늘거나 variant가 신설되면 올린다"이다.
- **한글 자유 텍스트 파서 없음** — E3-4가 자유채팅 입력을 `ChannelPort`로 넘기는 seam을 더했다([`freechat-permission-seam.md`](freechat-permission-seam.md)). 라이브 월드 foundation이 실제 방 채널 어댑터를 연결해, 같은 방 안 전파는 동작한다([`live-world-foundation.md`](live-world-foundation.md)). 나머지는 다른 토픽이 맡는다.
  - 전서버 방송, 외쳐 1홉 인접 전파, 구독 필터: 소셜 에픽(#37)
  - 동사-후치 자유 텍스트 파서: 자유 모드 UI 토픽(구조화 명령은 클라가 이미 분리해 보냄)
  - 조사 i18n 렌더, 클라이언트 UI: 프론트엔드 토픽
