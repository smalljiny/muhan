# 세이브 정책 엔진 (E2-2)

> 인메모리 권위 상태를 MongoDB에 영속화하는 행위 계층이다. 세 가지를 제공한다: dirty-flag 주기 flush와 비동기 배치 write-behind, 이벤트 즉시 저장(`saveNow`), 은행 gold 이동의 원자적 트랜잭션.

## 개요

이 문서는 **세이브가 언제, 어떻게 일어나는가**를 다룬다. [`persistence.md`](persistence.md)(E2-1)가 만든 연결, 문서 스키마, repository를 그대로 쓴다. ADR([`architecture.md`](architecture.md) §3.4 D2)의 "DB-네이티브 세이브 신규 설계" 결정을 구현한다. 원작 오라클의 이벤트 기반 세이브 타이밍(주기 자동세이브 없음)은 유지하고, 크래시에 대비해 짧은 주기 flush를 더한다.

저장 경로는 두 가지로 명확히 나뉜다.

| 경로 | 대상 | 메커니즘 | 손실 모델 |
|------|------|----------|----------|
| **write-behind(주기)** | 자주 바뀌는 연속 상태: 캐릭터 진행·재생·위치, 방 문·리스폰 타임스탬프 | `markDirty` → 주기 flush → 비동기 upsert | 크래시 시 최대 flush 간격만큼 손실(수용) |
| **동기 즉시** | 중요 이벤트(레벨업, 로그아웃), **돈(은행·금화)** | `saveNow`(await) / `BankTransactionService`(트랜잭션) | 손실 없음 |

이 엔진은 **메커니즘만** 제공한다. 게임플레이 호출처(레벨업, 거래, 로그아웃에서 `markDirty`/`saveNow`를 부르는 곳)는 후속 에픽의 범위다. 각 컴포넌트는 테스트에서 따로 실행한다(§제약사항).

## 구조 / 스키마

세이브 엔진은 `packages/server/src/save/`(신규)에, 은행 트랜잭션 서비스는 `packages/server/src/bank/`에 있다. E2-1 repository를 생성자로 주입받아 쓰며, 부팅 시 `index.ts`가 이들을 `SaveEngine` 객체 하나로 조립한다.

```
SaveEngine (부팅 조립, index.ts)
├── DirtyTracker         2단 소유: registry(미착수) + inProgress(write 진행 중), peek 조회 seam
├── SaveScheduler        주입 clock, 주기 flush(기본 120s) → tracker checkout → queue enqueue
├── AsyncWriteQueue      bounded, coalescing, 재시도 분류, in-flight evict seam, 종결 통지(onSettled), 비동기 워커
├── dispatch adapter     collection별 write 매핑(characters·bankAccounts→updateById, roomStates→upsert, objectDeletions→deleteById)
└── shutdown()           scheduler 정지 → 강제 flush → queue drain

BankTransactionService (bank/, index.ts와 독립 조립)
                        withTransaction 2-문서 CAS 입출금 + gold 가드
```

| 파일 | 역할 |
|------|------|
| `save/dirtyTracker.ts` | 변경된 엔티티를 담는 side registry(coalescing, checkout/ack/discard/peek/evict)와 공용 `dirtyKey` |
| `save/saveScheduler.ts` | 주입받은 clock으로 주기 flush, re-entrancy 방어 |
| `save/asyncWriteQueue.ts` | bounded 비동기 write 큐(재시도 분류, backpressure, evict) |
| `save/saveEngine.ts` | 위 셋을 조립하고 `markDirty`·`peekPending`·`saveNow`·`start`·`shutdown` 확장 지점(seam)을 제공 |
| `save/logger.ts` | 공용 `SaveLogger` seam(console 금지)과 `NOOP_LOGGER` |
| `bank/bankTransactionService.ts` | 은행 gold 이동 원자적 트랜잭션 |
| `repo/mongoTestDb.testutil.ts` | 통합 테스트 하네스(단일노드 replica set) |
| `repo/characterSchemas.ts` | `characterPatchSchema`의 단일 출처(의존 0). 영속 경로와 hydrate overlay가 함께 쓴다 |

## 동작

### DirtyTracker

`markDirty(collection, id, snapshot)`는 side registry `Map<"collection:id", {collection, id, snapshot}>`에 최신 스냅샷을 기록한다. 같은 키로 다시 호출하면 이전 스냅샷을 덮어써서 **coalescing(last-write-wins)**이 된다. 예를 들어 한 flush 주기 안에 HP가 10번 바뀌어도 upsert는 1회다. 도메인 객체에 `.dirty` 필드를 넣지 않고 외부 레지스트리로 분리해 불변성 규칙(coding-style.md)을 지킨다.

- `checkout()`: 현재 registry 전체를 배열로 반환하고, **같은 엔트리를 `inProgress`로 옮긴 뒤** registry를 비운다. registry에 대해 파괴적이고 원자적이다(Node 단일 스레드). 그래서 flush가 동시에 겹쳐도 서로 겹치지 않는 집합을 가져간다. 스케줄러와 shutdown이 쓴다.
- `ack(entry)` / `discard(entry)`: write가 끝났음을 알려 `inProgress`에서 소유권을 반납한다. 전자는 write 성공, 후자는 폐기(permanent 실패, 재시도 소진, 어댑터 없음)다.
- `peek(collection, id)`: 아직 영속되지 않은 스냅샷을 비파괴적으로 조회한다. `registry`를 먼저 보고, 없을 때만 `inProgress`를 본다.
- `evict(collection, id)`: 키 하나를 **두 맵 모두에서** 지운다(없으면 no-op). `saveNow`가 즉시 write 직전에 호출한다.
- `dirtyKey(collection, id)`: `collection:id` 키 포맷의 단일 출처(export)다. `AsyncWriteQueue`도 같은 함수를 쓴다. 두 키가 어긋나면 `saveNow`의 2계층 evict가 절반만 동작한다.
- 스냅샷 타입은 컬렉션마다 문서 형태가 달라 `unknown`으로 받고, **참조 그대로 보관**한다(복제하지 않음). 호출 계약: 라이브 도메인 객체 참조가 아니라 **그 시점의 스냅샷**을 넘긴다(라이브 참조를 넘기면 coalescing이 의미가 없어진다).

#### 스냅샷 수명 계약 (2단 소유, #124)

**키별 최신 미영속 스냅샷은 `markDirty`부터 그 스냅샷의 write가 성공(`ack`)하거나 폐기(`discard`)될 때까지 `registry`·`inProgress` 중 정확히 한 곳에 있다.** 재접속 hydrate의 pending overlay는 이 연속성에 기대어 동작한다([live-world-foundation.md](live-world-foundation.md) §진입).

이전의 파괴적 `drain()`은 스냅샷을 내보내자마자 tracker에서 지웠다. 그 결과 아래 세 구간에서 스냅샷이 **어느 조회 위치에도 없었다**. 조회 지점을 늘려 구간마다 막는 방식으로는 네 번째 빈틈이 없다는 것을 증명할 수 없다. 그래서 소유자를 하나로 만드는 쪽을 택했다.

| 구간 | 이전(drain) | 현재(checkout) |
|---|---|---|
| `markDirty` 이후 | `registry` ✅ | `registry` ✅ |
| 반출 이후 ~ `enqueue` 수락 전 | 없음 ❌ (스케줄러 지역 배열) | `inProgress` ✅ |
| `enqueue` 수락 후 대기 | 큐 `pending`(접근자 없음) ❌ | `inProgress` ✅ |
| write 진행 중 | 없음 ❌ (`pending.delete` 후 in-flight) | `inProgress` ✅ |
| write 성공 이후 | DB ✅ | DB ✅ (`ack`로 반납) |

- **`ack`·`discard`는 키가 아니라 entry를 받는다.** 키와 엔트리가 어긋난 채로 호출하면 참조 동일성 검사에서 조용히 no-op이 되어, 반납이 빠져도 아무도 모른다. entry에서 키를 끌어내면 그런 조합 자체를 만들 수 없다.
- **반납은 참조 동일성으로 판정한다.** 키 K가 S1으로 in-flight인 동안 K가 S2로 다시 mark되고, 다음 `checkout`이 S2를 옮겼다고 하자. 그러면 늦게 도착한 S1의 종결 통지는 no-op이 되고, 아직 write되지 않은 S2는 그대로 남는다.
- **세대별로 보관하지 않는다.** 불변식의 대상은 "모든 스냅샷"이 아니라 **키별 최신**이다. S1이 S2로 대체되면 S1의 수명은 그때 끝난다. 어차피 coalescing으로 버려질 값이고, `peek`이 `registry`를 먼저 보므로 조회 결과는 항상 S2다. S1의 write가 늦게 반영돼 DB에 옛 값이 들어가도 뒤이은 S2 write가 바로잡는다.
- **`size`와 `inProgressSize`를 더해도 미영속 키 수가 되지 않는다.** checkout 후 다시 mark된 키는 두 맵에 동시에 있어 두 번 세어지기 때문이다. 키 단위 판정은 `peek`으로 한다.
- `inProgress` 크기는 큐 capacity가 아니라 **flush 시점의 dirty 키 수**로 정해진다. 활성 캐릭터, 방, 계좌 수가 자연스러운 상한이 된다(키당 1건).

#### `characters` 전체 문서 스냅샷 계약

**`characters` 컬렉션의 모든 `markDirty` 호출은 전체 문서 스냅샷을 넘긴다.** LWW는 병합이 아니라 **교체**다. 그래서 호출처마다 서로 다른 부분 스냅샷을 넣으면 나중 mark가 앞선 mark의 필드를 통째로 밀어낸다. 예를 들어 연마로 오른 레벨·경험치·차감된 gold가 뒤이은 `{currentRoom}` mark 하나 때문에 flush 주기(기본 120초) 동안 모두 사라진다. 모든 호출처가 같은 전체 문서 형태를 넣으면 coalescing을 해도 잃는 것이 없다.

이 계약은 관례가 아니라 **구조로 강제한다**. `markCharacterDirty(id: string, character: Character)`(`world/markCharacterDirty.ts`)가 유일한 라이브 진입점이다. `{currentRoom: …}` 같은 부분 리터럴은 `Character`가 아니므로 컴파일 단계에서 거부된다. 현재 이 헬퍼를 쓰는 라이브 경로는 세 곳(move 핸들러, 세션 lifecycle 어댑터, `TrainDeps`)이다.

- **강제 범위(과대 주장 금지)**: 아래 단계의 원시 seam `SaveEngine.markDirty(collection, id, snapshot: unknown)`은 여전히 열려 있다. `progression/regen.ts`가 이것을 직접 쓰지만 라이브 호출부가 0건이라 동작하지 않는다(dormant). 따라서 계약은 "이 헬퍼를 거치는 코드"에서만 타입으로 강제된다. `characters` 쓰기를 추가할 때는 이 헬퍼를 거친다.
- **복사 깊이**: 스냅샷은 참조 그대로 보관되므로, 별칭이 남아 있으면 flush가 mark 시점이 아니라 소비 시점의 상태를 쓴다. 스냅샷은 flush 주기가 아니라 **변이할 때마다**(이동, 연마, 세션 종료 때 각 1회) 만들어지므로 재귀 복제는 비용이 너무 크다. 그래서 **변이 가능한 컨테이너까지만** 참조를 끊는다.
  - top-level 얕은 spread
  - 배열 필드 `stats`·`spells`·`realm`(원소가 number라 1단으로 충분)
  - 객체 필드 `buffs`·`statusEffects`는 컨테이너와 **각 엔트리 객체까지** 복사한다. 엔트리가 만료 타이머라 in-place로 갱신될 수 있기 때문이다.
  - `deletedAt`(Date)은 참조 그대로 둔다(라이브가 in-place로 바꾸지 않는다).

  `statusEffects`는 효과마다 값 형태가 다르다(poison/disease에는 `interval`이 있고, blind/silence/fear에는 없다). 그래서 인덱스로 순회하면 타입이 좁혀지지 않으므로 **키별 복사기 목록**(`STATUS_EFFECT_COPIERS`)으로 나눈다. 이 리터럴은 `satisfies Record<StatusEffectName, …>`로 **빠짐없이 다뤘는지 컴파일 단계에서 강제**한다. 스키마에 효과가 추가되면 여기서 누락 프로퍼티 에러가 나므로, 스냅샷에서 조용히 빠지는 일(=stale write)이 다시 생기지 않는다. `silence`·`fear`를 추가할 때 이 강제가 실제로 누락을 잡았다([character-flags.md](character-flags.md)).
- **`status`는 싣지 않는다**: 스냅샷 형태는 `Omit<Character, 'status'>`다. `status`는 soft-delete 경로(`characterRepository.softDelete`)만 쓰는 권한 필드다. 라이브 스냅샷이 이 필드를 실으면 스키마 default `'active'`가 LWW로 **삭제된 캐릭터를 되살린다**. 즉 형제 세션이 삭제한 캐릭터를 뒤이은 이동·종료 flush가 `$set {status:'active'}`로 복구하고, 그 캐릭터가 `findByAccount`의 `status:{$ne:'deleted'}` 필터를 다시 통과한다. 이 계약이 막으려는 write-loss와 정확히 반대 방향의 문제라서 이 키를 뺀다. `characterRepository`의 `status.removeDefault()` 방어와 같은 목적이다. 짝인 `deletedAt`은 빼지 않는다. 라이브 객체에 없으면 키가 `$set`에 실리지 않아 저장된 값이 보존되므로 되돌릴 수 없기 때문이다. 제외 규칙의 대상은 "라이브가 소유하지 않으면서, **실리면 권한 경로의 write를 되돌리는** 필드"이며, 현재 해당하는 것은 `status` 하나다.
- **optional 키 형태 보존**: 스냅샷은 `updateById` patch로 `$set`에 실린다. 그래서 원본에 없는 키를 `undefined`로 만들면 문서 형태가 바뀐다. `buffs`·`statusEffects`는 값이 있을 때만 대입하고, 엔트리 값이 `undefined`인 키도 만들지 않는다.
- **함께 실리는 필드 주의**: 부분 스냅샷과 달리 `schemaVersion`도 flush마다 `$set`된다. 라이브 캐릭터는 load할 때 backfill로 최신 버전이 돼 있다. 따라서 첫 flush가 구버전으로 저장된 문서를 영구히 최신 버전으로 올린다(migration-on-save).

`SaveEngine`은 이미 전체 문서 스냅샷을 전제로 한다. `stripImmutableId`가 `_id`를 벗겨 `$set` immutable-`_id` 에러를 막는다. `roomStates`는 원래 전체 스냅샷 계약이라 영향이 없다.

### SaveScheduler

주입된 `SchedulerClock`(`setInterval`/`clearInterval` seam)으로 주기 flush를 실행한다(기본 `DEFAULT_INTERVAL_MS`=120초). `SchedulerClock`·`IntervalHandle`·`defaultClock`의 정의는 `util/clock.ts`가 단일 출처이고, saveScheduler는 이를 import한다(heartbeat, WorldClock과 같은 seam을 공유). 테스트는 이 clock seam에 FakeClock을 주입해 tick을 수동으로 실행한다.

- `flush()`: `DirtyTracker.checkout()`(주입 구조 계약 `DirtyCheckoutSource`)으로 이미 coalesce된 배열을 얻는다. 그리고 각 항목을 AsyncWriteQueue에 **동기 burst**로 enqueue한다. 각 enqueue 사이에 await로 양보하지 않고 `Promise.all`로 완료를 기다린다. 큐의 "coalescing은 동기 burst에서만 성립한다"는 계약을 지키기 위해서다. 빈 배치는 no-op이다.
- `start()`/`stop()`: interval을 걸고 해제한다. 이미 실행 중이면 다시 걸지 않는다.
- **re-entrancy**: `flushing` 플래그가 interval(`onTick`) 경로에서 flush가 겹치는 것을 막는다. 직접 `flush()`를 호출하는 경우(shutdown이 사용)는 플래그를 확인하거나 설정하지 않고 항상 허용한다. 정합성은 `checkout()`이 registry에 대해 원자적·파괴적으로 동작한다는 점이 보장한다(동시 flush는 서로 겹치지 않는 집합을 가져간다).
- `onTick`은 flush rejection을 catch해 logger로 기록한다. logger 자체가 throw해도 `.catch(() => {})`가 백그라운드 tick의 unhandled rejection을 막는다(오래 떠 있는 서버 보호).

### AsyncWriteQueue

bounded 큐와 비동기 워커가 Mongo write를 게임 틱과 분리해 처리한다. 기본값은 `DEFAULT_CAPACITY`=1024, `MAX_RETRIES`=3, base backoff 50ms다.

- **coalescing**: pending을 `Map<"collection:id", DirtyEntry>`로 관리해 같은 키가 다시 enqueue되면 최신 값 하나로 합친다(크기 증가 억제, FIFO 보존). 워커 시작을 microtask로 미뤄 동기 burst가 pending에 먼저 쌓이게 한다.
- **capacity backpressure(pending 기준)**: coalescing 후에도 pending이 capacity 이상이고 새 키라면 `enqueue`가 공간이 생길 때까지 await(block)한다. 워커가 항목을 in-flight로 가져갈 때(take) 슬롯 1개를 비우고 대기자 하나를 깨운다.
- **재시도 분류**:
  - `DocumentNotFoundError`(matched=0)와 `ZodError`(스키마 위반)는 permanent다. 재시도해도 성공할 수 없으므로 재시도 없이 logger에 기록하고 폐기한다.
  - 그 외(네트워크, 일시 실패)는 transient다. `MAX_RETRIES`회까지 지수 backoff로 재시도하고, 성공하지 못하면 폐기하고 기록한다.
  - 워커는 어떤 경로에서도 throw하지 않으므로 job 하나가 실패해도 루프가 죽지 않는다(per-job try/catch와 주입 sleep seam).
- **collection dispatch**: `Object.hasOwn` 가드로 어댑터를 찾는다(prototype 키를 어댑터로 착각하는 것을 막음). 어댑터가 없는 collection은 폐기하고 기록한다.
- **`evict(collection, id)`**: 지정한 키를 write 경로에서 뺀다. pending에 있으면 지우고 capacity 대기자 하나를 깨운다(그대로 두면 deadlock이 생길 수 있다). 이미 in-flight면 그 write가 끝날 때까지 await한다. `SaveEngine.saveNow`가 즉시 write 직전에 이를 호출한다. 그래서 큐에 남은 stale write가 최신 저장을 덮어쓰는 일을 pending과 in-flight 양쪽에서 막는다.
- **종결 통지(`onSettled`)**: **워커가 dispatch한** job은 성공(`acked`)이든 폐기(`discarded`)든 끝나면 정확히 1회 통지된다. "write가 언제 끝났는가"는 큐만 알기 때문에, 이 통지가 없으면 tracker의 스냅샷 수명 계약이 성립하지 않는다. `SaveEngine`이 이 seam을 `tracker.ack`/`discard`에 연결한다.
  - 결과를 확정하지 못한 경로(주입한 `logger`·`sleep`이 throw)는 보수적으로 `discarded`로 처리한다. 성공을 확인하지 못했는데 `acked`로 통지하면, 아직 영속되지 않은 스냅샷이 소유자에게서 사라지기 때문이다.
  - dispatch까지 가지 않는 두 경로는 통지가 **없다**(의도한 설계). 하나는 `evict`가 pending에서 취소한 job이다. 호출자가 `tracker.evict`를 먼저 부르므로 소비자 상태는 이미 정리돼 있다. 다른 하나는 같은 키가 다시 enqueue되면서 coalescing으로 밀려난 이전 스냅샷이다. 다음 `checkout`이 그 키를 새 엔트리로 덮으므로 참조 동일성 규칙상 문제가 없다. 따라서 통지 수를 세어 끝나지 않은 job을 추적하는 refcount 용도로는 쓸 수 없다.
  - 통지 처리기가 throw하면 워커 루프를 지키기 위해 삼키지만, **logger에는 남긴다**(흔적 없이 버리지 않음). 통지가 실패한 엔트리는 반납되지 않고 `inProgress`에 남는다. 이것은 안전한 실패다. 남은 스냅샷이 방금 write된 값과 같아 hydrate 결과가 DB와 일치하고, 같은 키의 다음 `checkout`이 덮어쓰면서 해소되기 때문이다.
- `drain()`: pending, in-flight, 활성 워커가 모두 끝날 때까지 await한다(shutdown이 사용).

### 이벤트 즉시 저장 (SaveEngine.saveNow)

`saveNow(collection, id, snapshot, reason)`는 주기 버퍼를 거치지 않고 바로 repository write를 하고 **await**한다(fire-and-forget 금지: 반환 시점에 문서가 실제로 갱신돼 있다). 레벨업이나 로그아웃처럼 다시 만들 수 없는 중요한 이벤트에 쓴다.

- **id 가드**: `id`가 비어 있지 않은 문자열인지 검증한다(`assertSaveId`). id가 Mongo `_id` 필터에 들어가므로, 객체가 들어와 연산자가 주입되는 것(`{$ne:...}`)을 진입점에서 막는다.
- **evict-before-write(2계층)**: write 직전에 두 evict를 모두 수행한다.
  - `DirtyTracker.evict`: 아직 flush되지 않은 stale mark를 registry와 inProgress 양쪽에서 지운다.
  - `AsyncWriteQueue.evict`: 이미 flush돼 pending/in-flight 상태인 stale write를 취소하거나 끝나기를 기다린다.

  이 두 계층의 evict로, stale 스냅샷이 즉시 저장을 나중에 덮어쓰는 write-loss를 막는다.
- ⚠ **막지 못하는 세 번째 상태**: `SaveScheduler.flush()`가 `checkout()`한 뒤 `enqueue`에서 capacity backpressure로 막혀 있는 동안의 엔트리가 문제다. 이 엔트리는 tracker의 `inProgress`에는 있지만 큐의 `pending`에는 아직 없어서 **어느 evict에도 보이지 않는다**. 막힘이 풀리면 stale 엔트리가 늦게 enqueue되어 `saveNow`의 최신 write를 덮을 수 있다. `saveNow`의 프로덕션 호출자가 0건이라 지금은 이 문제가 드러나는 경로가 없고, 현상은 `asyncWriteQueue.ts`·`saveEngine.ts` 주석에 적어 두었다. 첫 호출자를 붙이는 토픽이 구조적으로 해결한다. 방법은 스케줄러가 checkout은 끝났지만 enqueue가 수락되지 않은 집합을 노출하거나, flush가 evict를 인식하게 만드는 것이다.
- **fail-loud**: write가 실패하면 다시 markDirty하지 않고 rethrow하며, `reason`을 실패 로그에 담는다. 알 수 없는 collection은 `hasOwn` 가드로 걸러 logger에 기록하고 no-op으로 끝낸다.

### 미영속 스냅샷 조회 (SaveEngine.peekPending)

`peekPending(collection, id): unknown`은 아직 영속되지 않은 스냅샷을 **비파괴적으로** 돌려준다(#124). 재접속 hydrate는 이 함수 하나만 거치며, 판정은 `tracker.peek` 한 곳에서 한다. 미착수(`registry`)든 write 진행 중(`inProgress`)이든 같은 값이 나온다.

- **`undefined`의 의미**: "그 키의 미영속 스냅샷이 없다"는 뜻이고, 수명 계약에 따라 **저장소 문서가 최신**이라는 뜻이다. 조회하는 쪽은 DB에서 읽은 값을 그대로 쓰면 된다. 다만 `discard`로 폐기된 스냅샷도 여기에 해당하므로(§제약사항의 write 영구 실패), 이 등식은 보장 범위 안에서만 성립한다.
- **정규화는 seam이 담당한다**: 반환하기 전에 영속 경로와 **같은 비공개 `stripImmutableId`**를 적용한다. 그래서 반환값이 "flush가 `$set`할 값"과 글자 그대로 같고, 함수를 export할 필요도 없다(둘 다 `saveEngine.ts` 안에 있다).
- **이 등식은 patch 컬렉션에만 해당한다**: 영속 경로에서 같은 정규화를 거치는 것은 `characters`·`bankAccounts`뿐이다. `roomStates`는 어댑터가 스냅샷을 벗기지 않고 통째로 upsert하고, `objectDeletions`는 스냅샷을 아예 쓰지 않는다(id만으로 삭제). 그러므로 이 둘은 반환값을 그대로 쓰면 안 된다.
- **반환값은 라이브 참조일 수 있다**: `_id`가 없는 스냅샷은 그대로 돌려준다. 이를 mutate하면 앞으로 영속될 스냅샷이 오염된다. tracker의 "참조 그대로 보관하고 복제하지 않는다" 계약과 짝을 이룬다.
- **반환 타입은 `unknown`이다**: save 계층은 collection을 모르고(agnostic), 소비자가 어차피 자기 스키마로 런타임 검증을 한다. 그래서 검증되지 않은 컴파일 타임 단언을 seam에 붙이지 않는다.
- **`onSettled`는 호출자에게 열지 않는다**: `SaveEngineOptions.queueOptions`는 `Omit<AsyncWriteQueueOptions, 'onSettled'>`다. 엔진이 그 seam으로 tracker 반납을 연결한다. 호출자 값이 들어오면 반납이 실행되지 않아 스냅샷이 `inProgress`에 영원히 남는데, 이 고장은 예외도 로그도 남기지 않는다. 연결 코드를 스프레드 뒤에 둬서 순서로도 한 번 더 막는다.

### collection dispatch 어댑터

즉시 경로와 주기 경로가 함께 쓰는 dispatch 맵 하나가 collection별 write 방식을 정한다.

- `characters`·`bankAccounts` → `repo.updateById(id, patch)`. patch는 스냅샷에서 불변 `_id`를 벗겨 넘긴다(`stripImmutableId`). 호출자가 전체 문서 스냅샷을 넘겨도 `$set`에 `_id`가 실려 Mongo immutable 에러가 나는 것을 막는다.
- `roomStates` → `WorldRepository.upsert(snapshot)`. upsert가 `snapshot.roomId`로 키를 정하므로 id 인자는 무시한다. 전체 `RoomState`가 필요하므로 `_id`를 벗기지 않는다.
- `objectDeletions` → `ObjectRepository.deleteById(id)`(#120). 유일한 **삭제** 어댑터이며, 지울 문서에 실을 상태가 없으므로 스냅샷은 무시하고 id만 쓴다. 이미 없는 문서에 대한 `DocumentNotFoundError`는 **permanent 실패로 분류해 재시도 없이 폐기한다**(삭제는 멱등이라 재시도해도 결과가 바뀌지 않는다). collection 이름을 `objects`가 아니라 `objectDeletions`로 둔 것은 의도적이다. 나중에 같은 collection에 갱신 어댑터가 붙을 때 두 의미가 키 하나를 두고 다투지 않게 하기 위해서다.

**두 write의 순서 계약(#120)**: 비법서 연마는 `characters`(주문 학습)와 `objectDeletions`(책 소멸) 두 write를 만든다. 호출부는 `markCharacterDirty`를 **먼저**, `markObjectDeleted`를 **나중에** 호출한다. `DirtyTracker`가 삽입 순서를 지키고 `AsyncWriteQueue`가 단일 워커 FIFO이므로, 이 호출 순서가 곧 write 시도 순서다.

재시도가 소진돼 한쪽만 영속된 경우에도 **보상 트랜잭션을 만들지 않는다**. 손실 방향이 비대칭이기 때문이다.
- 삭제만 실패한 경우(책은 남고 주문은 학습됨): `setKnown`이 멱등이라 다시 연마해도 결과가 같고, 그 연마가 삭제를 다시 마킹하므로 저절로 맞춰진다.
- `characters`만 실패한 경우(책은 사라지고 주문은 학습 안 됨): 이것이 유일한 실제 손실이다. 그래서 순서를 고정해 이 방향이 드러나는 시간을 줄인다.
- 두 write가 함께 실패하는 흔한 경우(Mongo 장애)는 그 자체로 일관된 상태다.

이 결정을 #43(은행 트랜잭션)과 묶지 않는다. 실패 모델이 다르기 때문이다. 은행은 금전 이중 지불 문제라 스스로 회복할 수단이 없지만, 여기는 재연마의 멱등성이 회복을 제공한다. 여러 컬렉션에 걸친 원자성을 일반적으로 해결해야 할 때(Mongo 트랜잭션 세션 도입)는 #43이 담당한다. 다만 **순서 고정이 막는 것은 두 write 사이에 프로세스가 죽는 경우뿐**이다. `characters` write가 영구 실패해도 큐는 job별로 격리돼 계속 진행하므로 삭제는 그대로 실행된다.

### 은행/금화 트랜잭션 (BankTransactionService)

캐릭터↔은행 gold 이동을 2-문서 원자적 트랜잭션으로 수행한다. 생성자로 `MongoClient`·`Db`를 주입받는다. 입출금은 `session.withTransaction`(Convenient API, 일시적 에러 재시도 내장)으로 감싸 일부만 커밋되는 일을 막는다.

- **입력 가드**: 트랜잭션을 시작하기 전에 `amount`가 양의 정수인지(`assertPositiveIntAmount`), `characterId`·`bankAccountId`가 비어 있지 않은 문자열인지(`assertDocumentId`) 검증한다. 이 서비스는 repo 계층의 Zod 경계를 거치지 않으므로, 돈이 움직이는 진입점에서 id 형태를 직접 강제한다(NoSQL 연산자 주입 차단).
- **입금**: 두 단계로 진행한다. 어느 단계든 매칭이 0이면 콜백이 throw하고 트랜잭션이 abort된다.
  1. `characters.findOneAndUpdate({_id, gold:{$gte:amt}}, {$inc:{gold:-amt}})`. 잔액이 부족하거나 문서가 없으면 매칭0 → `InsufficientFundsError`.
  2. `bankAccounts.findOneAndUpdate({_id, gold:{$lte: MAX_BANK_GOLD-amt}}, {$inc:{gold:amt}})`. 상한을 넘거나 문서가 없으면 매칭0 → `BankCapExceededError`.
- **출금**: 방향만 반대다. bank 차감(`$gte`)에는 같은 가드를 걸고, character 가산에는 상한을 두지 않는다(§제약사항 Open Q). character가 없으면 `DocumentNotFoundError`.
- **잔액·상한 가드는 조건부 필터로 하는 원자적 CAS다**: read-modify-write race 없이 잔액이 음수가 되지 않게 하고 은행 3억 상한(불변식 6, `MAX_BANK_GOLD`가 단일 출처)을 지킨다. 둘 다 커밋되거나 아무것도 커밋되지 않는다.

### 부팅 조립·graceful shutdown (index.ts)

부팅 시 `SaveEngine(characters, bank, world, saveLogger)`를 조립하고 `start()`한다. `saveLogger`는 fastify `app.log.error`에 위임하는 어댑터다(console 금지). `SIGTERM`/`SIGINT` 핸들러는 `saveEngine.shutdown()` → `conn.close()` 순으로 실행하며, Promise를 캐시해 두므로 시그널이 중복돼도 결과가 같다(idempotent). `shutdown()`은 다음 순서로 종료 전 유실을 막는다: (1) scheduler 정지, (2) 남은 dirty 강제 flush, (3) queue drain. drain에는 타임아웃이 없다. bounded 큐라 언젠가 끝나고, 일부를 잃는 것보다 끝까지 처리하는 것이 우선이기 때문이다.

## 제약사항

- **세이브 호출처는 일부만 연결됐다**: 라이브 이동, 연마, 세션 종료는 `markCharacterDirty`를 거쳐 실제로 dirty를 마킹한다. 나머지(거래, 전투 등 E6의 남은 부분)에서 `markDirty`/`saveNow`를 부르는 일은 각 연결 토픽이 담당한다.
- **#43이 해결될 때까지 은행 명령 연결은 막혀 있다(blocking)**:
  - `BankTransactionService`는 gold를 트랜잭션으로 직접 쓰고, `SaveEngine`은 같은 컬렉션을 write-behind로 쓴다. 두 경로 사이에 키별로 조정하는 지점이 없다. 그래서 gold 엔티티를 두 경로로 흘리면 트랜잭션 커밋 뒤에 도착한 stale flush가 결과를 되돌릴 수 있다.
  - **`progress:train` 연결로 gold가 write-behind 경로에 들어왔다**(연마 비용 차감이 전체 문서 스냅샷에 실린다). 즉 한쪽 경로는 이미 동작 중이다. 충돌할 상대인 은행 직접 write는 아직 동작하지 않으므로(`clientCommandSchema`에 은행 명령 없음, `BankTransactionService`의 non-test caller 0건) 지금은 충돌이 일어날 수 없다.
  - 그래서 계약을 고정한다: **#43을 해결하기 전에는 은행 명령을 연결하지 않는다.** 해결 방향은 둘 중 하나다. (a) 트랜잭션 전후로 두 키를 SaveEngine에서 evict/quiesce한 뒤 다시 mark한다. (b) gold 변이를 write-behind 밖에 둬서 권위 있는 경로를 하나로 유지한다([smalljiny/muhan#43](https://github.com/smalljiny/muhan/issues/43), 코드 계약은 `bankTransactionService.ts` 도크스트링).
- **재접속 pending revert는 `characters`에서만 해결됐다(#124)**: hydrate가 `peekPending('characters', id)`를 DB 문서 위에 덮어쓴다(overlay). 보장 문장은 "pending이 `DirtyTracker`에 살아 있는 동안 hydrate가 그것을 채택한다"이고, 수명 계약이 그 "살아 있는 동안"을 정의한다. **`objectDeletions`는 합성하지 않는다.** 그래서 재접속하면 삭제 마킹된 비법서가 인벤토리에 유령처럼 남는다. 지금은 해가 없다. 재연마 시 `setKnown`·`markObjectDeleted`가 모두 멱등이라 결국 맞춰지고, 줍기·버리기·건네주기 경로가 0건이기 때문이다. #119(teach)와 #121(attack)이 건네주기와 전리품 경로를 열면 다시 평가해야 한다.
- **write가 영구 실패한 스냅샷은 복구하지 않는다**: permanent 실패나 재시도 소진이면 `discard`로 버린다. 그 뒤 그 키의 `peekPending`은 `undefined`가 되어 hydrate가 저장소 값을 쓴다(진행도 손실). 복구하려면 WAL 수준의 영속 큐가 필요하므로, write-behind 손실 모델(아래 Durable WAL 없음)이 이미 받아들인 범위다. 실패는 logger로 확인할 수 있다.
- **`character.gold`에는 상한이 없다**: 은행 gold는 3억 상한(불변식 6)이 있지만 출금으로 늘어나는 `character.gold`에는 상한을 두지 않는다. 원작 오라클에 소지 gold 상한이 있는지 다시 확인해 확정되면 이 seam에 같은 가드를 추가한다(persistence.md §제약사항의 미결 항목과 연동).
- **flush 트리거는 interval만 쓴다**: 시간 간격만 쓰고, dirty 건수 임계값으로 함께 트리거하는 방식은 두지 않는다. 기본 120초로 시작하며 정확한 값은 후속 부하 테스트로 정한다.
- **Durable WAL 없음**: write-behind 경로는 받아들인 손실 구간이 있다(돈은 트랜잭션이라 손실 없음). 동기 write-ahead log는 만들지 않는다.
- **repository 필터 인자 미검증은 E2-1부터 남은 문제다**: `BankTransactionService`·`saveNow`는 돈과 세이브 진입점에서 id 가드를 직접 추가했다. 하지만 E2-1 repository 계층 자체의 `{_id:id}` 필터는 여전히 런타임에 검증하지 않는다(persistence.md §제약사항). route 경계를 연결할 때(E5) 통합 검증이 필요하다.
- **테스트 하네스는 단일노드 replica set이다**: `withTransaction`은 replica set에서만 동작하므로 `mongoTestDb.testutil.ts`가 `MongoMemoryReplSet.create({ replSet: { count: 1 } })`를 쓴다(프로덕션 Atlas는 이미 replica set). 각 컴포넌트는 주입 seam(FakeClock, 즉시 sleep, mock 어댑터)으로 unit 테스트를 하고, 트랜잭션·큐 통합은 in-memory replset으로 실행한다.
