# 연결 수명주기 (세션 레지스트리·재연결·수렴 seam)

> E3-2 세션 FSM 위에 연결 수명주기를 얹는다 — characterId 색인 세션 레지스트리(1캐릭터 1세션), link-dead grace 재연결, idle timeout, 그리고 이 셋과 중복 로그인 evict가 모두 수렴하는 단일 disconnect 수렴 seam.

## 개요

E3-1([`transport-protocol.md`](./transport-protocol.md))은 transport-only WS(핸드셰이크·라우터·하트비트)를, E3-2([`auth-session.md`](./auth-session.md))는 인증 게이트 + 3층 세션 FSM(`characterSelect → create → command`)을 확립한다. 두 계층은 **단일 소켓의 수명**만 다룬다 — 소켓이 끊기면 곧 끝이고, 같은 캐릭터의 이전/다음 연결을 잇는 개념이 없다.

이 계층은 **연결과 캐릭터의 관계**를 도입한다:

- **세션 레지스트리** — `characterId → SessionBinding` 인메모리 색인. 1캐릭터 1세션을 강제하고, 재연결이 참조할 캐릭터→세션 바인딩을 색인한다(원작 무한 A12 §2.2 "같은 이름 기존 fd disconnect"의 형상 재현).
- **link-dead grace 재연결** — `command` 소켓 단절 시 세션 엔트리를 grace 동안 보존했다가 새 소켓으로 rebind한다(재로드 없이). telnet 원작에 없는 형상 신규 설계로, 순간적 네트워크 단절 복원력을 웹 클라이언트 기대에 맞춰 추가한다.
- **disconnect 수렴 seam** — grace 만료·idle timeout·중복 로그인 evict가 모두 단일 종결 함수 `resolveDisconnect`를 거쳐 **lifecycle 포트**를 정확히 한 번 호출한다(A12 §1.4 "disconnect가 save 수렴점" 의미 보존).
- **idle timeout** — `command` 상태 무활동 종료 창(A12 §1.6, 최후의 세이브 안전망).

이 계층 자체는 **seam·skeleton**이다 — 수렴 *의미*를 `SessionLifecyclePort` DIP seam으로 보존하고 어떤 상태를 저장할지는 어댑터에 위임한다. 라이브 캐릭터 상태원이 세워진 뒤([`live-world-foundation.md`](live-world-foundation.md)) 프로덕션 부트가 실 어댑터를 주입해 종료 시 마지막 방이 실제로 영속화되며, 라이브 의존이 미주입된 구성에서는 no-op(로깅) 어댑터가 그대로 기본이다.

## 구조 / 스키마

### 두 색인의 직교

| 색인 | 위치 | 키 → 값 | 성격 |
|------|------|---------|------|
| `wsConnections` | `plugin.ts` | `WebSocket → ConnectionContext` | 소켓→컨텍스트 (transport) |
| `SessionRegistry` | `sessionRegistry.ts` | `characterId → SessionBinding` | 캐릭터→세션 (도메인 수명) |

레지스트리는 소켓을 직접 참조하지 않고 `ConnectionContext`를 가리켜, 재연결 시 참조만 교체한다.

### `SessionBinding` (불변 객체)

모든 상태 변경(live→link-dead, rebind)은 필드 변이가 아니라 **새 객체 교체**로 일어난다. 유일한 예외는 `markLinkDead`가 새 link-dead 객체를 map에 publish하기 전 `graceTimer` 슬롯을 한 번 채우는 구성 단계다(아무도 관찰하지 않는 unshared 객체라 공유 변이가 아니다). 이 때문에 `graceTimer`만 `readonly`가 아니다.

| 필드 | 의미 |
|------|------|
| `characterId` | 색인 키 |
| `accountId` | 소유 계정(evict/resume 시 신원 대조) |
| `connection` | 바인딩된 `ConnectionContext` 참조(link-dead 시 유지, rebind 시 새 객체가 새 ctx를 가리킴) |
| `link` | `LinkState = 'live' \| 'link-dead'` |
| `graceTimer` | link-dead 진입 시 건 grace 타이머 핸들(live면 null) |

`DisconnectReason = 'evictedByNewLogin' | 'graceExpired' | 'idleTimeout' | 'shutdown'` — 종결 사유의 단일 출처(`sessionRegistry.ts`). `SessionLifecyclePort`·`resolveDisconnect`가 이를 import한다. `'shutdown'`은 서버 주도 종료 시 전체 live 바인딩을 일괄 수렴할 때 쓴다([`runtime-foundation.md`](./runtime-foundation.md) shutdown 수렴).

### `ConnectionContext` 확장 (E3-2 슬롯에 2개 추가)

- `boundCharacterId: string | null` — `command` 진입 시 대입(등록 seam). close 핸들러가 이 값으로 바인딩을 역참조한다.
- `idle: IdleTimer | null` — idle 타이머의 단일 소유 슬롯. heartbeat·deadline과 나란한 별도 슬롯.

### `SessionRegistry` 인터페이스 (순수 자료구조 + 조작 함수)

```
register(characterId, accountId, ctx, terminate): SessionBinding
markLinkDead(binding, scheduleGrace): SessionBinding | null
rebind(binding, newCtx): SessionBinding | null
get(characterId): SessionBinding | undefined
listBindings(): readonly SessionBinding[]   // 등록 바인딩 스냅샷(shutdown 일괄 수렴 소스)
```

`listBindings`는 라이브 뷰가 아닌 **복사 스냅샷**을 반환한다 — 순회 중 `resolveDisconnect`가 레지스트리에서 엔트리를 제거해도 안전하도록. live·link-dead를 필터하지 않고 전부 반환한다(link-dead도 armed grace 타이머 + 미저장 세션을 쥐고 있어 shutdown 수렴 대상이므로). 서버 주도 종료 일괄 수렴([`runtime-foundation.md`](./runtime-foundation.md))의 바인딩 소스다.

`createSessionRegistry(opts)` 팩토리로 만들고, 타이머·포트 호출·소켓 close 같은 부수효과는 셸(plugin)이 주입 콜백으로 넣는다(functional-core/imperative-shell 경계). `clearTimeoutFn`은 주입 가능하며 미주입 시 전역 `clearTimeout`을 쓴다(fake clock 단위 테스트).

### `SessionLifecyclePort` (DIP seam)

```
interface SessionEndContext {
  readonly accountId: string
  readonly characterId: string
  readonly reason: DisconnectReason
}
interface SessionLifecyclePort {
  onSessionEnd(ctx: SessionEndContext): void
}
```

| 항목 | 결정 |
|------|------|
| 입력 | 최소 3필드(accountId·characterId·reason). world snapshot 핸들 미노출 |
| 동기/비동기 | 동기 `void` — 어댑터는 인메모리 변이·`markDirty`(동기 side registry 기록)만 하고 실 DB write는 저장 스케줄러의 비동기 flush가 소유한다 |
| 실패 정책 | 포트 throw는 `resolveDisconnect`가 catch·로깅·**삼킴** — teardown은 저장 실패와 무관하게 진행 |
| 순서 | 레지스트리 제거(선) → 포트 호출 → transport 정리·소켓 close |

기본 어댑터는 `createNoopSessionLifecycleAdapter(logger)` — 종결 사실만 구조 로깅하고 즉시 반환한다. 프로덕션 부트는 라이브 월드 의존 묶음이 주입될 때 실 어댑터(`liveSessionLifecycleAdapter.ts`)를 파생해 이 자리를 대체한다: 종료 시점 방을 `markDirty`한 뒤(dirty-before-release) 라이브 엔트리·방 점유를 해제한다. 정본 [`live-world-foundation.md`](live-world-foundation.md).

## 동작

### disconnect 수렴 seam + 멱등 계약

`resolveDisconnect`는 **등록된(command) 바인딩의 도메인 종결에만** 관여한다. `createResolveDisconnect(deps)` 팩토리가 `TerminateCallback`을 반환하며, 절차는:

```
resolveDisconnect(binding, reason):
  1. identity 가드: registry.get(binding.characterId) !== binding 이면 return    # stale → no-op
  2. registry.delete(binding.characterId)                                        # 선-제거로 재진입 차단
  3. clear(binding.graceTimer); clear(binding.connection.idle)                   # idempotent
  4. try { port.onSessionEnd({ accountId, characterId, reason }) }
     catch (e) { logPortFailure(e) }                                             # 포트 실패가 teardown을 막지 못함
  5. teardown(binding)                                                           # transport 정리(cleanupConnection) + socket.close()
```

**정확히 한 번**: 세 종결 트리거(grace 콜백·idle 콜백·close 리스너)가 서로 다른 태스크로 큐잉돼도, identity 가드(1)와 선-제거(2)가 두 번째 이후 진입을 no-op으로 만든다.

### ABA-safe 종결 가드 (객체 identity)

stale 판별의 불변식은 **객체 identity** `registry.get(characterId) === binding`이다. generation 카운터는 쓰지 않는다 — fresh 등록마다 0으로 재시작하면 같은 characterId의 새 바인딩이 옛 세대값을 재사용해 ABA가 생긴다. 대신 grace/idle 타이머·close 리스너는 **자신을 스케줄한 시점의 바인딩 객체 참조를 캡처**하고, 발화 시 identity 일치를 확인한다. rebind·markLinkDead가 바인딩을 새 객체로 교체하므로 옛 객체를 캡처한 트리거는 identity 불일치로 no-op이 된다.

### 조작 함수별 전이

- **`register`** — command 최초 진입. 기존 엔트리(live·link-dead 무관)가 있으면 주입된 `terminate`로 먼저 종결(포트 1회 + graceTimer clear로 누수 방지)한 뒤 새 live 바인딩을 publish하고 idle을 arm한다.
- **`markLinkDead`** — command 상태 drop. idle을 clear(link-dead 동안 정지)하고 새 link-dead 객체로 교체, `scheduleGrace`로 grace 타이머를 건다(콜백이 새 객체를 캡처).
- **`rebind`** — link-dead 바인딩으로 재접속 select. grace 타이머를 clear하고 새 live 객체로 교체(새 ctx 연결), idle을 재-arm한다.

세 전이가 모두 map 엔트리를 새 객체로 바꾸거나 제거하므로, 이전 객체를 캡처한 트리거는 identity 가드에서 no-op이 된다.

### close 판정 (등록 여부 + 상태)

`sessionLifecycle.handleClose(ctx)`가 소켓 `'close'`를 판정한다:

| close 발생 상황 | 판정 | 근거 |
|---|---|---|
| `command` + 바인딩 등록됨 + `binding.connection===thisCtx` | **markLinkDead + grace 타이머** | 클라 주도 순간 단절 복원 |
| `characterSelect`/`create`(레지스트리 미등록) | **transport 정리만** — 포트 미호출 | 월드 미진입, 종결 대상 아님 |
| 서버 주도 종료(evict/idle/grace만료) | `resolveDisconnect` **선행** → identity 불일치 → close는 transport 정리만 | 단일 수렴점 재진입 금지 |
| stale/evicted 소켓 close(`binding.connection!==thisCtx`) | transport 정리만 | 옛 바인딩 소켓 |

`binding.connection === ctx` 가드가 load-bearing이다 — 서버 주도 종료 후 옛 소켓의 뒤늦은 close가 새 세션을 markLinkDead하는 재진입을 막는다. 결과적으로 `resolveDisconnect`(및 lifecycle 포트)는 등록된 command 바인딩의 종결에만 호출되며, `normalClose` reason은 존재하지 않는다.

### 승계된 소켓의 잔여 프레임 (명령 디스패치 경계)

서버 주도 종료의 teardown은 **transport만** 정리한다(`cleanupConnection` + `socket.close`). 옛 `ConnectionContext`의 `state`·`boundCharacterId`는 되돌리지 않고, `ctx.closed`도 소켓 `'close'` 이벤트(별개 리스너, 다음 tick)에서야 `true`가 된다. 그 창에서 이미 버퍼된 프레임의 `'message'`가 발화하면 승계된 옛 소켓이 `command` 상태·바인딩 키를 그대로 쥔 채 명령 디스패치에 도달한다. 라이브 캐릭터 레지스트리는 `characterId` 키이므로, 그 명령은 **새 세션의** 엔트리를 변이한다(이동·gold 소비 — 세션 신뢰 경계 침범).

따라서 dispatch 직전에 **바인딩 신원 가드**를 둔다 — `registry.get(actor.characterId)`가 이 `ctx`를 `connection`으로 갖고 `link === 'live'`이며 `!ctx.closed`일 때만 명령을 실행하고, 아니면 조용히 무시한다(응답 없음, idle 재-arm 없음). close 판정표의 `binding.connection === ctx` 가드와 같은 identity 불변식을 **명령 경로에도** 적용하는 것이다: close 가드는 뒤늦은 종결이 새 세션을 markLinkDead하는 것을 막고, 이 가드는 뒤늦은 **명령**이 새 세션의 상태를 변이하는 것을 막는다. 배치·코드 형태는 [`transport-protocol.md`](transport-protocol.md) §메시지 처리 파이프라인이 정본이다.

### 재연결 흐름

```
[drop] command 소켓 'close'(클라 주도, binding.connection===thisCtx)
  → markLinkDead → 새 link-dead 객체 교체, idle clear, grace 타이머(캡처=deadBinding)
    transport 정리는 소켓 한정, deadBinding은 레지스트리에 유지

[재접속] grace 내 새 소켓 → 인증 게이트 → handshake → characterSelect
  → session:selectCharacter{characterId} → assertOwnership 통과
  → 셸 enterWorld seam이 registry.get(characterId) 조회:
      link==='link-dead' && accountId 일치 → rebind → 'resumed'
      그 외 → register(fresh; live면 evict) → 'entered'
  → enterCommand가 outcome에 따라 session:resumed / session:entered 발화

[만료] graceTimer 발화 → identity 확인 → resolveDisconnect(graceExpired)

[동시 재접속 경합] 단일 스레드 직렬 실행 → 마지막 재접속이 이긴다(선행은 evictedByNewLogin으로 종료)
```

### 제어 흐름 확장 seam

**(1) command 진입 등록 seam** — `SessionContext`에 주입 콜백 `enterWorld(characterId) => 'entered' | 'resumed'`를 더한다. FSM `enterCommand`는 emit 대신 이 seam으로 등록 결과를 받아 `session:resumed`/`session:entered`를 고른다(FSM 순수성 유지). 셸이 `sessionLifecycle.enterWorld(ctx, accountId, characterId)`를 registry 조작으로 배선한다. `register`/`rebind`는 순수 Map 조작이라 throw하지 않으므로 이벤트 순서는 항상 등록→emit→command 확정이다.

**(2) `session:resumed` shared 프로토콜** — `serverEventSchema` 판별 유니온에 variant를 추가한다(`session:entered` 미러): `z.strictObject({ type: z.literal('session:resumed'), characterId: z.string().min(1) })`.

**(3) `dispatch` 결과 타입** — 셸이 idle rearm 여부를 알도록 `dispatch`가 `DispatchResult`를 반환한다:

```
type DispatchResult =
  | { outcome: 'handled'; event?: ServerEvent }     // 유효 command 처리 → idle rearm
  | { outcome: 'rejected'; event: ServerEvent }      // unknown_type·payload 위반 → rearm 안 함
```

셸 message 핸들러의 `command` 분기는 `result.event`가 있으면 safeSend하고, `outcome==='handled'`일 때만 `ctx.idle`을 rearm한다. `bad_payload`(JSON 파싱 실패)·`internal`(방어 catch)은 라우터 바깥이라 애초에 `handled`가 아니므로 rearm하지 않는다(malformed flood 무한 연장 차단).

### 타이머 인벤토리

per-connection 타이머는 총 4종이다:

| 타이머 | 계층 | 활성 구간 | 만료 동작 | rearm |
|--------|------|----------|----------|-------|
| heartbeat | 물리 생존 (E3-1) | 연결 전체 | `terminate` | pong 수신 |
| 진행 데드라인 | 논리 진행 (E3-2) | open→command 진입 전 | graceful `close` | 상태 전이·create 전진 |
| idle timeout | 무활동 | `command`(live) | `resolveDisconnect(idleTimeout)` | `dispatch` 결과 `handled` |
| grace | 재연결 창 | link-dead 구간 | `resolveDisconnect(graceExpired)` | (단발) |

idle 타이머는 `ctx.idle` 슬롯이 단독 소유한다(`createIdleTimer` / `IdleTimer.arm`·`clear`). 진행 데드라인은 `command` 진입 시 clear되고 idle이 그 자리를 이어받는다(시간축 미중첩). idle의 종결은 3층 경계상 셸이 소유하므로, 만료 시 socket.close가 아니라 주입 `onExpire`(캡처한 바인딩으로 `resolveDisconnect(idleTimeout)` 호출)로 종결을 위임한다.

### 환경 변수

grace·idle 창은 env로 튜닝하며 스키마는 `z.coerce.number().int().min(1)`로 fail-fast 검증한다(0·음수 거부):

| 변수 | 기본값 | 의미 |
|------|--------|------|
| `WS_RECONNECT_GRACE_MS` | 30000 | link-dead grace 재연결 창 |
| `WS_IDLE_TIMEOUT_MS` | 300000 | command 무입력 종료 창 |

## 제약사항

- **저장 범위는 방 위치까지** — 실 어댑터가 종료 시 영속화하는 것은 `currentRoom`이며, HP/MP/인벤 등 나머지 라이브 필드의 저장은 그 필드를 실제로 변이하는 후속 규칙 배선 토픽이 함께 얹는다. 포트 시그니처(async 반환·world snapshot 핸들·write-ahead) 확장도 필요 시점에 한다.
- **월드측 link-dead 동작은 범위 밖** — 세션 계층 rebind만 한다. link-dead 캐릭터는 grace 동안 라이브 레지스트리와 방 점유에 그대로 남으며(종결 시점에만 해제), 피격 가능한지·전투가 지속되는지는 후속 규칙 토픽이 결정한다.
- **놓친 이벤트 리플레이 없음** — rebind는 `command` 복원 + `session:resumed` + 현재 위치 `world:room`까지다. 단절 중 놓친 이벤트(채팅·전투 로그) 재전송은 없다.
- **명시적 logout 없음** — 원작 무한에 quit 명령이 없어 이 계층에도 없다. 향후 추가 시 별도 reason으로 `resolveDisconnect`에 매핑한다.
- **연결 정원·상한·backpressure 없음** — 레지스트리는 중복/정원 정책이 소비할 seam을 제공할 뿐, 동시 접속 상한·계정별 연결 상한·rate limiting·아웃바운드 backpressure는 별도 하드닝 토픽(#54) 소관이다.
- **서버 graceful shutdown 수렴은 런타임 기반 토픽 소관** — 서버 주도 종료 시 전체 live 바인딩을 `resolveDisconnect(reason:'shutdown')`로 즉시 수렴하는 오케스트레이션은 [`runtime-foundation.md`](./runtime-foundation.md)(shutdown 수렴, #56 해소)이 소유한다. 본 계층은 그 수렴이 소비하는 seam만 제공한다 — `DisconnectReason`의 `'shutdown'` 값, `SessionRegistry.listBindings` 스냅샷, 그리고 서버 주도 종료 플래그가 set이면 close 핸들러가 `markLinkDead`(grace)를 건너뛰는 판정. close 핸들러의 서버 주도 종료 구분은 §동작 "close 판정" 표의 "서버 주도 종료" 행과 동일 원리다(플래그 가드로 link-dead 진입 차단).

## 관련 문서

- 에픽 [#32 E3 전송·세션 계층](https://github.com/smalljiny/muhan/issues/32)
- 선행 스펙: [`transport-protocol.md`](./transport-protocol.md)(E3-1) · [`auth-session.md`](./auth-session.md)(E3-2)
- ADR: [`architecture.md`](./architecture.md)(D6 세션·D5 프로토콜 슬롯)
- 후속·조정: [#54 WS 자원 고갈 하드닝](https://github.com/smalljiny/muhan/issues/54) · [#56 서버 shutdown 세션 수렴](https://github.com/smalljiny/muhan/issues/56)(해소 → [`runtime-foundation.md`](./runtime-foundation.md))
