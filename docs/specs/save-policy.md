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
| `save/dirtyTracker.ts` | 변경 엔티티 side registry(coalescing, checkout/ack/discard/peek/evict) + 공용 `dirtyKey` |
| `save/saveScheduler.ts` | 주입 clock 주기 flush, re-entrancy 방어 |
| `save/asyncWriteQueue.ts` | bounded 비동기 write 큐(재시도 분류·backpressure·evict) |
| `save/saveEngine.ts` | 위 셋 조립 + `markDirty`·`peekPending`·`saveNow`·`start`·`shutdown` seam |
| `save/logger.ts` | 공용 `SaveLogger` seam(console 금지) + `NOOP_LOGGER` |
| `bank/bankTransactionService.ts` | 은행 gold 이동 원자적 트랜잭션 |
| `repo/mongoTestDb.testutil.ts` | 통합 테스트 하네스(단일노드 replica set) |
| `repo/characterSchemas.ts` | `characterPatchSchema` 단일 출처(의존 0) — 영속 경로와 hydrate overlay가 공유 |

## 동작

### DirtyTracker

`markDirty(collection, id, snapshot)`가 side registry `Map<"collection:id", {collection, id, snapshot}>`에 최신 스냅샷을 기록한다. 같은 키 재호출은 이전 스냅샷을 덮어써 **coalescing(last-write-wins)**을 이룬다 — 한 flush 주기 내 HP가 10번 바뀌어도 upsert 1회. 도메인 객체에 `.dirty` 필드를 심지 않고 외부 레지스트리로 분리해 불변성 규칙(coding-style.md)을 지킨다.

- `checkout()` — 현재 registry 전체를 배열로 반환하고, **같은 엔트리를 `inProgress`로 이관하며** registry를 비운다. registry에 대해 파괴적·원자적(Node 단일 스레드)이라 동시 flush가 겹쳐도 서로소 집합을 가져간다. 스케줄러·shutdown이 소비한다.
- `ack(entry)` / `discard(entry)` — write 종결을 통지해 `inProgress`에서 소유권을 반납한다. 전자는 write 성공, 후자는 폐기(permanent 실패·재시도 소진·어댑터 미발견)다.
- `peek(collection, id)` — 미영속 스냅샷을 비파괴적으로 조회한다. `registry`를 먼저 보고 없을 때만 `inProgress`를 본다.
- `evict(collection, id)` — 단일 키를 **양쪽 맵에서** 제거(없으면 no-op). `saveNow`가 즉시 write 직전에 호출한다.
- `dirtyKey(collection, id)` — `collection:id` 키 포맷의 단일 출처(export). `AsyncWriteQueue`가 같은 함수를 쓴다 — 두 키가 어긋나면 `saveNow`의 2계층 evict가 절반만 듣는다.
- 스냅샷 타입은 컬렉션별 문서 형태가 달라 `unknown`으로 받고 **참조 그대로 보관**(복제 안 함)한다. 호출 계약: 라이브 도메인 객체 참조가 아니라 **그 시점의 스냅샷**을 넘긴다(라이브 참조는 coalescing을 무의미화).

#### 스냅샷 수명 계약 (2단 소유, #124)

**키별 최신 미영속 스냅샷은 `markDirty`부터 그 스냅샷의 write가 성공(`ack`) 또는 폐기(`discard`)될 때까지 `registry`·`inProgress` 중 정확히 한 곳에 존재한다.** 이 연속성이 재접속 hydrate의 pending overlay가 서는 토대다([live-world-foundation.md](live-world-foundation.md) §진입).

이전의 파괴적 `drain()`은 반출 직후 스냅샷을 tracker에서 지웠고, 그 결과 아래 세 구간에서 스냅샷이 **어느 조회 위치에도 존재하지 않았다**. 조회 지점을 늘려 각 구간을 덮는 방식은 네 번째 사각이 없음을 증명할 수 없어, 소유자를 하나로 만드는 쪽을 택했다.

| 구간 | 이전(drain) | 현재(checkout) |
|---|---|---|
| `markDirty` 이후 | `registry` ✅ | `registry` ✅ |
| 반출 이후 ~ `enqueue` 수락 전 | 없음 ❌ (스케줄러 지역 배열) | `inProgress` ✅ |
| `enqueue` 수락 후 대기 | 큐 `pending`(접근자 없음) ❌ | `inProgress` ✅ |
| write 진행 중 | 없음 ❌ (`pending.delete` 후 in-flight) | `inProgress` ✅ |
| write 성공 이후 | DB ✅ | DB ✅ (`ack`로 반납) |

- **`ack`·`discard`는 키가 아니라 entry를 받는다.** 키와 엔트리가 어긋난 호출은 참조 동일성 검사에서 조용한 no-op이 되어 반납 누락이 무성으로 지나가는데, entry에서 키를 도출하면 그 조합 자체가 표현 불가능해진다.
- **반납은 참조 동일성으로 판정한다.** 키 K가 S1으로 in-flight인 동안 K가 S2로 재-mark되고 다음 `checkout`이 S2를 이관하면, 뒤늦게 도착한 S1의 종결 통지는 no-op이 되어 아직 write되지 않은 S2가 살아남는다.
- **세대별 보관은 하지 않는다.** 불변식의 대상은 "모든 스냅샷"이 아니라 **키별 최신**이다. S1이 S2로 대체되면 S1의 수명은 그 시점에 끝난다 — 어차피 coalescing으로 버려질 값이고, `peek`이 `registry`를 먼저 보므로 조회 결과는 항상 S2다. S1의 write가 뒤늦게 착지해 DB에 구값이 실려도 후속 S2 write가 교정한다.
- **`size`와 `inProgressSize`의 합은 미영속 키 수가 아니다** — checkout 후 재-mark된 키는 두 맵에 동시에 있어 두 번 세어진다. 키 단위 판정은 `peek`으로 한다.
- `inProgress` 크기는 큐 capacity가 아니라 **flush 시점의 dirty 키 수**로 정해진다(활성 캐릭터·방·계좌 수로 자연 상한, 키당 1건).

#### `characters` 전체 문서 스냅샷 계약

**`characters` 컬렉션의 모든 `markDirty` 호출은 전체 문서 스냅샷을 넘긴다.** LWW는 병합이 아니라 **교체**이므로, 호출처마다 서로 다른 부분 스냅샷을 넣으면 나중 mark가 앞선 mark의 필드를 통째로 밀어낸다 — 연마로 오른 레벨·경험치·차감된 gold가 뒤이은 `{currentRoom}` mark 하나에 flush 주기(기본 120초) 동안 통째로 소실된다. 모든 호출처가 같은 전체 문서 형태를 넣으면 coalescing이 손실 없이 성립한다.

계약을 관례가 아니라 **구조로 강제한다** — `markCharacterDirty(id: string, character: Character)`(`world/markCharacterDirty.ts`)가 유일한 라이브 진입점이고, `{currentRoom: …}` 같은 부분 리터럴은 `Character`가 아니므로 컴파일에서 거부된다. 현재 소비자는 세 라이브 경로(move 핸들러·세션 lifecycle 어댑터·`TrainDeps`)다.

- **강제 범위(과대 주장 금지)** — 하위 원시 seam `SaveEngine.markDirty(collection, id, snapshot: unknown)`은 여전히 열려 있고 `progression/regen.ts`가 그것을 직접 소비한다(라이브 호출부 0건이라 dormant). 계약은 "이 헬퍼를 경유하는 코드"에서만 타입으로 강제된다. `characters` 쓰기를 추가할 때는 이 헬퍼를 경유한다.
- **복사 깊이** — 스냅샷은 참조 그대로 보관되므로 별칭이 남으면 flush가 mark 시점이 아닌 소비 시점 상태를 쓴다. 스냅샷은 flush 주기가 아니라 **변이 시점마다**(이동·연마·세션 종료 각 1회) 뜨므로 재귀 복제는 비용이 과하다 — **변이 가능한 컨테이너까지만** 끊는다: top-level 얕은 spread + 배열 필드(`stats`·`spells`·`realm`, 원소가 number라 1단으로 충분) + 객체 필드(`buffs`·`statusEffects`는 컨테이너 **및 각 엔트리 객체** — 엔트리가 만료 타이머라 in-place 갱신될 수 있다). `deletedAt`(Date)은 참조 그대로 둔다(라이브가 in-place 변이하지 않는다).

  `statusEffects`는 효과마다 값 형태가 달라(poison/disease는 `interval` 보유, blind/silence/fear는 미보유) 인덱스 순회로는 타입이 좁혀지지 않으므로 **키별 복사기 목록**(`STATUS_EFFECT_COPIERS`)으로 나눈다. 이 리터럴은 `satisfies Record<StatusEffectName, …>`로 **exhaustive를 컴파일에서 강제**한다 — 스키마에 효과가 추가되면 여기서 누락 프로퍼티 에러가 나므로, 조용한 스냅샷 누락(=stale write)이 재발하지 않는다. `silence`·`fear` 추가 시 이 강제가 실제로 누락을 잡았다([character-flags.md](character-flags.md)).
- **`status`는 싣지 않는다** — 스냅샷 형태는 `Omit<Character, 'status'>`다. `status`는 soft-delete 경로(`characterRepository.softDelete`)가 단독 소유하는 권한 필드인데, 라이브 스냅샷이 실으면 스키마 default `'active'`가 LWW에서 **무덤을 되살린다**(형제 세션이 삭제한 캐릭터를 뒤이은 이동·종료 flush가 `$set {status:'active'}`로 복구해 `findByAccount`의 `status:{$ne:'deleted'}` 필터를 다시 통과시킨다). 이 계약이 봉쇄하려는 write-loss의 정확한 역방향이라 키를 제외하며, `characterRepository`의 `status.removeDefault()` 방어와 같은 편에 선다. 짝인 `deletedAt`은 제외하지 않는다 — 라이브 객체에 없으면 키가 `$set`에 실리지 않아 저장 값이 보존되므로 되돌림이 불가능하다. 제외 규칙의 대상은 "라이브가 소유하지 않으면서 **실리면 권한 경로의 write를 되돌리는** 필드"이고, 현재 유일한 원소가 `status`다.
- **optional 키 형태 보존** — 스냅샷은 `updateById` patch로 `$set`에 실리므로 원본에 없는 키를 `undefined`로 만들면 문서 형태가 바뀐다. `buffs`·`statusEffects`는 값이 있을 때만 대입하고, 엔트리 값이 `undefined`인 키도 만들지 않는다.
- **함께 실리는 필드 주의** — 부분 스냅샷과 달리 `schemaVersion`도 매 flush마다 `$set`된다. 라이브 캐릭터는 load 시 backfill로 최신 버전으로 승격돼 있으므로 첫 flush가 구버전 저장 문서를 영구 승격시킨다(migration-on-save).

`SaveEngine`은 이미 전체 문서 스냅샷을 상정한다 — `stripImmutableId`가 `_id`를 벗겨 `$set` immutable-`_id` 에러를 막는다. `roomStates`는 원래 전체 스냅샷 계약이라 무영향이다.

### SaveScheduler

주입된 `SchedulerClock`(`setInterval`/`clearInterval` seam)으로 주기 flush를 구동한다(기본 `DEFAULT_INTERVAL_MS`=120초). `SchedulerClock`·`IntervalHandle`·`defaultClock` 정의는 `util/clock.ts`가 단일 출처이며 saveScheduler는 이를 import한다(heartbeat·WorldClock과 동일 seam 공유). clock seam으로 테스트는 FakeClock을 주입해 tick을 수동 구동한다.

- `flush()` — `DirtyTracker.checkout()`(주입 구조 계약 `DirtyCheckoutSource`)으로 이미 coalesce된 배열을 얻어, 각 항목을 AsyncWriteQueue에 **동기 burst**로 enqueue한다(각 enqueue 사이 await로 yield하지 않고 `Promise.all`로 완료 대기 — 큐의 "coalescing은 동기 burst에서만 성립" 계약 준수). 빈 배치는 no-op.
- `start()`/`stop()` — interval을 걸고 해제한다. 이미 실행 중이면 재-arm하지 않는다.
- **re-entrancy**: `flushing` 플래그가 interval(`onTick`) 경로의 중복 flush를 막는다. 직접 `flush()` 호출(shutdown이 사용)은 플래그를 확인·설정하지 않고 항상 허용된다 — 정합성은 `checkout()`이 registry에 대해 갖는 원자적·파괴적 특성이 보장한다(동시 flush는 서로소 집합을 가져간다).
- `onTick`은 flush rejection을 catch해 logger로 기록하며, logger 자체가 throw해도 `.catch(() => {})`로 백그라운드 tick의 unhandled rejection을 막는다(장수 서버 보호).

### AsyncWriteQueue

bounded 큐 + 비동기 워커가 Mongo write를 게임 틱과 분리해 drain한다. 기본값 `DEFAULT_CAPACITY`=1024, `MAX_RETRIES`=3, base backoff 50ms.

- **coalescing** — pending을 `Map<"collection:id", DirtyEntry>`로 관리해 같은 키 재-enqueue를 최신값으로 dedup(성장 억제, FIFO 보존). 워커 시작을 microtask로 지연해 동기 burst가 pending에 먼저 쌓이게 한다.
- **capacity backpressure(pending-only)** — coalescing 후에도 pending이 capacity 이상이고 새 키면 `enqueue`가 공간이 생길 때까지 await(block)한다. 워커가 항목을 in-flight로 가져갈 때(take) 슬롯 1개를 비우고 대기자 하나를 깨운다.
- **재시도 분류** — `DocumentNotFoundError`(matched=0)·`ZodError`(스키마 위반)는 permanent로 재시도 없이 logger 기록 후 폐기(재시도해도 성공 못 함). 그 외(네트워크·일시 실패)는 transient로 `MAX_RETRIES`회 지수 backoff 재시도 후 성공하거나 폐기·기록. 워커는 어떤 경로에서도 throw하지 않아 한 job 실패가 루프를 죽이지 않는다(per-job try/catch + 주입 sleep seam).
- **collection dispatch** — `Object.hasOwn` 가드로 어댑터를 조회한다(prototype 키 오인 차단). 어댑터 없는 collection은 폐기·기록.
- **`evict(collection, id)`** — 지정 키를 write 경로에서 제거한다: pending에 있으면 삭제하고 capacity 대기자 하나를 깨우며(방치 시 deadlock 방지), 이미 in-flight면 그 write 완료를 await한다. `SaveEngine.saveNow`가 즉시 write 직전에 호출해 stale 큐 write가 최신 저장을 덮어쓰는 것을 pending·in-flight 양쪽에서 봉쇄한다.
- **종결 통지(`onSettled`)** — **워커가 dispatch한** job은 성공(`acked`)·폐기(`discarded`) 어느 경로로 끝나도 정확히 1회 통지된다. "write가 언제 끝났는가"는 큐만 알기 때문에, 이 통지 없이는 tracker의 스냅샷 수명 계약이 성립하지 않는다. `SaveEngine`이 이 seam을 `tracker.ack`/`discard`로 배선한다.
  - 결과를 확정하지 못한 경로(주입 `logger`·`sleep`이 throw)는 보수적으로 `discarded`다 — 성공을 확인하지 못했는데 `acked`로 통지하면 아직 영속되지 않은 스냅샷이 소유자에게서 사라진다.
  - dispatch에 도달하지 못하는 두 경로는 통지가 **없다**(설계상 의도): `evict`가 pending에서 취소한 job(호출자가 `tracker.evict`를 먼저 부르므로 소비자 상태가 이미 정리됨), 같은 키 재-enqueue로 coalescing에 밀려난 이전 스냅샷(다음 `checkout`이 그 키를 새 엔트리로 덮으므로 참조 동일성 규칙상 무해). 통지 수를 세어 미완료 job을 추적하는 refcount 용도로는 쓸 수 없다.
  - 통지 처리기의 throw는 삼켜 워커 루프를 보호하되 **logger에 남긴다**(무흔적 폐기 금지). 통지가 실패한 엔트리는 반납되지 않은 채 `inProgress`에 남는데 이는 안전한 실패다 — 남은 스냅샷이 방금 write된 값과 같아 hydrate 결과가 DB와 일치하고, 같은 키의 다음 `checkout`이 덮으며 해소된다.
- `drain()` — pending·in-flight·활성 워커가 모두 끝날 때까지 await한다(shutdown 소비).

### 이벤트 즉시 저장 (SaveEngine.saveNow)

`saveNow(collection, id, snapshot, reason)`는 주기 버퍼를 우회해 즉시 repository write를 수행하고 **await**한다(fire-and-forget 금지 — 반환 시점에 문서가 실제 갱신됨). 레벨업·로그아웃 등 재구성 불가·치명 이벤트용.

- **id 가드** — `id`가 비어 있지 않은 문자열인지 검증한다(`assertSaveId`). id가 Mongo `_id` 필터에 실리므로 객체 유입 시 연산자 주입(`{$ne:...}`)을 진입점에서 차단한다.
- **evict-before-write(2계층)** — write 직전에 `DirtyTracker.evict`(아직 flush 안 된 stale mark 제거, registry·inProgress 양쪽)와 `AsyncWriteQueue.evict`(이미 flush돼 pending/in-flight인 stale write 취소·완료 대기)를 모두 수행한다. 두 계층 evict로 stale 스냅샷이 즉시 저장을 나중에 덮어쓰는 write-loss를 봉쇄한다.
- ⚠ **봉쇄되지 않는 세 번째 상태** — `SaveScheduler.flush()`가 `checkout()` 후 `enqueue`에서 capacity backpressure로 블록된 창의 엔트리는 tracker의 `inProgress`에는 있지만 큐의 `pending`에는 아직 없어 **어느 evict도 보지 못한다**. 블록이 풀리면 stale 엔트리가 뒤늦게 enqueue돼 `saveNow`의 최신 write를 덮을 수 있다. `saveNow`는 프로덕션 호출자가 0건이라 현재 발현 경로가 없고, 현상은 `asyncWriteQueue.ts`·`saveEngine.ts` 주석에 고정돼 있다. 첫 호출자가 붙는 토픽이 구조적으로 닫는다 — 스케줄러가 checkout 완료·enqueue 미수락 집합을 노출하거나 flush를 evict-aware로 만드는 형태다.
- **fail-loud** — write 실패는 재-markDirty 없이 rethrow하며 `reason`을 실패 로그에 담는다. 알 수 없는 collection은 `hasOwn` 가드로 걸러 logger 기록 후 no-op.

### 미영속 스냅샷 조회 (SaveEngine.peekPending)

`peekPending(collection, id): unknown`이 아직 영속되지 않은 스냅샷을 **비파괴적으로** 돌려준다(#124). 재접속 hydrate의 단일 입구이며, 판정은 `tracker.peek` 한 곳이 담당한다 — 미착수(`registry`)든 write 진행 중(`inProgress`)이든 같은 값이 나온다.

- **`undefined`의 의미** — "그 키의 미영속 스냅샷이 없음"이고, 수명 계약상 **저장소 문서가 최신**이라는 뜻이다. 조회자는 DB에서 읽은 값을 그대로 쓰면 된다. 단 `discard`로 폐기된 스냅샷도 여기 해당하므로(§제약사항 write 영구 실패), 이 등식은 보장 범위 안에서 성립한다.
- **정규화는 seam이 소유한다** — 반환 전에 영속 경로와 **같은 비공개 `stripImmutableId`**를 적용한다. 그래서 반환값이 "flush가 `$set`할 것"과 문자 그대로 같아지고, 함수를 export할 필요도 없다(둘 다 `saveEngine.ts` 안).
- **이 등식은 patch 컬렉션에 한한다** — `characters`·`bankAccounts`만 영속 경로에서 같은 정규화를 거친다. `roomStates`는 어댑터가 스냅샷을 벗기지 않고 통째로 upsert하고, `objectDeletions`는 스냅샷을 아예 쓰지 않으므로(id만으로 삭제) 그대로 소비하면 안 된다.
- **반환값은 라이브 참조일 수 있다** — `_id`가 없는 스냅샷은 그대로 돌려준다. mutate하면 앞으로 영속될 스냅샷이 오염된다. tracker의 "참조 그대로 보관하고 복제하지 않는다" 계약과 짝을 이룬다.
- **반환 타입은 `unknown`이다** — save 계층은 collection 무지(agnostic)이고 소비자가 어차피 자기 스키마로 런타임 검증하므로, 검증되지 않은 컴파일 타임 단언을 seam에 얹지 않는다.
- **`onSettled`는 호출자에게 열지 않는다** — `SaveEngineOptions.queueOptions`가 `Omit<AsyncWriteQueueOptions, 'onSettled'>`다. 엔진이 그 seam으로 tracker 반납을 배선하므로 호출자 값이 들어오면 반납이 발화하지 않아 스냅샷이 `inProgress`에 영구 잔류하는데, 그 고장은 예외도 로그도 남기지 않는다. 배선을 스프레드 뒤에 두어 순서로도 이중 방어한다.

### collection dispatch 어댑터

즉시·주기 경로가 공유하는 단일 dispatch 맵이 collection별 write를 결정한다.

- `characters`·`bankAccounts` → `repo.updateById(id, patch)`. patch는 스냅샷에서 불변 `_id`를 벗겨 넘긴다(`stripImmutableId`) — 호출자가 전체 문서 스냅샷을 넘겨도 `$set`에 `_id`가 실려 Mongo immutable 에러가 나는 것을 막는다.
- `roomStates` → `WorldRepository.upsert(snapshot)`. upsert가 `snapshot.roomId`로 키를 결정하므로 id 인자를 무시한다. 전체 `RoomState`를 요구하므로 `_id`를 벗기지 않는다.
- `objectDeletions` → `ObjectRepository.deleteById(id)`(#120). 유일한 **삭제** 어댑터이며 스냅샷을 무시하고 id만 쓴다 — 지울 문서에 실을 상태가 없기 때문이다. 이미 없는 문서에 대한 `DocumentNotFoundError`는 **permanent 실패로 분류해 재시도 없이 폐기한다**(삭제는 멱등이라 재시도가 결과를 바꾸지 못한다). collection 이름을 `objects`가 아니라 `objectDeletions`로 둔 것은 의도적이다 — 같은 collection에 갱신 어댑터가 나중에 붙을 때 두 의미가 한 키를 다투지 않게 한다.

**두 write의 순서 계약(#120)** — 비법서 연마는 `characters`(주문 학습)와 `objectDeletions`(책 소멸) 두 write를 낸다. 호출부는 `markCharacterDirty`를 **먼저**, `markObjectDeleted`를 **나중에** 호출한다. `DirtyTracker`가 삽입 순서를 보존하고 `AsyncWriteQueue`가 단일 워커 FIFO라 이 호출 순서가 곧 write 시도 순서다.

재시도 소진 후 한쪽만 영속된 경우 **보상 트랜잭션을 만들지 않는다**. 손실 방향이 비대칭이기 때문이다 — 삭제만 실패하면(책 잔존 + 주문 학습됨) `setKnown`이 멱등이라 재연마가 같은 결과를 내고 그 재연마가 삭제를 다시 마킹해 스스로 수렴한다. `characters`만 실패하는 경우(책 소멸 + 주문 미학습)가 유일한 실손실이라, 순서를 고정해 이 방향의 노출 창을 줄인다. 두 write가 함께 실패하는 흔한 경우(Mongo 장애)는 자기 정합이다.

이 결정을 #43(은행 트랜잭션)과 묶지 않는다 — 실패 모델이 다르다. 은행은 금전 이중 지불이라 자가 치유 수단이 없고, 여기는 재연마 멱등성이 치유를 제공한다. 다중 컬렉션 원자성의 일반 해법(Mongo 트랜잭션 세션 도입)이 필요해지면 #43이 소유한다. 다만 **순서 고정이 막는 것은 두 write 사이의 프로세스 사망뿐**이다 — `characters` write가 영구 실패해도 큐는 job별로 격리돼 계속 진행하므로 삭제는 그대로 실행된다.

### 은행/금화 트랜잭션 (BankTransactionService)

캐릭터↔은행 gold 이동을 2-문서 원자적 트랜잭션으로 수행한다. 생성자 주입(`MongoClient`·`Db`)이며, 입출금은 `session.withTransaction`(Convenient API, 일시적 에러 재시도 내장)으로 감싸 부분 커밋을 봉쇄한다.

- **입력 가드** — `amount`가 양의 정수(`assertPositiveIntAmount`), `characterId`·`bankAccountId`가 비어 있지 않은 문자열(`assertDocumentId`)인지 트랜잭션 시작 전 검증한다. 이 서비스는 repo 계층 Zod 경계를 우회하므로 money 이동 진입점에서 id 형태를 직접 강제한다(NoSQL 연산자 주입 차단).
- **입금** — `characters.findOneAndUpdate({_id, gold:{$gte:amt}}, {$inc:{gold:-amt}})`(잔액 부족·부재 시 매칭0 → `InsufficientFundsError`) → `bankAccounts.findOneAndUpdate({_id, gold:{$lte: MAX_BANK_GOLD-amt}}, {$inc:{gold:amt}})`(상한 초과·부재 시 매칭0 → `BankCapExceededError`). 매칭0이면 콜백 throw → 트랜잭션 abort.
- **출금** — 반대 방향. bank 차감(`$gte`)은 대칭 가드, character 가산은 상한 미부과(§제약사항 Open Q). character 부재 시 `DocumentNotFoundError`.
- **잔액·상한 가드는 조건부 필터로 원자적 CAS** — read-modify-write race 없이 잔액 비음수와 은행 3억 상한(불변식 6, `MAX_BANK_GOLD` 단일 출처)을 강제한다. 둘 다 커밋되거나 아무것도 커밋되지 않는다.

### 부팅 조립·graceful shutdown (index.ts)

부팅 시 `SaveEngine(characters, bank, world, saveLogger)`를 조립하고 `start()`한다. `saveLogger`는 fastify `app.log.error`에 위임하는 어댑터(console 금지). `SIGTERM`/`SIGINT` 핸들러가 `saveEngine.shutdown()` → `conn.close()` 순으로 실행하며, 캐시된 Promise로 중복 시그널에 idempotent하다. `shutdown()`은 (1) scheduler 정지, (2) 잔여 dirty 강제 flush, (3) queue drain(타임아웃 없음 — bounded 큐라 유계, 부분 유실보다 완주 우선) 순으로 종료 전 유실을 봉쇄한다.

## 제약사항

- **세이브 호출처는 일부만 배선됨** — 라이브 이동·연마·세션 종료가 `markCharacterDirty`를 경유해 실제로 dirty를 마킹한다. 나머지(거래·전투 등 E6 잔여)의 `markDirty`/`saveNow` 호출은 각 배선 토픽 소관이다.
- **은행 명령 배선은 #43 해소까지 blocking** — `BankTransactionService`는 gold를 트랜잭션으로 직접 쓰고, `SaveEngine`은 같은 컬렉션을 write-behind로 쓴다. 두 경로 사이에 공유 per-key 조정점이 없어, gold 엔티티를 두 경로로 흘리면 트랜잭션 커밋 후 도착한 stale flush가 결과를 되돌릴 수 있다. **`progress:train` 배선으로 gold가 write-behind 경로에 진입했다**(연마 비용 차감이 전체 문서 스냅샷에 실린다) — 즉 한쪽은 이미 무장됐다. 충돌 상대인 은행 직접 write는 아직 dormant라(`clientCommandSchema`에 은행 명령 없음, `BankTransactionService` non-test caller 0건) 충돌은 현재 도달 불가하다. 따라서 계약을 고정한다: **#43을 해소하기 전에는 은행 명령을 배선하지 않는다.** 해소 방향은 (a) 트랜잭션 전후 두 키를 SaveEngine에서 evict/quiesce 후 재-mark하거나 (b) gold 변이를 write-behind 밖에 두어 단일 authoritative 경로로 유지하는 것이다([smalljiny/muhan#43](https://github.com/smalljiny/muhan/issues/43), 코드 계약은 `bankTransactionService.ts` 도크스트링).
- **재접속 pending revert는 `characters`에 한해 해소됐다(#124)** — hydrate가 `peekPending('characters', id)`를 DB 문서 위에 overlay한다. 보장 문장은 "pending이 `DirtyTracker`에 살아 있는 동안 hydrate가 그것을 채택한다"이고, 수명 계약이 그 "살아 있는 동안"을 정의한다. **`objectDeletions`는 합성하지 않는다** — 재접속 시 삭제 마킹된 비법서가 인벤에 유령으로 남는다. 현재 무해하지만(재연마 시 `setKnown`·`markObjectDeleted` 모두 멱등해 수렴, 줍기·버리기·건네주기 경로 0건) #119(teach)·#121(attack)이 건네주기·전리품 경로를 열면 재평가가 필요하다.
- **write 영구 실패 스냅샷은 복구하지 않는다** — permanent 실패·재시도 소진 시 `discard`로 버린다. 그 키의 이후 `peekPending`은 `undefined`가 되어 hydrate가 저장소 값으로 떨어진다(진행도 손실). 복구하려면 WAL급 영속 큐가 필요해 write-behind 손실 모델(아래 Durable WAL 없음)이 이미 수용한 범위다. 실패는 logger로 관측된다.
- **`character.gold` 상한 미부과** — 은행 gold는 3억 상한(불변식 6)이지만 출금 크레딧은 `character.gold`에 상한을 두지 않는다. 원작 오라클의 소지 gold 상한 여부를 재확인 후 확정되면 이 seam에 대칭 가드를 추가한다(persistence.md §제약사항 미결 연동).
- **flush 트리거는 interval-only** — 시간 간격만 사용하고 dirty 건수 임계 기반 병행 트리거는 두지 않는다. 기본 120초로 시작하며 정확값은 후속 부하 테스트로 확정.
- **Durable WAL 없음** — write-behind 경로는 수용된 손실 창을 가진다(돈은 트랜잭션으로 손실 없음). 동기 write-ahead log는 만들지 않는다.
- **repository 필터 인자 미검증은 E2-1 잔존** — `BankTransactionService`·`saveNow`는 money·세이브 진입점에서 id 가드를 자체 추가하지만, E2-1 repository 계층 자체의 `{_id:id}` 필터는 여전히 런타임 미검증이다(persistence.md §제약사항). route 경계 배선(E5) 시 통합 검증이 필요하다.
- **테스트 하네스는 단일노드 replica set** — `withTransaction`은 replica set에서만 동작하므로 `mongoTestDb.testutil.ts`가 `MongoMemoryReplSet.create({ replSet: { count: 1 } })`를 쓴다(프로덕션 Atlas는 이미 replica set). 각 컴포넌트는 주입 seam(FakeClock·즉시 sleep·mock 어댑터)으로 unit 구동, 트랜잭션·큐 통합은 in-memory replset으로 구동한다.
