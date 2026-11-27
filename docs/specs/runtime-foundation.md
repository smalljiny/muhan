# 런타임 기반 (월드 틱·타이머 확장 지점(seam)·shutdown 정리)

> 무한 월드 상태 엔진(E4)의 기반이 되는 순수 런타임 인프라다. 1Hz 중앙 월드 틱, 타이머 주입 seam 단일화(`util/clock.ts`), graceful shutdown 때의 세션 일괄 종료로 이루어진다. 이동·방 채널(#69)과 스폰·몬스터 AI(#68)는 이 기반에 register로 등록된다.

## 개요

E3(전송·세션 계층)는 WS 핸드셰이크, 세션 FSM, 재연결 레지스트리를 확립했다. 그다음으로 게임플레이의 기반이 되는 계층은 월드 상태 엔진(E4)이다. E4의 첫 작업은 게임 로직이 아니라 **런타임 타이밍 구조**다. 아래 세 축이 함께 런타임 타이밍 인프라를 이룬다.

- **1Hz 중앙 월드 틱** (`world/worldClock.ts`)
  - 원본 무한의 `update_game` 1Hz 게이트와 `update_*` modulo 서브시스템 구조를 재현한다(ADR D1).
  - 서버 곳곳에 개별 `setInterval`을 흩어 두지 않는다. 단일 `WorldClock`이 1초 케이던스로 단조 tick 카운터를 올리고, 등록된 슬롯을 각자의 `intervalSec`로 modulo 게이트해 호출한다.
- **타이머 seam 단일화** (`util/clock.ts`)
  - `SchedulerClock`/`IntervalHandle`/`defaultClock`을 단일 출처로 떼어 낸다(#50).
  - `save/saveScheduler`, `ws/heartbeat`, `world/worldClock`이 같은 주입 관용구와 테스트 FakeClock을 공유한다.
- **graceful shutdown 세션 일괄 종료** (`ws/shutdownConvergence.ts` + `index.ts` 연결)
  - 서버가 종료를 주도하면 월드 틱을 멈추고, live 세션 바인딩 전체를 즉시 `resolveDisconnect`로 일괄 종료한다(#56).
  - 그래서 `app.close()` 뒤에 registry 엔트리나 referenced 타이머가 남지 않는다.

세 축은 서로 의존한다. 월드 틱은 `util/clock.ts`를 clock으로 쓰고, shutdown 정리는 월드 틱을 정지 대상에 포함한다. `util/clock.ts` 통일은 월드 틱이라는 실제 소비자가 생기는 이 시점에야 의미가 있다. #50이 E4까지 미뤄진(defer) 이유가 이것이다. 또 월드 틱은 event loop를 붙잡는 referenced 타이머를 추가하므로, shutdown 정리를 함께 머지해야 hang을 막을 수 있다.

이 계층은 **순수 프레임워크**다(YAGNI). 실제 슬롯(게임시간 진행, 몬스터 큐, 출구 타이머)은 붙이지 않고, 소비자 등록 seam만 확정한다. 실제 소비는 후속 토픽(#69/#68)이 `register`로 연결한다.

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

`setInterval`/`clearInterval`의 최소 계약만 노출한다. 주기 콜백을 거는 컴포넌트(saveScheduler, heartbeat, WorldClock)는 전역 타이머를 직접 부르지 않고 이 seam을 거쳐 호출한다. 그 덕분에 (a) 테스트에서 FakeClock을 주입해 tick을 손으로 실행할 수 있고, (b) 스케줄러가 clock 구현을 바꾸거나 공유할 수 있다. 전역 싱글턴 대신 의존성을 생성자로 주입해 인스턴스끼리 격리한다. `defaultClock`은 전역 타이머에 그대로 위임하는, 상태 없는 기본값이다.

각 소비자의 seam 형태:

| 소비자 | 주입 필드 | 미주입 기본값 |
|--------|-----------|---------------|
| `save/saveScheduler` | `clock?: SchedulerClock` | `defaultClock` |
| `ws/heartbeat` | `clock?: SchedulerClock` | `defaultClock` |
| `world/worldClock` | `clock?: SchedulerClock` (`WorldClockOptions`) | `defaultClock` |

`saveScheduler`는 `SchedulerClock`과 `IntervalHandle`을 `util/clock.ts`에서 import해 다시 export한다(하위 호환). `heartbeat`는 예전의 2-함수 seam(`setIntervalFn`/`clearIntervalFn`)을 `clock` 필드 하나로 바꿨다. 소켓 생존 ping/pong 정책은 그대로이고, 타이머 주입 인터페이스만 통일했다.

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

- **케이던스**: 1초(`1000ms`)짜리 `setInterval` 1개를 쓴다. `onTick`은 단조 tick 카운터를 pre-increment(`++tickCounter` → 첫 tick=1)한다. wall-clock이 아니라 단조 카운터이므로 결과가 결정적이고 테스트하기 쉽다.
- **슬롯 컬렉션**: `Set<WorldTickSlot>`. `register`는 slot을 추가하고, 그 slot만 제거하는 해제 함수를 반환한다. 해제 함수는 여러 번 호출해도 안전하다.
- **logger seam**: 슬롯 실패는 주입받은 `WorldTickLogger.error`로 기록한다. `console`은 쓰지 않는다(`save/logger.ts` 관례를 따름). 기본값은 no-op logger다.

### `ShutdownConverger` — shutdown 세션 일괄 종료 헬퍼

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

서버 주도 종료 플래그를 들고, 등록된 모든 세션 바인딩을 한꺼번에 종결하는 순수 단위다. 상태(boolean 플래그)는 클로저 안에 감춘다(`createSessionRegistry` 관례를 따름). 일괄 종료에는 `registry.listBindings` 스냅샷과 주입받은 `resolveDisconnect`만 쓴다. 소켓, 타이머, 신호 같은 전역에 기대지 않으므로 연결 코드 밖에서 단위 테스트할 수 있다. `ws/plugin.ts`가 `registerWebsocket` 1회 안에서 이것을 조립해 `app.wsShutdown`으로 노출한다.

## 동작

### 1Hz modulo 게이트 + 슬롯 격리

`onTick`은 매초 `tickSec = ++tickCounter`로 카운터를 올린다. 그리고 슬롯 컬렉션의 스냅샷(`[...slots]`)을 돌며 `tickSec % slot.intervalSec === 0`인 슬롯만 `run(tickSec)`한다. 스냅샷을 순회하므로 슬롯이 자기 콜백 안에서 해제해도 안전하다. 각 `run`은 try/catch로 감싸서, throw가 나면 logger에 기록하고 다음 슬롯을 계속 호출한다. 서버가 오래 떠 있어야 하므로, 서브시스템 하나의 오류가 전체 틱이나 다른 슬롯을 죽이면 안 된다. `start`는 이미 arm돼 있으면 다시 arm하지 않는다. `stop`은 정지 상태에서 불러도 아무 일도 하지 않는다(no-op).

### shutdown 정리 순서 (`index.ts` `gracefulShutdown`)

SIGTERM/SIGINT를 받으면 아래 순서로 진행한다. 캐시된 Promise를 쓰므로 idempotent하다. 신호가 중복으로 와도 같은 Promise를 반환한다.

1. **`app.wsShutdown.markShuttingDown()`** — 서버 주도 종료 플래그를 set한다.
   - 이후 들어오는 소켓 close는 `ws/plugin.ts` close 핸들러의 `isShuttingDown` 가드에 걸려 `markLinkDead`(grace)를 건너뛴다.
   - 이렇게 해서 서버 종료가 클라이언트 주도 drop으로 잘못 판정되고 referenced grace 타이머가 걸리는 일을 막는다.
2. **`worldClock.stop()`** — 월드 틱을 멈춘다. 새 게임 이벤트가 들어오지 않게 하고 referenced interval을 해제한다.
3. **`app.wsShutdown.converge()`** (1차) — `listBindings` 스냅샷의 모든 바인딩을 `resolveDisconnect(binding, 'shutdown')`로 일괄 종결한다.
   - `SessionLifecyclePort.onSessionEnd`가 바인딩마다 정확히 1회 호출된다. 지금은 no-op이고, 실제 save 포트가 머지되면 저장을 한다.
   - grace/idle 타이머도 clear한다.
4. **`await app.close()`** — `@fastify/websocket` preClose가 남은 소켓을 닫는다. 1의 플래그 덕분에 link-dead 상태를 거치지 않고 닫힌다.
5. **`app.wsShutdown.converge()`** (2차) — late 바인딩을 한 번 더 일괄 종료한다.
   - late 바인딩은 `app.close()`를 기다리는 동안 큐에 있던 프레임이 `enterWorld`로 등록한 것으로, 1차 스냅샷 이후에 들어온 몫이다.
   - 이 소켓의 close는 shutdown 플래그 가드 때문에 close 핸들러를 건너뛰므로 스스로 정리되지 못한다.
   - `app.close()`가 끝난 시점에는 소켓이 모두 닫혔고 새 등록도 불가능하다. 그래서 이때의 2차 일괄 종료가 레지스트리를 확실하게 비운다.
6. **`saveEngine.shutdown()` → `conn.close()` → `process.exit(0)`** — 남은 dirty를 force-flush하고 DB 연결을 닫는다.

3·4·5는 `try`로 감싸고, 6의 flush와 close는 `finally`에 둔다. 그래서 converge나 `app.close`가 throw해도 `saveEngine.shutdown()` force-flush는 반드시 실행된다. `converge`는 바인딩마다 try/catch로 격리한다(`logConvergeFailure`). 바인딩 하나의 종결이 실패해도 나머지 종료 처리나 상위 flush는 멈추지 않는다. finally와 바인딩별 격리라는 이 이중 방어가 #56 유형의 결함, 곧 shutdown 연결 코드가 flush를 건너뛰는 경로가 다시 생기지 않게 막는다.

### 정리 멱등·안전

`converge`는 플래그를 검사하지 않고 언제나 스냅샷을 일괄 종료한다. 호출 순서(플래그 set 후 converge)는 `index.ts` 연결 코드가 담당한다. `listBindings`는 라이브 뷰가 아니라 복사한 스냅샷이므로, `resolveDisconnect`가 순회 도중 registry에서 바인딩을 제거해도 안전하다. `resolveDisconnect`의 identity 가드와 선-제거가 재진입과 이중 종결을 막는다. link-dead 바인딩은 graceTimer를 clear하고 포트를 1회 호출한 뒤, teardown은 no-op으로 끝나 안전하게 종결된다. 따라서 2차 `converge`를 다시 불러도 안전하다. 세션 일괄 종료 seam 계약은 [`session-lifecycle.md`](./session-lifecycle.md)를 참조한다.

### 연결 (`index.ts` `boot`)

`boot`는 `new WorldClock({ logger })`를 만든다. 이어서 다른 의존 없이 동작하는 실제 슬롯 `createGameTime().slot`과 `createCheckExitsSlot(worldGraph)`를 `register`하고, `start()`로 1Hz 틱을 시작한다. 슬롯 실패를 격리해 기록하는 logger는 `app.log.error`에 위임한다(`console` 금지). `gracefulShutdown` 클로저는 `worldClock`과 `app.wsShutdown`을 캡처한다.

연결 코드는 기존 관례대로 커버리지에서 제외한다. 정리·정지 로직과 슬롯은 테스트할 수 있는 모듈(`worldClock.ts`·`shutdownConvergence.ts`·`gameTime.ts`·`checkExits.ts`)에 둔다. 두 슬롯을 함께 등록하고 실행하는 동작은 `worldClockSlots.integration.test.ts`가 검증한다. `SchedulerClock`, `WorldClock`, `ShutdownConverger` 모듈은 각각 단위 커버리지 100%다. 이동·방 서브시스템이 슬롯을 어떻게 쓰는지는 [`movement-rooms.md`](./movement-rooms.md)를 참조한다.

## 제약사항

- **실 슬롯 소비는 소비 토픽 담당**
  - `WorldClock`은 등록 프레임워크와 API를 확정한다.
  - E4-1b(#69)가 첫 실제 슬롯 소비자다. 게임시각(`gameTime`, `intervalSec=150`)과 출구 타이머(`checkExits`, `intervalSec=1`)를 boot에서 `register`한다([`movement-rooms.md`](./movement-rooms.md)).
  - 나머지 실제 슬롯은 후속 소비 토픽이 붙인다. 몬스터 큐·스폰(#68), 저빈도 `update_*` 게임시간 주야, moonstone 등이 여기에 해당한다.
- **소켓 ping/pong 정책 불변** — `ws/heartbeat`는 타이머 주입 seam만 `clock`으로 통일한다. 생존 판정 로직(미스 카운터, `maxMissed`, `terminate`)은 E3에서 확정한 그대로다.
- **#51(ctx.heartbeat 타이머 단일 소유권) 범위 밖** — registry sweep 설계와 얽힌 별도 이슈다. 이 토픽은 타이머 *주입 seam*만 통일하고, 소유권 리팩터는 다루지 않는다.
- **실 save 포트 연결 없음** — `SessionLifecyclePort`는 no-op으로 남는다. shutdown 정리 경로가 포트를 바인딩마다 정확히 1회 호출한다는 점만 확정한다. 실제 저장 어댑터는 라이브 월드 캐릭터가 생기는 후속 에픽(E4/E5)이 담당한다.
- **월드 상태 flush 경계는 세션 종료 포트까지** — 라이브 캐릭터의 방 위치 같은 월드 쪽 상태가 아직 없다(E4-1b/E2). 그래서 shutdown 정리는 세션 종료 포트 호출까지만 한다. 월드 상태 flush 경계는 E4-1b 이후 다시 검토한다.

## 관련 문서

- ADR: [`architecture.md`](./architecture.md) §3.3 (D1 런타임 모델 — 1Hz heartbeat + modulo 서브시스템)
- 세션 일괄 종료 seam: [`session-lifecycle.md`](./session-lifecycle.md) (`resolveDisconnect`·`DisconnectReason`·`listBindings`)
- 타이머 seam 소비자: [`save-policy.md`](./save-policy.md)(saveScheduler) · [`transport-protocol.md`](./transport-protocol.md)(heartbeat)
- 이슈: #50(타이머 seam 통일), #56(shutdown 정리), #34(부모 에픽 E4), #67(본 토픽)
- 후속: #69(E4-1b 이동·방 — 첫 실 슬롯 소비자), #68(E4-2 스폰·AI)
