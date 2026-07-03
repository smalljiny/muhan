# 세이브 정책 엔진 (E2-2)

> 인메모리 권위 상태를 MongoDB에 영속화하는 행위 계층 — dirty-flag 주기 flush + 비동기 배치 write-behind, 이벤트 즉시 저장(`saveNow`), 은행 gold 이동의 원자적 트랜잭션.

## 개요

[`persistence.md`](persistence.md)(E2-1)가 세운 연결·문서 스키마·repository 위에서 **세이브가 언제·어떻게 일어나는가**를 담당한다. ADR([`architecture.md`](architecture.md) §3.4 D2)의 "DB-네이티브 세이브 신규 설계" 결정을 구현한다 — 원작 오라클의 이벤트-only 세이브 타이밍(주기 자동세이브 없음)을 유지하되, 크래시 내성을 위해 짧은 주기 flush를 더한다.

두 저장 경로가 명확히 갈린다.

| 경로 | 대상 | 메커니즘 | 손실 모델 |
|------|------|----------|----------|
| **write-behind(주기)** | 고빈도 연속 상태 — 캐릭터 진행·재생·위치, 방 문·리스폰 타임스탬프 | `markDirty` → 주기 flush → 비동기 upsert | 크래시 시 최대 flush 간격만큼 손실(수용) |
| **동기 즉시** | 치명 이벤트(레벨업·로그아웃), **돈(은행·금화)** | `saveNow`(await) / `BankTransactionService`(트랜잭션) | 손실 없음 |

**메커니즘만** 제공한다 — 게임플레이 호출처(레벨업·거래·로그아웃에서의 `markDirty`/`saveNow` 호출)는 후속 에픽 범위이며, 각 컴포넌트는 테스트로 격리 구동한다(§제약사항).

## 구조 / 스키마

세이브 엔진은 `packages/server/src/save/`(신규)에 위치하고, 은행 트랜잭션 서비스는 `packages/server/src/bank/`에 있다. E2-1 repository를 생성자 주입으로 소비하며, 부팅 시 `index.ts`가 `SaveEngine` 응집 객체로 조립한다.

```
SaveEngine (부팅 조립, index.ts)
├── DirtyTracker         side registry: Map<"collection:id", {collection,id,snapshot}>
├── SaveScheduler        주입 clock, 주기 flush(기본 120s) → tracker drain → queue enqueue
├── AsyncWriteQueue      bounded, coalescing, 재시도 분류, in-flight evict seam, 비동기 워커
├── dispatch adapter     collection별 write 매핑(characters·bankAccounts→updateById, roomStates→upsert)
└── shutdown()           scheduler 정지 → 강제 flush → queue drain

BankTransactionService (bank/, index.ts와 독립 조립)
                        withTransaction 2-문서 CAS 입출금 + gold 가드
```

| 파일 | 역할 |
|------|------|
| `save/dirtyTracker.ts` | 변경 엔티티 side registry(coalescing, drain/evict) |
| `save/saveScheduler.ts` | 주입 clock 주기 flush, re-entrancy 방어 |
| `save/asyncWriteQueue.ts` | bounded 비동기 write 큐(재시도 분류·backpressure·evict) |
| `save/saveEngine.ts` | 위 셋 조립 + `markDirty`·`saveNow`·`start`·`shutdown` seam |
| `save/logger.ts` | 공용 `SaveLogger` seam(console 금지) + `NOOP_LOGGER` |
| `bank/bankTransactionService.ts` | 은행 gold 이동 원자적 트랜잭션 |
| `repo/mongoTestDb.testutil.ts` | 통합 테스트 하네스(단일노드 replica set) |

## 동작

### DirtyTracker

`markDirty(collection, id, snapshot)`가 side registry `Map<"collection:id", {collection, id, snapshot}>`에 최신 스냅샷을 기록한다. 같은 키 재호출은 이전 스냅샷을 덮어써 **coalescing(last-write-wins)**을 이룬다 — 한 flush 주기 내 HP가 10번 바뀌어도 upsert 1회. 도메인 객체에 `.dirty` 필드를 심지 않고 외부 레지스트리로 분리해 불변성 규칙(coding-style.md)을 지킨다.

- `drain()` — 현재 registry 전체를 배열로 반환하고 registry를 비운다(파괴적·원자적, Node 단일 스레드). 스케줄러·shutdown이 소비한다.
- `evict(collection, id)` — 단일 키만 제거(없으면 no-op). `saveNow`가 즉시 write 직전에 호출해 stale mark를 제거한다.
- 스냅샷 타입은 컬렉션별 문서 형태가 달라 `unknown`으로 받고 **참조 그대로 보관**(복제 안 함)한다. 호출 계약: 라이브 도메인 객체 참조가 아니라 **그 시점의 스냅샷**을 넘긴다(라이브 참조는 coalescing을 무의미화).

### SaveScheduler

주입된 `SchedulerClock`(`setInterval`/`clearInterval` seam)으로 주기 flush를 구동한다(기본 `DEFAULT_INTERVAL_MS`=120초). clock seam으로 테스트는 FakeClock을 주입해 tick을 수동 구동하고, E3 heartbeat 도입 시 clock을 교체한다.

- `flush()` — `DirtyTracker.drain()`으로 이미 coalesce된 배열을 얻어, 각 항목을 AsyncWriteQueue에 **동기 burst**로 enqueue한다(각 enqueue 사이 await로 yield하지 않고 `Promise.all`로 완료 대기 — 큐의 "coalescing은 동기 burst에서만 성립" 계약 준수). 빈 배치는 no-op.
- `start()`/`stop()` — interval을 걸고 해제한다. 이미 실행 중이면 재-arm하지 않는다.
- **re-entrancy**: `flushing` 플래그가 interval(`onTick`) 경로의 중복 flush를 막는다. 직접 `flush()` 호출(shutdown이 사용)은 플래그를 확인·설정하지 않고 항상 허용된다 — 정합성은 `drain()`의 원자적·파괴적 특성이 보장한다(동시 flush는 서로소 집합을 drain).
- `onTick`은 flush rejection을 catch해 logger로 기록하며, logger 자체가 throw해도 `.catch(() => {})`로 백그라운드 tick의 unhandled rejection을 막는다(장수 서버 보호).

### AsyncWriteQueue

bounded 큐 + 비동기 워커가 Mongo write를 게임 틱과 분리해 drain한다. 기본값 `DEFAULT_CAPACITY`=1024, `MAX_RETRIES`=3, base backoff 50ms.

- **coalescing** — pending을 `Map<"collection:id", DirtyEntry>`로 관리해 같은 키 재-enqueue를 최신값으로 dedup(성장 억제, FIFO 보존). 워커 시작을 microtask로 지연해 동기 burst가 pending에 먼저 쌓이게 한다.
- **capacity backpressure(pending-only)** — coalescing 후에도 pending이 capacity 이상이고 새 키면 `enqueue`가 공간이 생길 때까지 await(block)한다. 워커가 항목을 in-flight로 가져갈 때(take) 슬롯 1개를 비우고 대기자 하나를 깨운다.
- **재시도 분류** — `DocumentNotFoundError`(matched=0)·`ZodError`(스키마 위반)는 permanent로 재시도 없이 logger 기록 후 폐기(재시도해도 성공 못 함). 그 외(네트워크·일시 실패)는 transient로 `MAX_RETRIES`회 지수 backoff 재시도 후 성공하거나 폐기·기록. 워커는 어떤 경로에서도 throw하지 않아 한 job 실패가 루프를 죽이지 않는다(per-job try/catch + 주입 sleep seam).
- **collection dispatch** — `Object.hasOwn` 가드로 어댑터를 조회한다(prototype 키 오인 차단). 어댑터 없는 collection은 폐기·기록.
- **`evict(collection, id)`** — 지정 키를 write 경로에서 제거한다: pending에 있으면 삭제하고 capacity 대기자 하나를 깨우며(방치 시 deadlock 방지), 이미 in-flight면 그 write 완료를 await한다. `SaveEngine.saveNow`가 즉시 write 직전에 호출해 stale 큐 write가 최신 저장을 덮어쓰는 것을 pending·in-flight 양쪽에서 봉쇄한다.
- `drain()` — pending·in-flight·활성 워커가 모두 끝날 때까지 await한다(shutdown 소비).

### 이벤트 즉시 저장 (SaveEngine.saveNow)

`saveNow(collection, id, snapshot, reason)`는 주기 버퍼를 우회해 즉시 repository write를 수행하고 **await**한다(fire-and-forget 금지 — 반환 시점에 문서가 실제 갱신됨). 레벨업·로그아웃 등 재구성 불가·치명 이벤트용.

- **id 가드** — `id`가 비어 있지 않은 문자열인지 검증한다(`assertSaveId`). id가 Mongo `_id` 필터에 실리므로 객체 유입 시 연산자 주입(`{$ne:...}`)을 진입점에서 차단한다.
- **evict-before-write(2계층)** — write 직전에 `DirtyTracker.evict`(아직 flush 안 된 stale mark 제거)와 `AsyncWriteQueue.evict`(이미 flush돼 pending/in-flight인 stale write 취소·완료 대기)를 모두 수행한다. 두 계층 evict로 stale 스냅샷이 즉시 저장을 나중에 덮어쓰는 write-loss를 구조적으로 봉쇄한다.
- **fail-loud** — write 실패는 재-markDirty 없이 rethrow하며 `reason`을 실패 로그에 담는다. 알 수 없는 collection은 `hasOwn` 가드로 걸러 logger 기록 후 no-op.

### collection dispatch 어댑터

즉시·주기 경로가 공유하는 단일 dispatch 맵이 collection별 write를 결정한다.

- `characters`·`bankAccounts` → `repo.updateById(id, patch)`. patch는 스냅샷에서 불변 `_id`를 벗겨 넘긴다(`stripImmutableId`) — 호출자가 전체 문서 스냅샷을 넘겨도 `$set`에 `_id`가 실려 Mongo immutable 에러가 나는 것을 막는다.
- `roomStates` → `WorldRepository.upsert(snapshot)`. upsert가 `snapshot.roomId`로 키를 결정하므로 id 인자를 무시한다. 전체 `RoomState`를 요구하므로 `_id`를 벗기지 않는다.

### 은행/금화 트랜잭션 (BankTransactionService)

캐릭터↔은행 gold 이동을 2-문서 원자적 트랜잭션으로 수행한다. 생성자 주입(`MongoClient`·`Db`)이며, 입출금은 `session.withTransaction`(Convenient API, 일시적 에러 재시도 내장)으로 감싸 부분 커밋을 봉쇄한다.

- **입력 가드** — `amount`가 양의 정수(`assertPositiveIntAmount`), `characterId`·`bankAccountId`가 비어 있지 않은 문자열(`assertDocumentId`)인지 트랜잭션 시작 전 검증한다. 이 서비스는 repo 계층 Zod 경계를 우회하므로 money 이동 진입점에서 id 형태를 직접 강제한다(NoSQL 연산자 주입 차단).
- **입금** — `characters.findOneAndUpdate({_id, gold:{$gte:amt}}, {$inc:{gold:-amt}})`(잔액 부족·부재 시 매칭0 → `InsufficientFundsError`) → `bankAccounts.findOneAndUpdate({_id, gold:{$lte: MAX_BANK_GOLD-amt}}, {$inc:{gold:amt}})`(상한 초과·부재 시 매칭0 → `BankCapExceededError`). 매칭0이면 콜백 throw → 트랜잭션 abort.
- **출금** — 반대 방향. bank 차감(`$gte`)은 대칭 가드, character 가산은 상한 미부과(§제약사항 Open Q). character 부재 시 `DocumentNotFoundError`.
- **잔액·상한 가드는 조건부 필터로 원자적 CAS** — read-modify-write race 없이 잔액 비음수와 은행 3억 상한(불변식 6, `MAX_BANK_GOLD` 단일 출처)을 강제한다. 둘 다 커밋되거나 아무것도 커밋되지 않는다.

### 부팅 조립·graceful shutdown (index.ts)

부팅 시 `SaveEngine(characters, bank, world, saveLogger)`를 조립하고 `start()`한다. `saveLogger`는 fastify `app.log.error`에 위임하는 어댑터(console 금지). `SIGTERM`/`SIGINT` 핸들러가 `saveEngine.shutdown()` → `conn.close()` 순으로 실행하며, 캐시된 Promise로 중복 시그널에 idempotent하다. `shutdown()`은 (1) scheduler 정지, (2) 잔여 dirty 강제 flush, (3) queue drain(타임아웃 없음 — bounded 큐라 유계, 부분 유실보다 완주 우선) 순으로 종료 전 유실을 봉쇄한다.

## 제약사항

- **세이브 호출처는 후속 에픽** — 레벨업·거래(E6), 로그아웃(E3/E5), 이동(E4)의 실제 `markDirty`/`saveNow` 호출은 이 토픽에 없다. API와 연결 seam만 전달하고 각 컴포넌트를 테스트로 격리 구동한다(통합 경로 부재는 설계된 경계).
- **은행↔세이브 엔진 쓰기 경로 조정은 caller-wiring 시 필수** — `BankTransactionService`는 gold를 트랜잭션으로 직접 쓰고, `SaveEngine`은 같은 컬렉션을 write-behind로 쓴다. 두 경로 사이에 공유 per-key 조정점이 없어, gold 엔티티를 두 경로로 흘리면 트랜잭션 커밋 후 도착한 stale flush가 결과를 되돌릴 수 있다. 현재는 gold를 dirty로 마킹하는 caller가 없어 도달 불가하나, 배선 시 (a) 트랜잭션 전후 두 키를 SaveEngine에서 evict/quiesce 후 재-mark하거나 (b) gold 변이를 write-behind 밖에 두어 단일 authoritative 경로로 유지해야 한다([smalljiny/muhan#43](https://github.com/smalljiny/muhan/issues/43), 코드 계약은 `bankTransactionService.ts` 도크스트링).
- **`character.gold` 상한 미부과** — 은행 gold는 3억 상한(불변식 6)이지만 출금 크레딧은 `character.gold`에 상한을 두지 않는다. 원작 오라클의 소지 gold 상한 여부를 재확인 후 확정되면 이 seam에 대칭 가드를 추가한다(persistence.md §제약사항 미결 연동).
- **flush 트리거는 interval-only** — 시간 간격만 사용하고 dirty 건수 임계 기반 병행 트리거는 두지 않는다. 기본 120초로 시작하며 정확값은 후속 부하 테스트로 확정.
- **Durable WAL 없음** — write-behind 경로는 수용된 손실 창을 가진다(돈은 트랜잭션으로 손실 없음). 동기 write-ahead log는 만들지 않는다.
- **repository 필터 인자 미검증은 E2-1 잔존** — `BankTransactionService`·`saveNow`는 money·세이브 진입점에서 id 가드를 자체 추가하지만, E2-1 repository 계층 자체의 `{_id:id}` 필터는 여전히 런타임 미검증이다(persistence.md §제약사항). route 경계 배선(E5) 시 통합 검증이 필요하다.
- **테스트 하네스는 단일노드 replica set** — `withTransaction`은 replica set에서만 동작하므로 `mongoTestDb.testutil.ts`가 `MongoMemoryReplSet.create({ replSet: { count: 1 } })`를 쓴다(프로덕션 Atlas는 이미 replica set). 각 컴포넌트는 주입 seam(FakeClock·즉시 sleep·mock 어댑터)으로 unit 구동, 트랜잭션·큐 통합은 in-memory replset으로 구동한다.
