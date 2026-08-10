# 크리처 스폰·활성·AI (E4-2)

> E4-1a 중앙 틱·E4-1b 방 그래프 위에서 크리처를 라이브 인스턴스로 만들고, 점유 이벤트로 구동되는 활성 집합·next-action 큐·autonomic 행동·스폰 3트리거·사망 라이프사이클로 살아 움직이게 한다.

## 개요

E4 월드 상태 엔진의 세 번째 토픽이다. E4-1a(`runtime-foundation.md`)가 1Hz 중앙 `WorldClock`과 register seam을, E4-1b(`movement-rooms.md`)가 인메모리 방 그래프·`occupants`·단일 `tryMove` 경로를 세웠다. E4-2는 그 위에 크리처를 얹는다:

1. 크리처 템플릿(`creatures.json`)·방 embedded 몬스터를 **라이브 인스턴스**(`CreatureInstance`)로 물질화하고, `RoomNode`에 가변 크리처 컬렉션을 둔다.
2. 플레이어 **점유 이벤트**로 방 크리처의 **활성 집합**을 증분 갱신한다 — 빈 방은 시간이 정지한다.
3. 활성 크리처별 **next-action 우선순위 큐**(민첩 연동 2~3초)를 `WorldClock` 슬롯으로 돌리며, **autonomic 행동**(상태이상 만료·재생·scavenge·wander-out)을 실행한다.
4. **스폰 3트리거**(perm 입장 lazy 리스폰·random 인터벌 배회·invasion 데이터 정의 이벤트)를 이식한다.
5. **크리처 사망 라이프사이클**(perm 리스폰 타이머 리셋·MSUMMO 소환·활성집합 제거)을 소유한다.

전투·어그로 타깃 판정·특수공격·주문 시전(전술 판정), 플레이어 WS 명령 배선, object/room `special` 디스패치는 범위 밖이며 seam으로 남는다. 콘텐츠 출처는 `docs/notes/game-analysis-20260625`의 A9(몬스터 AI·스폰)·A11(특수 오브젝트)·A1/A4(런타임·이동) 노트다. 원본 형상(`first_active` 연결 리스트·`time(0)` 폴링·하드코딩 침공 좌표)은 신규 스택으로 재설계하되, 동작 의미(활성 집합·스폰 규칙·autonomic 율·리스폰 규칙)는 충실히 이식한다.

## 구조 / 스키마

### 모듈 (`packages/server/src/world/`)

| 모듈 | 책임 |
|---|---|
| `creatureFactory.ts` | 템플릿·embedded 데이터 → 라이브 인스턴스. `fromEmbedded`(방 내장 몬스터 전체 필드)·`fromTemplate`(몹번호 조회). `creatureInstanceId(roomId, idx)` 결정적 ID 규약, `CreatureRng` gold 랜덤화 seam |
| `activeSet.ts` | 점유 이벤트 구동 활성/비활성(`activate`/`deactivate`), 활성 방 조회(`activeRooms`) |
| `nextAction.ts` | `cadenceSec(dexterity)`(민첩<20→3초, else 2초), `scheduleNextAction`, `isDue` |
| `creatureTick.ts` | `WorldTickSlot`(1s). 도래 크리처에 autonomic 실행 + `onCombatTick` seam 호출 |
| `autonomic.ts` | `runAutonomic` 순수 함수 — 만료·재생·scavenge·wander-out(A9 §3.1~3.5), `AutonomicRng` seam |
| `spawn.ts` | perm 리스폰(`respawnPermCreatures`), `InstanceIdAllocator`(방별 monotonic idx), 스폰 템플릿 인덱스 로드 |
| `randomSpawn.ts` | random 배회 슬롯(`intervalSec=20`), `SpawnRng` seam, `RPLWAN=23` |
| `invasion.ts` | invasion 이벤트 슬롯(이벤트당 1 슬롯), `InvasionRng`·`SpawnBroadcast` seam |
| `creatureDeath.ts` | `onCreatureDeath` seam — perm 리셋·`onDeathSummon`(MSUMMO)·제거 |
| `worldRuntime.ts` | 컴포지션 루트 — 슬롯 조립·훅 결선·seam 게이팅(`createWorldRuntime`) |

### `CreatureInstance` (`packages/shared/src/worldGraph.ts`)

라이브 크리처. 정적 스탯(`level`·`hpmax`·`dexterity`·`special`·`flags`)과 라이브 가변 상태(`hpcur`·`mpcur`·`enemies`·`inventory`·타이머)를 담는다. `templateId`는 `null`(embedded) 또는 몹번호. 타이머 필드는 실초 시각으로 도래 기준을 표현한다: `nextActionAt`(다음 행동), `lastRegenAt`(재생 baseline), `lastScavengeAt`·`lastWanderAt`(20초 게이트), `befuddledUntil`·`charmedUntil`(MBEFUD/MCHARM 만료 — 미설정=만료됨=autonomic이 비트 스크럽). `instanceId`는 `${roomId}:c${idx}` 부팅 생성·non-durable.

전투 콘텐츠 필드(불변, 물질화 시점 소스 JSON에서 전이)로 `armor`·`thaco`·`ndice`·`sdice`·`pdice`([combat.md](combat.md) operand)와 마법 read 필드(`realm`·`spells`·`class`·`intelligence`·`piety`)가 있고, [combat.md](combat.md) 사망 분배(`distributeCreatureDeath`)가 읽는 `experience`·`alignment`를 **선택 필드**로 담는다(`befuddledUntil`/`charmedUntil` 선택 관례 — 인라인 리터럴 blast-radius 회피, 소스 JSON은 항상 실값 보유). 물질화(`creatureFactory.ts`)는 두 필드를 소스에서 복사하고, template 스폰 경로는 `buildSpawnTemplateIndex`(`spawn.ts`) 명시 매핑이 두 필드를 전파한다(embedded·template 양 경로 충실).

이름 매칭용 별칭 `keys?: string[]`도 같은 선택 필드 관례를 따른다(원본 `char key[3][20]`, CRT 오프셋 255). 소비자는 방 스코프 크리처 해소자이며 규칙 정본은 [`name-matching.md`](name-matching.md)다. **물질화 경로가 전부 필드 선택 복사라 타입만 추가하면 값이 아무 데서도 채워지지 않고, `keys?`가 optional인 탓에 컴파일도 통과하는 조용한 결손이 된다** — `creatureFactory.ts`(embedded)·`buildSpawnTemplateIndex`(template)·`server/src/world/worldGraph.ts`(방 로드) 세 지점 모두에 명시 전파가 필요하다. 프로덕션 리더·물질화는 별칭이 없어도 `[]`를 채운다(`undefined` 금지 — 매처가 두 형상을 분기하지 않도록).

### `RoomNode` 스폰 필드 (G3)

`RoomNode`에 라이브 `creatures: CreatureInstance[]`(가변)와 스폰 정의 필드를 추가한다:

- `permMon: PermMonSlot[]` — `{interval, ltime, misc}`. `misc`=스폰 몹번호, `interval`=리스폰 지연 초, `ltime`=마지막 스폰/사망 실초(가변).
- `random: number[]` — 배회 후보 몹번호(길이 10, 불변).
- `traffic: number` — 진입/퇴장 확률(불변).

### converter 확장 (`packages/port`)

`parseRoom.js`·`convertWorld.js`가 방 레벨 스폰 필드를 emit한다. `perm_mon` 오프셋은 C oracle(`mstruct.h:154`)로 **@216 확정**(`random@192`·`traffic@212`는 기존). converter는 로더가 실제 소비하는 번들 `rooms.json`·`meta.json`을 emit하며, embedded 몬스터는 `templates.js readCreature` 재사용으로 전체 1184B 필드를 인라인 추출한다(빌더 커스터마이즈 스탯이 템플릿과 달라 링크 재구성 불가). 재변환은 멱등·orphan 제외 규칙 유지.

별칭 `key[3][20]` 추출도 두 리더(`templates.js` OBJ 160·CRT 255, `parseRoom.js` 자체 오프셋 테이블)에 함께 들어간다. 방 embedded 개체는 `templateId=null`이라 템플릿 재조회가 불가능하므로 `parseRoom.js` 쪽을 빼면 같은 몬스터가 방마다 별칭 유무가 갈린다. 위생 규칙(공백 전용 슬롯 드롭·20B 절단·U+FFFD 보존)은 [`name-matching.md`](name-matching.md) §별칭 추출 위생.

### `events.json` (invasion 데이터 정의)

`data/world/events.json`은 hand-authored 정적 파일(converter 산출물 아님)이다. 원본 하드코딩 좌표를 데이터 정의 이벤트로 승격한다:

```json
{ "id": "chaos-invasion", "periodSec": 4000,
  "roomRange": { "min": 8000, "max": 8300 },
  "mobRange": { "min": 732, "max": 755 },
  "count": 50, "broadcast": "…" }
```

## 동작

### 활성 집합 (점유 이벤트 구동)

`tryMove` join 경로의 `onRoomEntered` entry-hook이 방 첫 플레이어 진입 시 방 크리처를 활성화하고 크리처별 next-action 시각을 초기화한다. leave 경로의 `onRoomLeft` 훅(`broadcastLeave`와 대칭)이 방이 비면 비활성화한다 — 이 대칭 seam이 없으면 방↔방 이동 시 빈 방이 비활성화되지 않는다. 비활성 크리처의 상태·타이머는 **동결**된다(빈 방=시간 정지). `tryMove` 훅 순서는 delete→`onRoomLeft`, add→`onRoomEntered`.

### next-action 큐 + autonomic 절단선

`creatureTick` 슬롯(1s)이 `nextActionAt`이 도래한 크리처만 처리한다. 각 도래 크리처에 `runAutonomic`을 실행하며, 처리 순서가 곧 우선순위다:

| A9 절 | 행동 | 처리 |
|---|---|---|
| §3.1 | 상태이상(MBEFUD)·charm(MCHARM) 만료 | 구현 |
| §3.2 | 재생 (HP hpmax/10·MP mpmax/6 per 60s, while 소급) | 구현 |
| §3.3 | scavenge (MSCAVE, 20s/15%, 바닥 첫 회수가능 아이템) | 구현 |
| §3.4 | wander-out (배회 크리처 적 없을 때 확률 퇴장=traffic) | 구현 |
| §3.5 | 조기종료 게이트(적 없고 공격형 아니면 종료) | 구현 (절단선) |
| §3.6~7 | 전투·어그로·특수공격 | `onCombatTick` seam → **E6** |

재생 소급은 활성화 시각 기준이다 — 동결 구간(관측 안 된 시간)은 소급하지 않는다. `onCombatTick`은 §3.5를 통과한(적 있거나 공격형) 크리처에만 호출되며 E4-2 기본은 no-op.

### 스폰 3트리거

| 모델 | 트리거 | 조건 | 그룹 크기 |
|---|---|---|---|
| **perm** | 입장 구동(entry-hook) | `ltime+interval ≤ now` 슬롯 lazy 리스폰, 방 내 동명 MPERMT 생존 수 차감 | 슬롯 몹번호별 |
| **random** | 폴링 20초 슬롯 | 활성 방 순회, `roll ≤ traffic` | `RPLWAN`→플레이어 수, else `numwander` |
| **invasion** | 이벤트 주기 슬롯 | `periodSec`마다 무조건 `count` 스폰 | 데이터 정의 `count` |

perm은 스케줄러가 아닌 입장 시점 lazy 재계산이다(빈 방 미리젠, "빈 방=시간 정지" 일관). random의 `traffic`은 진입(이 슬롯)·퇴장(§3.4 wander-out) 양쪽 확률로 재사용된다. 스폰 3경로 모두 방별 monotonic `InstanceIdAllocator`(D7)를 공유해 사망 후 idx 충돌을 막는다.

### 사망 라이프사이클 + special 3도메인

`onCreatureDeath` seam은 E6이 HP<1 판정 후 호출하며, E4-2가 처리한다: (a) MPERMT면 방 `permMon[]` 동명 슬롯 `ltime = now`(리스폰 타이머 리셋), (b) MSUMMO면 `creature.special`(소환 몹번호)로 `onDeathSummon` 실행, (c) 활성 집합·방 크리처 컬렉션에서 제거. `special`은 3도메인 동명이인이라 통합 레지스트리를 만들지 않는다 — creature `onDeathSummon`(MSUMMO)만 구현하고, room `special`(가문·결혼 게이트 → E5/E7)·object `special`(명령 디스패치 → 명령 에픽)은 별도 개념 seam이다.

### 컴포지션 루트 (`createWorldRuntime`)

`worldRuntime.ts`가 슬롯을 조립하고 훅을 결선한다. `index.ts`는 `now: () => worldClock.currentTick()` 단일 도메인만 주입하며, 반환된 `slots`를 register한다. `onRoomEntered`/`onRoomLeft` 훅은 구성돼 있으나 프로덕션 `tryMove` 실 caller(movement 에픽)가 아직 없어 dormant다. `alloc`·`templates`는 E6 death 결선이 재사용하도록 노출한다.

## 제약사항

- **invasion 게이팅**: invasion 슬롯은 실 `invasionRng`가 주입될 때만 boot register된다. E4-2 `index.ts`는 미주입이라 invasion은 inert다 — invasion은 확률 게이트 없이 주기마다 무조건 `count` 스폰하므로 기본 stub(항상 min)이면 고정 방(8000·3601)에 결정적 누적된다(E4-2는 전투 정리·해당 방 활성화 없음). 슬롯 자체는 조립·테스트되며, E8-2가 범위 분산 rng를 주입하면 즉시 활성화된다.
- **RNG seam 결정적 stub**: 스폰 확률(traffic)·scavenge 15%·wander-out·gold 랜덤화는 주입 seam이며 E4-2 기본은 결정적(비발화 또는 identity). `spawnRng` 미주입 시 random 슬롯은 조용하다. 실 확률·시드 규약은 E8-2 RNG가 이 seam으로 주입한다.
- **dormant 경계**: `onCombatTick`·broadcast·`onCreatureDeath`·entry/leave 훅은 전부 no-op 기본 + 주입 seam이다. 프로덕션에서 실 발화하는 것은 (게이트 통과 시) invasion 슬롯뿐이다.
- **전투·전술 판정 범위 밖**: 전투 실행·어그로 타깃(piety 역가중)·특수공격(breath·드레인·상태이상·아이템파괴)·주문 시전·HP<1 사망 판정은 E6. 사망 보상(경험치·gold 드롭·인벤 드롭)은 E6/E8.
- **명령·특수 디스패치 범위 밖**: 플레이어 WS 명령 배선, object/room `special` 디스패치, interactive talk는 명령 에픽/E5/E7.
- **데드 스캐폴드 미구현**: 몬스터 도주(MFLEER)·주기 발화(MSAYTLK)는 as-shipped 데드라 재현(미구현). 되살림은 별도 결정 게이트.
- **영속화 없음**: 라이브 상태·perm `ltime`은 인메모리만이며 write-back은 후속. 재부팅 시 스폰 상태는 기본값 복귀.
