# 자유채팅·권한 seam (E3-4)

> 명령 디스패치 경로에 actor-context를 threading하고, 자유 텍스트 채팅을 `ChannelPort`로, 권한 판정을 `PermissionPort`로 핸드오프하는 seam+skeleton의 정본. 실 전파·자원 소비·RBAC는 no-op/permissive 어댑터 뒤 E4/E5/E7 어댑터 교체로 붙는다.

## 개요

E3-3([`session-lifecycle.md`](session-lifecycle.md))의 남은 절반이다. 명령 디스패치 경로에 세 seam을 얹는다: (1) 두 목표의 공통 토대인 **actor-context threading**, (2) 자유 텍스트 채팅 입력의 **`ChannelPort` 핸드오프**, (3) 명령 실행 자격을 게이트하는 **`PermissionPort` 훅**. 세 seam 모두 E3-3의 `SessionLifecyclePort` 선례(도메인 어휘 인터페이스 + no-op 어댑터, 실 동작은 후속 에픽 어댑터 교체)를 미러하며 **live-state 의존이 zero**다.

프로토콜 계약(chat variant·`forbidden` ErrorCode)과 dispatch 메커니즘 자체는 [`transport-protocol.md`](transport-protocol.md)가 정본으로 소유한다 — 이 문서는 그 위에 얹는 seam 서브시스템(actor/channel/permission 도메인 타입·어댑터·핸들러)을 다룬다.

**seam+skeleton 원칙**: 채널 전파·자원 소비·역할 판정은 포트 뒤로 미루고, E3 스켈레톤 어댑터는 permissive/no-op이다. 게이트 메타(레벨 자격·자원 비용)는 **선언만 하고 강제하지 않는다** — 선언≠강제. 강제 코드가 E3에 유입되면 seam 경계 위반이다.

## 구조 / 스키마

### ActorContext (`packages/server/src/ws/actorContext.ts`)

명령 핸들러·권한 훅이 소비하는 행위자 컨텍스트. **server 도메인 타입**이며 shared 프로토콜에 노출하지 않는다(actor는 소켓 경계 안쪽 개념이지 클라이언트 계약이 아니다 — `sessionAuthPort` 관례 미러).

```ts
interface ActorContext {
  readonly accountId: string
  readonly characterId: string
  readonly class?: number
  readonly level?: number
  readonly flags?: readonly string[]
}
```

`accountId`·`characterId`는 command 상태에서 항상 확정된 신원이라 필수다. `class`·`level`·`flags`는 권한·게임 규칙 판정이 참조할 캐릭터 상태이나, E3엔 실 캐릭터 상태 조회원이 없어 optional로 두고 E4가 채운다. 전 필드 `readonly`로 둬 E4가 mutation이 아니라 construction-time 대입으로 채우게 강제한다(immutability 규칙 일관).

`buildActorContext(ctx: ConnectionContext): ActorContext` — dispatch 호출부가 command 상태 진입 시 쓴다. `ctx.account === null` 또는 `ctx.boundCharacterId === null`이면 throw한다. 이 둘은 command 상태에서 둘 다 non-null이 배선 불변식이다(characterSelect 핸들러가 `enterWorld`→register/rebind로 `boundCharacterId`를 대입한 **뒤** FSM이 state=command로 전이하므로, 단일 스레드 동기 경로에서 command 상태에서 이 둘이 null이면 배선 오류다). 따라서 throw는 **순수 방어선**이며 런타임 정상 경로에선 도달하지 않는다(`buildSession`의 세션 불변식 위반 선례 미러). 이 throw는 `plugin.ts`의 message 핸들러 방어 try/catch가 `error{internal}`로 격리한다 — 추가 배선 없이 기존 방어선을 재사용한다(원인은 클라이언트 비노출, 서버 로깅만).

### ChannelPort (`packages/server/src/ws/channelPort.ts`)

자유 텍스트 채팅의 도메인 핸드오프 seam(DIP).

```ts
interface ChannelDeliveryContext {
  readonly speaker: ActorContext
  readonly channel: 'say' | 'yell' | 'broadcast' | 'emote'
  readonly text: string
  readonly target?: string
}
interface ChannelPort {
  deliver(ctx: ChannelDeliveryContext): void   // 동기 시작(no-op stub). E4/E7가 async 확장 + 호출부 조정.
}
```

동기 시그니처는 `sessionLifecyclePort`·`sessionAuthPort` seam 관례 미러다 — no-op stub이라 Promise를 반환하지 않고, E4/E7 실 브로드캐스트 어댑터는 DB·fan-out I/O로 async가 필요하므로 그 시점에 `Promise<void>` 반환으로 확장한다.

**선언적 채널 메타데이터 테이블** `CHANNEL_METADATA` — channel → `{ audience, cost, gate }`. E3는 어느 항목도 강제하지 않는다(선언만). `audience`·`cost`(HP·일일한도 = 자원 비용·전파)는 ChannelPort 소유(강제 E4/E7), `gate`(레벨/클래스 실행 자격)는 PermissionPort 개념 영역(강제 E5). `broadcast.gate.minLevel=20`은 spec §3.4의 "잡담 레벨20↑"를 선언으로 고정한 값이며, 핸들러는 이 테이블을 **참조하지 않고** 무조건 deliver한다(미강제).

`createNoopChannelAdapter(logger): ChannelPort` — mock이 아닌 실 어댑터로, 전달 사실(speaker의 characterId·channel·target)만 구조 로깅하고 반환한다(저장·fan-out 없음). 생성자 로거 소유(전역 싱글턴 조회 금지), `noopSessionLifecycleAdapter` 관례 미러. characterId 등은 PII가 아닌 도메인 식별자라 마스킹 없이 로깅한다.

### PermissionPort (`packages/server/src/ws/permissionPort.ts`)

명령 실행 자격 판정 seam.

```ts
interface PermissionPort {
  check(command: ClientCommand, actor: ActorContext): boolean   // true=allow, 동기 시작
}
```

`sessionAuthPort`·`sessionLifecyclePort`·`channelPort` seam 관례(생성자 소유·서비스 로케이터 금지, 동기 시작·async 유예 주석) 미러. `createPermissivePermissionAdapter(): PermissionPort` — `check`가 항상 true를 반환하는 무상태·무의존 실 어댑터. 실 RBAC(클래스·레벨·방 플래그)는 E5가 이 포트를 구현해 교체한다.

### 채팅 핸들러 (`packages/server/src/ws/handlers/chat.ts`)

`createChatHandler(channelPort: ChannelPort): CommandHandler` — `ChannelPort`를 클로저로 받아 `(command, actor)` 핸들러를 반환한다. command.type을 narrow해 결정된 매핑으로 `channelPort.deliver(...)`를 호출하고 `undefined`를 반환한다(fire-and-forget). 게이트 메타를 참조하지 않고 무조건 deliver한다(미강제).

| command | ChannelDeliveryContext 매핑 |
|---|---|
| `chat:message{channel, text}` | `{ speaker: actor, channel: command.channel, text: command.text }` |
| `chat:emote{emote, target?, text?}` | `{ speaker: actor, channel: 'emote', text: command.emote, target?: command.target }` |

`chat:emote`는 별칭(`emote`)이 주 콘텐츠라 `text: command.emote`로 매핑한다. optional 부가 `command.text`는 E3에서 드롭하고 E7 별칭 해소로 유예한다. `command.target`이 undefined면 `ChannelDeliveryContext`에 `target` 키를 싣지 않는다(undefined 키 금지 관례).

## 동작

### dispatch threading (`packages/server/src/ws/router.ts`)

`CommandHandler`·`dispatch`가 actor·permission을 threading한다(전체 시그니처·레이어 순서는 [`transport-protocol.md`](transport-protocol.md) §라우터 참조).

```ts
type CommandHandler = (command: ClientCommand, actor: ActorContext) => ServerEvent | undefined
function dispatch(registry, parsed, actor: ActorContext, permission: PermissionPort): DispatchResult
```

`dispatch`는 actor를 **해석하지 않고** 핸들러에 그대로 전달한다. 권한 판정만 dispatch 레이어 책임이며, 게임 규칙 판정(자원 소모·상태 전이)은 핸들러 책임이다. `createCommandRegistry(channelPort)`가 chat:message·chat:emote 엔트리를 `createChatHandler(channelPort)` 클로저로 등록하고 debug:echo 엔트리를 유지한다. `echoHandler(command, _actor)`는 actor를 받되 무시한다(무권한 진단 핸들러).

### 권한 레이어 격리 경계

`permission.check`와 handler는 **같은 try/catch 격리 경계**에서 실행한다 — dispatch의 containment 계약(라우팅 레이어 거부는 항상 `DispatchResult`로 반환, 예외 누출 없음)을 permission에도 확장한다. E3 permissive 어댑터는 throw하지 않지만, E5 실 RBAC 어댑터는 저장소 타임아웃·stale actor 등으로 throw할 수 있다 — 그 예외가 dispatch를 탈출하면 correlationId를 잃고 셸의 일반 catch로 떨어지므로, 여기서 `internal`로 격리해 상관 키를 실어 반환한다. `check`가 정상적으로 false를 반환하면 `forbidden`(자격 없음), throw하면 `internal`(판정 실패)로 구분한다.

### plugin.ts 배선 (`packages/server/src/ws/plugin.ts`)

`registerWebsocket`이 default 파라미터로 두 포트를 기본 주입한다(`sessionAuth`·`lifecyclePort` 관례 미러).

```ts
registerWebsocket(
  app, sessionAuth,
  lifecyclePort = createNoopSessionLifecycleAdapter(app.log),
  channelPort   = createNoopChannelAdapter(app.log),
  permissionPort = createPermissivePermissionAdapter(),
)
```

모듈 레벨 싱글턴이던 `commandRegistry`를 `registerWebsocket` 스코프로 이동해 `createCommandRegistry(channelPort)`로 조립한다(레지스트리는 stateless Map이라 이동 비용 zero). command 상태 프레임의 dispatch 호출부는 `dispatch(commandRegistry, parsed, buildActorContext(ctx), permissionPort)`다. `buildActorContext`의 배선 불변식 throw는 이 호출을 감싸는 기존 message 핸들러 방어 try/catch가 `error{internal}`로 격리한다.

## 제약사항

- **게이트·비용 실 enforcement 없음** — 잡담 HP 차감, 레벨 20 체크, 일일 방송 한도 카운터. 캐릭터 상태(E4)·카운터 영속(E4/E5) 의존. E3는 `CHANNEL_METADATA` 선언 메타만.
- **실 채널 브로드캐스트·전파 없음** — 방=채널 delivery, 외쳐 1홉 인접 전파, 전서버 방송, 구독 필터. → **E4(#34)/E7(#37)**. `ChannelPort`는 no-op 로깅만.
- **실 RBAC 역할·정책 없음** — 클래스 0~12 실 판정, `*` 관리 명령 게이트, 직업 한정 스킬. → **E5(#35)**. `PermissionPort`는 항상 allow.
- **live 캐릭터 상태 조회 없음** — actor의 `class`·`level`·`flags` 실 값. E3엔 미채움(optional). → **E4(#34)**.
- **자유 텍스트 필드 값 검증 유예** — `chat:emote`의 40개 별칭 allowlist 값 검증은 E7(채널 어댑터). 프로토콜은 non-empty + 길이 상한만 강제. 채널 전파 대상 필드(`text`·`emote`·`target`)에 프로토콜 계층 길이 상한(DoS floor)을 두되, 값은 E4/E7가 채널별로 더 좁힐 수 있다.
- **broadcast fail-open 교차-에픽 시퀀싱 제약** (load-bearing) — E3 기본 주입은 noop 채널 + permissive 권한 둘 다 no-op이라 안전하다. 그러나 E4/E7가 실 broadcast fan-out 어댑터를 `ChannelPort`에 붙일 때 E5 실 `PermissionPort`가 아직 permissive면 임의 인증 actor가 전역 broadcast 가능(fail-open)이다. E4/E7는 반드시 (a) E5 실 PermissionPort를 함께 주입하거나 (b) 그 시점에 기본을 fail-closed로 전환해야 한다.
- **나머지 소셜 자유텍스트 명령** — 그룹말·패거리말·표현(자유 이모트 `:이름이 <문장>`)·귓속말·환호. 같은 seam으로 후속 토픽. (감정표현(action)은 이번 `chat:emote`로 포함 — 이름 유사한 별개 명령.)
