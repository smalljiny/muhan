# 영속화 기반 (E2-1)

> MongoDB 네이티브 연결·Zod 문서 스키마 4종·생성자 주입 repository 계층·부팅 시 방 전량 인메모리 그래프 로드의 정본.

## 개요

무한 포팅의 영속화 계층 토대다. [`monorepo.md`](monorepo.md)(E1)가 세운 pnpm workspace(`shared`/`server`/`port`/`client`) 위에, ADR([`architecture.md`](architecture.md) D2)가 규정한 **인메모리 권위 그래프 + MongoDB DB-네이티브 세이브** 구조를 확립한다. 원작 `load_rom` LRU+write-back 캐시(오라클 A4 §9)는 폐기하고, 부팅 시 월드를 전량 인메모리로 읽어 라이브 그래프로 삼는다.

두 경계가 이 토픽의 핵심이다.

1. **인메모리 권위 그래프 ↔ MongoDB 경계** — `data/world` JSON이 콘텐츠 정본이며 부팅 시 `Map<roomNumber, RoomNode>`로 전량 로드된다. MongoDB는 플레이어 소유 상태(character·object·bankAccount)와 방 런타임 상태(roomState)만 담당한다.
2. **단일소유 `object.owner` ↔ 파생 뷰 경계** — character·bankAccount는 인벤토리/보관 배열을 권위 데이터로 저장하지 않고, `object.owner`를 역참조해 조회 시점에 파생한다.

**범위 밖**(후속 토픽): 세이브 정책·dirty-flag flush·은행 트랜잭션 원자성은 E2-2([`save-policy.md`](save-policy.md), 구현 완료), 인증·`accountId`·account:character 1:N은 E5, 출구 타이머 틱·몬스터 리스폰 로직·objmon 템플릿 로딩·이동 트랜잭션 원자성은 E4.

## 구조 / 스키마

### 영속 문서 스키마 (`packages/shared/src/schema/`)

네 스키마 모두 Zod 단일 출처다 — `z.infer`로만 TS 타입을 파생하고 병렬 `type`/`interface` 선언을 두지 않는다(`packages/shared/src/schema/index.ts` 배럴이 스키마·타입을 함께 재노출). 모두 `z.strictObject`로 봉인해 unknown 키를 파싱 에러로 거부한다 — character·bankAccount에 권위 인벤토리/보관 배열이 조용히 유입되는 것을 구조적으로 차단한다.

**`character.ts`** — `characterSchema`:

| 필드 | 타입 | 비고 |
|------|------|------|
| `_id` | `string().min(1)` | 합성 ID |
| `name` | `string().min(1)` | unique 인덱스 대상 |
| `class` | `int()` | |
| `race` | `int()` | |
| `stats` | `tuple([int, int, int, int, int])` | 능력치 5종 고정 튜플(오라클 순서 유지) |
| `gold` | `int().min(0)` | 상한 없음(§제약사항 참조) |
| `currentRoom` | `int().min(0)` | 방 번호 자연키, data/world 로드 경로 번호와 동일 체계 |
| `schemaVersion` | `int()` | |

크리덴셜·`accountId` 없는 순수 게임 엔티티(E5 범위). 권위 인벤토리 배열 없음 — `object.owner={type:'character'}` 역참조로 파생.

**`object.ts`** — `objectOwnerSchema`(discriminated union) + `objectSchema`:

- `objectOwnerSchema`: `z.discriminatedUnion('type', [...])` — `{type:'character', id:string().min(1)}` | `{type:'bank', id:string().min(1)}`. 단일소유 canonical의 구조적 출처.
- `objectSchema` 필드: `_id`(고유 인스턴스 문자열), `objnum`(템플릿 참조, `int()`), `type`(`int().min(0).max(14)`, 오라클 type 0..14), `owner`(`objectOwnerSchema`), `slot`(`int().nullable()`, 슬롯 미배치 시 null), `equipped`(`boolean()`), `value`(`int().min(0)`), `shotscur`(`int()`, 런타임 가변 현재 사용/충전 횟수), `schemaVersion`(`int()`).

방·몹·플레이어·은행 공용 단일 스키마. 변하지 않는 템플릿 스탯(ndice·armor 등)은 담지 않고 `objnum`으로 별도 조회한다(objmon 카탈로그 조회는 E4 범위).

**`bankAccount.ts`** — `bankAccountSchema`: `_id`(`string().min(1)`), `owner`(`string().min(1)`, 소유 캐릭터 `_id`), `gold`(`int().min(0).max(300_000_000)`, 불변식 6), `schemaVersion`(`int()`). 권위 보관 배열 없음 — `object.owner={type:'bank'}` 역참조로 파생.

**`roomState.ts`** — `exitStateSchema`(`direction`, `closed`, `locked`) + `respawnStateSchema`(`interval`, `lastDeathTime`, `mobId`) + `roomStateSchema`: `roomId`(`int().min(0)`, 자연키 — 합성 `_id` 없음), `exits`(`exitStateSchema[]`), `respawn`(`respawnStateSchema[]`), `schemaVersion`(`int()`). 문·출구 상태와 리스폰 타이밍까지 완전 정의하되, 실 flush 메커니즘은 E2-2.

네 스키마 모두 `zod` 4.x 라인 idiom을 쓴다(`z.strictObject`, `z.int()`, `z.flattenError()` — v3 관용인 `z.string().email()`·`error.flatten()`과 다름).

### 인메모리 그래프 타입 (`packages/shared/src/worldGraph.ts`)

영속 스키마와 별개인 순수 TS 타입(zod 미사용) — 디스크에 저장되지 않는 라이브 상태를 표현한다.

- `ExitEdge { name, targetRoomId, flags: number[], key, timer }` — raw exit의 `room`(대상 방 번호)을 `targetRoomId`로 매핑. `timer`는 런타임 전용 필드(raw에 없음, 기본 0). 대상이 그래프에 없으면(dangling) 엣지는 유지되고 해석은 `Map.has` 조회로 지연된다.
- `ItemInstance { instanceId, name, description, value, contains: ItemInstance[] }` — `instanceId`는 부팅 시 생성되는 고유 id로 non-durable. 컨테이너는 `contains`로 재귀 중첩.
- `RoomNode { roomId, name, shortDesc, longDesc, exits: ExitEdge[], items: ItemInstance[] }` — raw의 `short_desc`/`long_desc`를 `shortDesc`/`longDesc`로 매핑.

`packages/shared/src/index.ts`가 `HealthStatus`(`{status:'ok'|'degraded', db:'up'|'down'}`), `loadWorldFile`, 그래프 타입(`ExitEdge`/`ItemInstance`/`RoomNode`), 영속 스키마 배럴을 함께 재노출한다.

## 동작

### 연결 계층 (`packages/server/src/db/`)

`connection.ts`의 `connectMongo(uri, dbName, options?)`가 네이티브 `mongodb` 드라이버로 부팅 연결을 수행한다. `new MongoClient(uri, { serverSelectionTimeoutMS })`로 생성한 뒤 `serverHeartbeatSucceeded`/`serverHeartbeatFailed` 리스너를 `client.connect()` 호출 **이전**에 붙여 초기 handshake heartbeat를 놓치지 않는다. `createConnectionState()`가 이 두 이벤트로 `isConnected()` boolean 플래그를 유지하는 `ConnectionState`를 만든다(SDAM heartbeat 기반 재연결 감시). 연결 실패는 삼키지 않고 그대로 propagate하되(fail-fast), 실패한 client의 topology 모니터가 남지 않도록 `close()` 후 원 에러를 다시 던진다. 성공 시 `{ db, client, isConnected, close }` 형태의 `MongoConnection`을 반환한다.

`health.ts`의 `pingDb(db)`가 `db.command({ ping: 1 })`을 감싸 예외를 밖으로 던지지 않고 성공/실패를 boolean으로 환원한다 — ping이 `/health` 상태의 **진실 원천**이다(감시 플래그가 아님).

### `/health` 확장 (`packages/server/src/app.ts`)

`buildApp(deps?: { pingDb?: () => Promise<boolean> })`가 `deps.pingDb`를 주입받아 `/health` 핸들러에서 호출한다. `pingDb` 성공 시 `{status:'ok', db:'up'}`, 실패 시 `{status:'degraded', db:'down'}`, 미주입 시(테스트 등) `{status:'degraded', db:'down'}`을 반환한다.

### Zod env config (`packages/server/src/config/env.ts`)

`EnvSchema`(zod object, strictObject 아님): `MONGODB_URI`(`z.string().min(1)`, **존재만** 검증 — `z.url()`은 유효한 seed-list 복제셋 URI를 false-reject하므로 문법 검증은 드라이버에 위임), `MONGODB_DB_NAME`(`z.string().min(1).default('muhan_db_dev')`), `PORT`(`z.coerce.number().int().min(0).max(65535).default(3000)`).

`getConfig()`는 모듈 스코프 싱글턴(`configInstance`)을 캐시하는 fail-fast 함수 — 미캐시 시 `EnvSchema.safeParse(process.env)`, 실패하면 `z.flattenError(result.error).fieldErrors`를 콘솔에 출력하고 `process.exit(1)`. `resetConfigForTests()`가 테스트 전용으로 캐시를 초기화한다.

### repository 계층 (`packages/server/src/repo/`)

`types.ts`가 `IRepository<T>` 인터페이스(`findById`/`insert`/`updateById`/`deleteById`)와 `DocumentNotFoundError`를 정의한다. 생성자 주입 관례 — 구현체는 `constructor(private readonly db: Db)`로 mongodb `Db` 핸들을 받는다(서비스 로케이터·전역 싱글턴 미사용). **write 계약**: `updateById`·`deleteById`는 매칭 문서 0건이면 `DocumentNotFoundError`를 던진다(silent lost write 방지) — `matchedCount`(NOT `modifiedCount`)로 판정하므로 멱등 갱신(matched=1, modified=0)은 성공 처리된다. `_id`는 patch 타입(`Partial<Omit<T, '_id'>>`)에서 제외돼 immutable-`_id` 에러를 타입 단계에서 차단한다.

- **`ObjectRepository`**(`objectRepository.ts`) — `IRepository<ObjectInstance>` 구현. `_id`가 Mongo `_id`로 그대로 매핑(별도 매핑 계층 없음). `findByOwner(owner: ObjectOwner)`가 `{'owner.type', 'owner.id'}` dot-notation 필터로 소유 집합을 조회한다. `init()`이 `{'owner.type':1, 'owner.id':1}` 복합 인덱스를 생성(멱등). 경계 검증: `insert` 직전과 `findById`/`findByOwner` 직후 `objectSchema.parse`, `updateById`는 모듈 스코프 `objectSchema.partial()`로 부분 검증.
- **`CharacterRepository`**(`characterRepository.ts`) — `IRepository<Character>` 구현. 생성자가 `Db` + `ObjectRepository`(인벤토리 하이드레이션용)를 함께 주입받는다. `init()`이 `{name:1}` unique 인덱스를 생성(원작 FS 초성 샤딩 대체). `hydrateInventory(characterId)`가 `objects.findByOwner({type:'character', id: characterId})`로 인벤토리 뷰를 파생한다.
- **`BankRepository`**(`bankRepository.ts`) — `IRepository<BankAccount>` 구현. 생성자가 `Db` + `ObjectRepository`(보관 하이드레이션용)를 주입받는다. `init()`이 `{owner:1}` unique 인덱스(계좌 1:1)를 생성. `hydrateHoldings(bankAccountId)`가 `objects.findByOwner({type:'bank', id: bankAccountId})`로 보관 뷰를 파생. **금화 무결성 가드(불변식 6)**는 별도 로직이 아니라 스키마 경계(`gold: int().min(0).max(300_000_000)`)가 `insert`·`updateById`(partial parse) 양쪽에서 강제한다.
- **`WorldRepository`**(`worldRepository.ts`) — `IRepository<T>`를 **구현하지 않는다**. roomState는 `_id`가 없고 `roomId`(숫자)가 자연키라 문자열 `_id` 계약과 맞지 않는다. 저장 문서 타입은 `RoomStateDoc = RoomState & { _id: number }`. `findByRoomId(roomId)`, `upsert(state)`(`updateOne({_id: roomId}, {$set}, {upsert:true})`), `deleteByRoomId(roomId)`(0건 매칭 시 `DocumentNotFoundError`) 세 메서드를 제공. `WorldRepository`는 자체 `init()`이 없다(자연키라 unique 인덱스 불필요) — `index.ts` 부팅 배선에도 포함되지 않는다.

인덱스 수명주기는 각 repository가 자기 컬렉션의 `init()`으로 소유한다(`createIndex`는 멱등).

### 부팅 월드 로드 (`packages/server/src/world/worldGraph.ts`)

`loadWorldGraph(worldRoot?)`가 `loadWorldFile<RawRoom[]>('rooms.json', worldRoot)`로 `data/world/rooms.json`(방 2341개)을 1회 읽어 `Map<number, RoomNode>`를 구성하는 순수 함수다(전역·부수효과 없음).

- `toExitEdge(raw)` — raw exit의 `room`(대상 방 번호)을 `targetRoomId`로 매핑, `flags`는 복사(원본 raw 번들과 배열 공유 방지), `timer` 런타임 기본 0.
- `toItemInstance(raw, roomId, path)` — 방 JSON에 임베드된 `items` 배열을 재귀 변환. `instanceId` 스킴은 `${roomId}:${path}`(path는 방 아이템 트리 인덱스 경로를 점으로 이은 값, 예: 방50 첫 아이템=`50:0`, 그 중첩 첫 자식=`50:0.0`) — 방 id가 Map 키로 유일하고 경로가 방 내에서 유일하므로 결정적·순수하게 전역 유일성이 보장된다.
- `toRoomNode(raw)` — 위 두 변환을 조합해 `RoomNode`를 만든다.

objmon 템플릿 카탈로그(`objects.json`/`creatures.json`) 로딩과 몬스터·리스폰 로직은 포함하지 않는다(E4 범위) — 방 바닥 아이템은 방 JSON에 임베드된 `items` 배열에서만 인스턴스화된다.

### 부팅 시퀀스 (`packages/server/src/index.ts`)

배선 전용 엔트리(커버리지 제외)로, 순서대로 fail-fast 체인을 구성한다.

1. `getConfig()` — env 검증, 실패 시 즉시 `process.exit(1)`.
2. `connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME)` — 실패 시 throw → `boot().catch()`에서 에러 메시지만 콘솔 출력 후 `process.exit(1)`(URI 등 자격증명이 로그로 새지 않도록 `err.message`만 출력).
3. `ObjectRepository`/`CharacterRepository`/`BankRepository`를 `conn.db`로 생성(Character·Bank는 `objects`를 함께 주입) 후 `Promise.all([objects.init(), characters.init(), bank.init()])`로 인덱스를 프로덕션에 보장.
4. `loadWorldGraph()` — 월드를 인메모리 그래프로 로드, boot 스코프 지역 변수 `world`에 보관.
5. `buildApp({ pingDb: () => pingDb(conn.db) })` — ping을 `/health` 진실 원천으로 주입.
6. `app.listen({ port: config.PORT, host: '0.0.0.0' })` — 실패 시 `conn.close()` 후 `process.exit(1)`.

## 제약사항

- **세이브 정책·flush·은행 트랜잭션 원자성은 E2-2([`save-policy.md`](save-policy.md), 구현 완료)** — 이 토픽(E2-1)은 roomState 스키마를 완전 정의하고, Mongo 오버레이·주기 flush 메커니즘·dirty-flag 추적·은행 gold 이동 트랜잭션 원자성은 E2-2 세이브 정책 엔진이 구현한다. 이동 트랜잭션 원자성은 E4.
- **인증·account는 E5** — character는 크리덴셜 없는 순수 게임 엔티티다. `accountId`, account:character 1:N, 소셜 로그인, 해싱, 로그인 FSM은 이 토픽 범위 밖.
- **타이머·리스폰은 E4** — `roomStateSchema.respawn` 필드는 상태 스키마만 정의하며, 출구 타이머 틱·몬스터 리스폰 로직·objmon 템플릿 카탈로그 로딩은 이 토픽에 없다.
- **방 바닥 아이템은 non-durable** — `ItemInstance`는 인메모리 전용이며 Mongo에 저장되지 않는다. 서버 재시작 시 방 JSON에 임베드된 `items`에서 재로드된다(실측 2341방 중 items 219개·monsters 482개 임베드, monsters는 E4 로딩 대상).
- **라이브 상태 핸드오프 미구현** — `index.ts` boot의 `loadWorldGraph()` 결과 `Map`과 4개 repository 인스턴스는 현재 `boot()` 함수 스코프의 지역 변수다. 게임 루프·요청 핸들러가 이 라이브 그래프·repository에 접근하려면 후속 토픽에서 보존·핸드오프 메커니즘(모듈 상태·앱 데코레이트·컨텍스트 객체)이 필요하다.
- **콘텐츠 SoT는 `data/world` JSON** — Mongo는 콘텐츠를 시드하지 않는다. 방·템플릿의 안정 ID는 JSON 번호 자연키, character/object/bankAccount는 합성 `_id`+도메인 unique 인덱스.
- **repository 필터 인자는 런타임 미검증** — `findById(id)`/`findByOwner(owner)`/`updateById`의 `{_id:id}` 필터 절반은 컴파일 타임 타입(`string`/`ObjectOwner`)만 강제되고 런타임 가드가 없다. 현재는 모든 caller가 검증된 문자열을 전달해 미악용 상태이나, 사용자 제어 id가 route 경계에서 repository로 직접 전달되기 시작하면(E5 인증·HTTP route) NoSQL operator 주입 가능성이 생긴다. write body는 이미 `schema.partial().parse`(strictObject가 `$`-키 차단)로 안전하다. `WorldRepository`는 `roomId: number`라 안전. E2-2([`save-policy.md`](save-policy.md))의 `BankTransactionService`·`saveNow`는 repo 계층을 우회하는 money·세이브 진입점에서 id 문자열 가드를 자체 추가했으나, repository 계층 자체의 필터는 여전히 미검증이다 — E5 route 경계에서 통합 검증이 필요하다.
- **테스트 전략** — 스키마 검증(unit)·env 파싱 fail-fast(unit)·그래프 구성(unit)은 순수 함수 테스트. 연결·ping·재연결, `ObjectRepository` owner 조회·인덱스, 하이드레이트·unique·금화 가드는 `mongodb-memory-server` 통합 테스트. 각 패키지 vitest 커버리지 80%+ 게이트(배선 엔트리 `index.ts` 제외).
- **`character.gold`는 상한 없음** — `bankAccount.gold`(3억 상한, 불변식 6)와 달리 캐릭터 소지 gold는 `z.int().min(0)`만 강제한다. 원작 오라클이 소지 gold에도 상한을 뒀는지는 미확인이며, 확인 후 후속 토픽에서 조정될 수 있다.
