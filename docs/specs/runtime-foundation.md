# 런타임 기반 (월드 틱·타이머 seam·shutdown 수렴)

> 무한 월드 상태 엔진(E4)이 올라탈 순수 런타임 인프라 — 1Hz 중앙 월드 틱, 타이머 주입 seam 단일화(`util/clock.ts`), graceful shutdown 세션 수렴. 이동·방 채널(#69)과 스폰·크리처 AI(#68)는 이 기반 위에 register로 얹힌다.

## 개요

E3(전송·세션 계층)가 WS 핸드셰이크·세션 FSM·재연결 레지스트리를 확립한 뒤, 게임플레이가 올라탈 다음 척추는 월드 상태 엔진(E4)이다. 그 첫 조각은 게임 로직이 아니라 **런타임 타이밍 뼈대**다 — 세 축이 한 축(런타임 타이밍 인프라)을 함께 정의한다.

- **1Hz 중앙 월드 틱** (`world/worldClock.ts`) — 원본 무한의 `update_game` 1Hz 게이트 + `update_*` modulo 서브시스템 구조를 재현한다(ADR D1). 서버 전체가 개별 `setInterval`을 흩뿌리지 않고 단일 `WorldClock`이 1초 케이던스로 단조 tick 카운터를 굴리며, 등록된 슬롯을 각자의 `intervalSec`로 modulo 게이트해 호출한다.
- **타이머 seam 단일화** (`util/clock.ts`) — `SchedulerClock`/`IntervalHandle`/`defaultClock`을 단일 출처로 승격한다(#50). `save/saveScheduler`·`ws/heartbeat`·`world/worldClock`이 동일한 주입 관용구와 테스트 FakeClock을 공유한다.
- **graceful shutdown 세션 수렴** (`ws/shutdownConvergence.ts` + `index.ts` 배선) — 서버 주도 종료 시 월드 틱을 정지하고 전체 live 세션 바인딩을 즉시 `resolveDisconnect`로 수렴한다(#56). `app.close()`가 registry 엔트리·referenced 타이머를 남기지 않는다.

세 축은 상호 의존한다 — 월드 틱은 `util/clock.ts`를 clock으로 소비하고, shutdown 수렴은 월드 틱을 정지 대상으로 포함한다. 월드 틱이라는 실 소비자가 생기는 이 시점에만 `util/clock.ts` 통일이 의미를 갖고(#50이 E4까지 defer된 이유), 월드 틱이 event loop를 붙잡는 referenced 타이머를 추가하므로 shutdown 수렴이 함께 랜딩해야 hang을 막는다.

이 계층은 **순수 프레임워크**다(YAGNI). 실 슬롯(게임시간 진행·크리처 큐·출구 타이머)은 붙이지 않으며, 소비자 등록 seam만 확정한다. 실 소비는 후속 토픽(#69/#68)이 `register`로 연결한다.

## 구조 / 스키마

### `util/clock.ts` — 타이머 주입 seam 단일 출처

```ts
export type IntervalHandle = ReturnType<typeof setInterval>
export interface SchedulerClock {
  setInterval(callback: () => void, ms: number): IntervalHandle
  clearInterval(handle: IntervalHandle): void
}
export const defaultClock: SchedulerClock  // 전역 setInterval/clearInterval에 위임
```

`setInterval`/`clearInterval`의 최소 계약만 노출한다. 주기 콜백을 거는 컴포넌트(saveScheduler·heartbeat·WorldClock)가 전역 타이머를 직접 부르지 않고 이 seam을 통해 호출해, (a) 테스트에서 FakeClock을 주입해 tick을 수동 구동하고, (b) 스케줄러가 clock 구현을 교체·공유한다. 전역 싱글턴을 쓰지 않고 의존성을 생성자로 주입해 인스턴스 격리를 보장한다. `defaultClock`은 전역 타이머에 그대로 위임하는 무상태 기본값이다.

각 소비자의 seam 형태:

| 소비자 | 주입 필드 | 미주입 기본값 |
|--------|-----------|---------------|
| `save/saveScheduler` | `clock?: SchedulerClock` | `defaultClock` |
| `ws/heartbeat` | `clock?: SchedulerClock` | `defaultClock` |
| `world/worldClock` | `clock?: SchedulerClock` (`WorldClockOptions`) | `defaultClock` |

`saveScheduler`는 `SchedulerClock`·`IntervalHandle`을 `util/clock.ts`에서 import해 재-export한다(하위 호환). `heartbeat`는 종전 2-함수 seam(`setIntervalFn`/`clearIntervalFn`)을 `clock` 단일 필드로 교체했다 — 소켓 생존 ping/pong 정책 자체는 불변, 타이머 주입 표면만 통일했다.

### `WorldClock` — 1Hz 중앙 월드 틱

```ts
export interface WorldTickSlot {
  readonly name: string
  readonly intervalSec: number       // modulo 간격(초). 1 = 매 틱
  run(tickSec: number): void         // 슬롯 콜백. throw는 격리
}
export interface WorldTickLogger {
  error(ctx: Record<string, unknown>, msg: string): void
}
export interface WorldClockOptions {
  readonly clock?: SchedulerClock    // 기본 defaultClock
  readonly logger?: WorldTickLogger  // 슬롯 실패 logger(기본 no-op)
}
class WorldClock {
  constructor(options?: WorldClockOptions)
  get running(): boolean
  register(slot: WorldTickSlot): () => void  // 해제 함수 반환
  start(): void   // 1Hz interval arm(중복 arm 방지)
  stop(): void    // interval clear(정지 상태 호출 no-op)
}
```

- **케이던스**: 1초(`1000ms`) `setInterval` 1개. `onTick`이 단조 tick 카운터를 pre-increment(`++tickCounter` → 첫 tick=1)한다. wall-clock이 아닌 단조 카운터라 결정적·테스트 가능하다.
- **슬롯 컬렉션**: `Set<WorldTickSlot>`. `register`는 slot을 추가하고 그 slot만 제거하는 해제 함수를 반환한다(여러 번 호출해도 안전).
- **logger seam**: 슬롯 실패는 주입 `WorldTickLogger.error`로 기록한다. `console` 금지(`save/logger.ts` 관례 미러). 기본값은 no-op logger.

### `ShutdownConverger` — shutdown 세션 수렴 헬퍼

```ts
export interface ShutdownConverger {
  isShuttingDown(): boolean
  markShuttingDown(): void
  converge(): void
}
export interface ShutdownConvergerDeps {
  readonly registry: Pick<SessionRegistry, 'listBindings'>
  readonly resolveDisconnect: TerminateCallback
  readonly logConvergeFailure?: (binding: SessionBinding, err: unknown) => void
}
export function createShutdownConverger(deps: ShutdownConvergerDeps): ShutdownConverger
```

서버 주도 종료 플래그와, 등록된 모든 세션 바인딩을 일괄 종결하는 순수 단위다. 상태(boolean 플래그)를 클로저에 캡슐화하고(`createSessionRegistry` 관례 미러), `registry.listBindings` 스냅샷 + 주입 `resolveDisconnect`만으로 수렴한다 — 소켓·타이머·신호 전역에 의존하지 않아 배선 밖에서 단위 테스트 가능하다. `ws/plugin.ts`가 `registerWebsocket` 1회에 조립해 `app.wsShutdown`으로 노출한다.

## 동작

### 1Hz modulo 게이트 + 슬롯 격리

`onTick`은 매 초 `tickSec = ++tickCounter`를 올리고, 슬롯 컬렉션의 스냅샷(`[...slots]`)을 순회하며 `tickSec % slot.intervalSec === 0`인 슬롯만 `run(tickSec)`한다. 스냅샷 순회라 슬롯이 자기 콜백에서 해제해도 순회가 안전하다. 각 `run`을 try/catch로 감싸 throw를 logger로 기록하고 다음 슬롯을 계속 호출한다 — 한 서브시스템 오류가 전체 틱이나 형제 슬롯을 죽이지 않는다(장수 서버). `start`는 이미 arm돼 있으면 재-arm하지 않고, `stop`은 정지 상태에서 호출해도 안전한 no-op이다.

### shutdown 수렴 순서 (`index.ts` `gracefulShutdown`)

SIGTERM/SIGINT 수신 시 순서(캐시된 Promise로 idempotent — 중복 신호는 같은 Promise 반환):

1. **`app.wsShutdown.markShuttingDown()`** — 서버 주도 종료 플래그를 set한다. 이후 도착하는 소켓 close는 `ws/plugin.ts` close 핸들러의 `isShuttingDown` 가드로 `markLinkDead`(grace)를 건너뛴다 — 서버 종료가 클라 주도 drop으로 오판돼 referenced grace 타이머가 걸리는 것을 차단한다.
2. **`worldClock.stop()`** — 월드 틱 정지. 신규 게임 이벤트 유입을 끊고 referenced interval을 해제한다.
3. **`app.wsShutdown.converge()`** (1차) — `listBindings` 스냅샷의 모든 바인딩을 `resolveDisconnect(binding, 'shutdown')`로 일괄 종결한다. `SessionLifecyclePort.onSessionEnd`가 바인딩당 정확히 1회 호출되고(현재 no-op, 실 save 포트 랜딩 시 저장), grace/idle 타이머를 clear한다.
4. **`await app.close()`** — `@fastify/websocket` preClose가 잔여 소켓을 닫되, 1의 플래그로 link-dead 진입 없이 닫힌다.
5. **`app.wsShutdown.converge()`** (2차) — `app.close()` 대기 중 큐잉 프레임이 `enterWorld`로 등록한 late 바인딩(1차 스냅샷 이후 진입분)을 한 번 더 수렴한다. 그 소켓의 close는 shutdown 플래그 가드로 close 핸들러를 건너뛰어 스스로 수렴하지 못하므로, `app.close()` 완료(소켓 전량 종료·신규 등록 불가) 시점의 2차 수렴이 레지스트리를 확정적으로 비운다.
6. **`saveEngine.shutdown()` → `conn.close()` → `process.exit(0)`** — 잔여 dirty를 force-flush하고 DB 연결을 닫는다.

3·4·5를 `try`로 감싸고 6의 flush·close를 `finally`에 둔다 — converge나 `app.close`가 throw해도 `saveEngine.shutdown()` force-flush가 무조건 실행된다. `converge`는 바인딩별로 try/catch 격리하며(`logConvergeFailure`), 한 바인딩 종결 실패가 나머지 수렴이나 상위 flush를 중단시키지 않는다. 이 이중 방어(finally + 바인딩별 격리)가 #56 결함 클래스(shutdown 배선이 flush 스킵 경로를 만드는 것)의 재발을 막는다.

### 수렴 멱등·안전

`converge`는 플래그를 검사하지 않고 항상 스냅샷을 수렴한다 — 호출 순서(플래그 set 후 converge)는 `index.ts` 배선이 소유한다. `listBindings`가 라이브 뷰가 아닌 복사 스냅샷이라 `resolveDisconnect`가 순회 중 registry에서 제거해도 안전하다. `resolveDisconnect`의 identity 가드·선-제거가 재진입/이중 종결을 막고, link-dead 바인딩은 graceTimer clear + 포트 1회 후 teardown no-op으로 안전 종결된다. 따라서 2차 `converge` 재호출도 안전하다(세션 수렴 seam 계약은 [`session-lifecycle.md`](./session-lifecycle.md) 참조).

### 배선 (`index.ts` `boot`)

`boot`에서 `new WorldClock({ logger })`를 생성하고, 자족 실 슬롯 `createGameTime().slot`·`createCheckExitsSlot(worldGraph)`를 `register`한 뒤 `start()`로 1Hz 틱을 시작한다. 슬롯 실패 격리 logger는 `app.log.error`에 위임한다(`console` 금지). `gracefulShutdown` 클로저가 `worldClock`·`app.wsShutdown`을 캡처한다. 배선 코드는 커버리지 제외(기존 관례)이며, 수렴·정지 로직과 슬롯은 테스트 가능한 모듈(`worldClock.ts`·`shutdownConvergence.ts`·`gameTime.ts`·`checkExits.ts`)에 둔다. 두 슬롯의 동시 등록·발화는 `worldClockSlots.integration.test.ts`가 검증한다. `SchedulerClock`·`WorldClock`·`ShutdownConverger` 각 모듈은 단위 커버리지 100%다. 이동·방 서브시스템의 슬롯 소비 상세는 [`movement-rooms.md`](./movement-rooms.md) 참조.

## 제약사항

- **실 슬롯 소비는 소비 토픽 소관** — `WorldClock`은 등록 프레임워크와 API를 확정한다. E4-1b(#69)가 첫 실 슬롯 소비자로 게임시각(`gameTime`, `intervalSec=150`)·출구 타이머(`checkExits`, `intervalSec=1`)를 boot에서 `register`한다([`movement-rooms.md`](./movement-rooms.md)). 나머지 실 슬롯(크리처 큐·스폰=#68, 저빈도 `update_*` 게임시간 주야·moonstone 등)은 후속 소비 토픽이 붙인다.
- **소켓 ping/pong 정책 불변** — `ws/heartbeat`는 타이머 주입 seam만 `clock`으로 통일한다. 생존 판정 로직(미스 카운터·`maxMissed`·`terminate`)은 E3 확정 사항 그대로다.
- **#51(ctx.heartbeat 타이머 단일 소유권) 범위 밖** — registry sweep 설계와 결합된 별도 이슈. 본 토픽은 타이머 *주입 seam*만 통일하며 소유권 리팩터는 다루지 않는다.
- **실 save 포트 배선 없음** — `SessionLifecyclePort`는 no-op 유지. shutdown 수렴 경로가 포트를 바인딩당 정확히 1회 호출함만 확정한다. 실 저장 어댑터는 라이브 월드 캐릭터가 존재하는 후속 에픽(E4/E5) 소관.
- **월드 상태 flush 경계는 세션 종료 포트까지** — 라이브 캐릭터의 방 위치 등 월드측 상태가 아직 없으므로(E4-1b/E2), shutdown 수렴은 세션 종료 포트 호출까지만 한다. 월드 상태 flush 경계는 E4-1b 이후 재검토한다.

## 관련 문서

- ADR: [`architecture.md`](./architecture.md) §3.3 (D1 런타임 모델 — 1Hz heartbeat + modulo 서브시스템)
- 세션 수렴 seam: [`session-lifecycle.md`](./session-lifecycle.md) (`resolveDisconnect`·`DisconnectReason`·`listBindings`)
- 타이머 seam 소비자: [`save-policy.md`](./save-policy.md)(saveScheduler) · [`transport-protocol.md`](./transport-protocol.md)(heartbeat)
- 이슈: #50(타이머 seam 통일), #56(shutdown 수렴), #34(부모 에픽 E4), #67(본 토픽)
- 후속: #69(E4-1b 이동·방 — 첫 실 슬롯 소비자), #68(E4-2 스폰·AI)
