# 크리처 스폰·활성·AI (E4-2)

> E4-1a 중앙 틱과 E4-1b 방 그래프를 바탕으로 크리처를 라이브 인스턴스로 만든다. 점유 이벤트 기반 활성 집합, next-action 큐, autonomic 행동, 스폰 3트리거, 사망 라이프사이클로 크리처가 실제로 동작하게 한다.

## 개요

E4 월드 상태 엔진의 세 번째 토픽이다. E4-1a(`runtime-foundation.md`)가 1Hz 중앙 `WorldClock`과 register 확장 지점(seam)을 만들었고, E4-1b(`movement-rooms.md`)가 인메모리 방 그래프, `occupants`, 단일 `tryMove` 경로를 만들었다. E4-2는 여기에 크리처를 더한다:

1. 크리처 템플릿(`creatures.json`)과 방 embedded 몬스터로 **라이브 인스턴스**(`CreatureInstance`)를 생성하고, `RoomNode`에 가변 크리처 컬렉션을 둔다.
2. 플레이어 **점유 이벤트**에 따라 방 크리처의 **활성 집합**을 증분 갱신한다. 빈 방에서는 시간이 멈춘다.
3. 활성 크리처마다 **next-action 우선순위 큐**(민첩에 따라 2~3초)를 두고 `WorldClock` 슬롯으로 돌린다. 이 큐로 **autonomic 행동**(상태이상 만료, 재생, scavenge, wander-out)을 실행한다.
4. **스폰 3트리거**를 이식한다. perm 입장 시 lazy 리스폰, random 인터벌 배회, invasion 데이터 정의 이벤트가 그것이다.
5. **크리처 사망 라이프사이클**을 담당한다. perm 리스폰 타이머 리셋, MSUMMO 소환, 활성 집합 제거가 여기에 속한다.

다음은 범위 밖이며 seam으로 남긴다: 전투, 어그로 타깃 판정, 특수공격, 주문 시전 같은 전술 판정과 플레이어 WS 명령 연결, object/room `special` 디스패치. 콘텐츠 출처는 `docs/notes/game-analysis-20260625`의 A9(몬스터 AI·스폰), A11(특수 오브젝트), A1/A4(런타임·이동) 노트다. 원본 구현 방식(`first_active` 연결 리스트, `time(0)` 폴링, 하드코딩 침공 좌표)은 신규 스택으로 재설계한다. 하지만 동작 의미(활성 집합, 스폰 규칙, autonomic 율, 리스폰 규칙)는 충실히 이식한다.

## 구조 / 스키마

### 모듈 (`packages/server/src/world/`)

| 모듈 | 책임 |
|---|---|
| `creatureFactory.ts` | 템플릿·embedded 데이터 → 라이브 인스턴스. `fromEmbedded`(방 내장 몬스터의 전체 필드), `fromTemplate`(몹번호 조회). `creatureInstanceId(roomId, idx)` 결정적 ID 규약, `CreatureRng` gold 랜덤화 seam |
| `activeSet.ts` | 점유 이벤트 기반 활성/비활성(`activate`/`deactivate`), 활성 방 조회(`activeRooms`) |
| `nextAction.ts` | `cadenceSec(dexterity)`(민첩<20→3초, 그 외 2초), `scheduleNextAction`, `isDue` |
| `creatureTick.ts` | `WorldTickSlot`(1s). 도래한 크리처에 autonomic을 실행하고 `onCombatTick` seam을 호출 |
| `autonomic.ts` | `runAutonomic` 순수 함수. 만료, 재생, scavenge, wander-out(A9 §3.1~3.5), `AutonomicRng` seam |
| `spawn.ts` | perm 리스폰(`respawnPermCreatures`), `InstanceIdAllocator`(방별 monotonic idx), 스폰 템플릿 인덱스 로드 |
| `randomSpawn.ts` | random 배회 슬롯(`intervalSec=20`), `SpawnRng` seam, `RPLWAN=23` |
| `invasion.ts` | invasion 이벤트 슬롯(이벤트당 1 슬롯), `InvasionRng`·`SpawnBroadcast` seam |
| `creatureDeath.ts` | `onCreatureDeath` seam. perm 리셋, `onDeathSummon`(MSUMMO), 제거 |
| `worldRuntime.ts` | 컴포지션 루트. 슬롯 조립, 훅 연결, seam 게이팅(`createWorldRuntime`) |

### `CreatureInstance` (`packages/shared/src/worldGraph.ts`)

라이브 크리처다. 정적 스탯(`level`, `hpmax`, `dexterity`, `special`, `flags`)과 라이브 가변 상태(`hpcur`, `mpcur`, `enemies`, `inventory`, 타이머)를 담는다. `templateId`는 `null`(embedded)이거나 몹번호다. 타이머 필드는 실초 시각으로 도래 기준을 나타낸다.

- `nextActionAt`: 다음 행동
- `lastRegenAt`: 재생 baseline
- `lastScavengeAt`, `lastWanderAt`: 20초 게이트
- `befuddledUntil`, `charmedUntil`: MBEFUD/MCHARM 만료. 값이 설정되지 않았으면 만료된 것으로 보고, autonomic이 해당 비트를 지운다(스크럽).

`instanceId`는 `${roomId}:c${idx}` 형식으로 부팅 때 생성되며 non-durable이다.

전투 콘텐츠 필드는 불변이며, 인스턴스를 생성할 때 소스 JSON에서 옮겨 온다. `armor`, `thaco`, `ndice`, `sdice`, `pdice`([combat.md](combat.md) operand)와 마법 read 필드(`realm`, `spells`, `class`, `intelligence`, `piety`)가 여기에 속한다. [combat.md](combat.md) 사망 분배(`distributeCreatureDeath`)가 읽는 `experience`와 `alignment`는 **선택 필드**로 담는다. `befuddledUntil`/`charmedUntil`과 같은 선택 필드 관례이며, 인라인 리터럴 쪽으로 변경 영향(blast-radius)이 번지는 것을 피하려는 것이다. 소스 JSON에는 항상 실제 값이 있다. 인스턴스 생성(`creatureFactory.ts`)은 두 필드를 소스에서 복사한다. template 스폰 경로에서는 `buildSpawnTemplateIndex`(`spawn.ts`)의 명시 매핑이 두 필드를 전파한다. 그래서 embedded와 template 두 경로 모두 값을 빠짐없이 옮긴다.

이름 매칭용 별칭 `keys?: string[]`도 같은 선택 필드 관례를 따른다(원본 `char key[3][20]`, CRT 오프셋 255). 소비자는 방 스코프 크리처 리졸버이고, 규칙 기준은 [`name-matching.md`](name-matching.md)다. 인스턴스 생성 경로는 모두 필드를 하나씩 골라 복사한다. 그래서 타입만 추가하면 값이 어디에서도 채워지지 않는다. 게다가 `keys?`가 optional이라 컴파일도 통과하므로 **아무 경고 없이 값이 빠진다**. 따라서 `creatureFactory.ts`(embedded), `buildSpawnTemplateIndex`(template), `server/src/world/worldGraph.ts`(방 로드) 세 지점 모두에서 명시적으로 전파해야 한다. 프로덕션 리더와 인스턴스 생성은 별칭이 없어도 `[]`를 채운다. `undefined`는 금지한다. 매처가 두 경우를 따로 처리하지 않게 하려는 것이다.

### `RoomNode` 스폰 필드 (G3)

`RoomNode`에 라이브 `creatures: CreatureInstance[]`(가변)와 스폰 정의 필드를 추가한다:

- `permMon: PermMonSlot[]` — `{interval, ltime, misc}`. `misc`는 스폰 몹번호, `interval`은 리스폰 지연(초), `ltime`은 마지막 스폰/사망 실초(가변)다.
- `random: number[]` — 배회 후보 몹번호(길이 10, 불변).
- `traffic: number` — 진입/퇴장 확률(불변).

### converter 확장 (`packages/port`)

`parseRoom.js`와 `convertWorld.js`가 방 레벨 스폰 필드를 emit한다. `perm_mon` 오프셋은 C oracle(`mstruct.h:154`)로 **@216으로 확정**했다(`random@192`, `traffic@212`는 기존 값). converter는 로더가 실제로 소비하는 번들 `rooms.json`, `meta.json`을 emit한다. embedded 몬스터는 `templates.js readCreature`를 재사용해 전체 1184B 필드를 인라인으로 추출한다. 빌더가 커스터마이즈한 스탯이 템플릿과 달라서 템플릿 링크로는 재구성할 수 없기 때문이다. 재변환의 멱등성과 orphan 제외 규칙은 그대로 유지한다.

별칭 `key[3][20]` 추출도 두 리더에 함께 들어간다. 하나는 `templates.js`(OBJ 160·CRT 255)이고, 다른 하나는 자체 오프셋 테이블을 쓰는 `parseRoom.js`다. 방 embedded 개체는 `templateId=null`이라 템플릿을 다시 조회할 수 없다. 그래서 `parseRoom.js` 쪽을 빼면 같은 몬스터라도 방에 따라 별칭이 있기도 하고 없기도 하다. 위생 규칙(공백만 있는 슬롯 드롭, 20B 절단, U+FFFD 보존)은 [`name-matching.md`](name-matching.md) §별칭 추출 위생을 따른다.

### `events.json` (invasion 데이터 정의)

`data/world/events.json`은 직접 작성한(hand-authored) 정적 파일이며 converter 산출물이 아니다. 원본에 하드코딩된 좌표를 데이터로 정의한 이벤트로 분리한다:

```json
{ "id": "chaos-invasion", "periodSec": 4000,
  "roomRange": { "min": 8000, "max": 8300 },
  "mobRange": { "min": 732, "max": 755 },
  "count": 50, "broadcast": "…" }
```

## 동작

### 활성 집합 (점유 이벤트 기반)

`tryMove` join 경로의 `onRoomEntered` entry-hook은 방에 첫 플레이어가 들어오면 방 크리처를 활성화하고, 크리처별 next-action 시각을 초기화한다. leave 경로의 `onRoomLeft` 훅(`broadcastLeave`와 대칭)은 방이 비면 크리처를 비활성화한다. 이 대칭 seam이 없으면 방↔방 이동 때 빈 방이 비활성화되지 않는다. 비활성 크리처의 상태와 타이머는 **동결**된다(빈 방에서는 시간이 멈춘다). `tryMove` 훅 순서는 delete→`onRoomLeft`, add→`onRoomEntered`다.

### next-action 큐 + autonomic 절단선

`creatureTick` 슬롯(1s)은 `nextActionAt`이 도래한 크리처만 처리한다. 도래한 크리처마다 `runAutonomic`을 실행하며, 처리 순서가 곧 우선순위다:

| A9 절 | 행동 | 처리 |
|---|---|---|
| §3.1 | 상태이상(MBEFUD)·charm(MCHARM) 만료 | 구현 |
| §3.2 | 재생 (60s마다 HP hpmax/10·MP mpmax/6, while 루프로 소급) | 구현 |
| §3.3 | scavenge (MSCAVE, 20s/15%, 바닥에서 처음 찾은 회수 가능 아이템) | 구현 |
| §3.4 | wander-out (배회 크리처가 적이 없을 때 확률적으로 퇴장, 확률=traffic) | 구현 |
| §3.5 | 조기종료 게이트(적이 없고 공격형이 아니면 종료) | 구현 (절단선) |
| §3.6~7 | 전투·어그로·특수공격 | `onCombatTick` seam → **E6** |

재생 소급은 활성화 시각을 기준으로 한다. 동결 구간(관측되지 않은 시간)은 소급하지 않는다. `onCombatTick`은 §3.5를 통과한 크리처(적이 있거나 공격형)에만 호출되며, E4-2의 기본 구현은 no-op이다.

### 스폰 3트리거

| 모델 | 트리거 | 조건 | 그룹 크기 |
|---|---|---|---|
| **perm** | 입장 기반(entry-hook) | `ltime+interval ≤ now`인 슬롯을 lazy 리스폰, 방 안에 살아 있는 같은 이름의 MPERMT 수만큼 차감 | 슬롯 몹번호별 |
| **random** | 20초마다 폴링하는 슬롯 | 활성 방 순회, `roll ≤ traffic` | `RPLWAN`이면 플레이어 수, 그 외 `numwander` |
| **invasion** | 이벤트 주기 슬롯 | `periodSec`마다 무조건 `count` 스폰 | 데이터에 정의된 `count` |

perm은 스케줄러를 쓰지 않고 입장 시점에 lazy하게 재계산한다. 빈 방에서는 미리 리젠하지 않으므로 "빈 방=시간 정지" 원칙과 일관된다. random의 `traffic`은 진입(이 슬롯)과 퇴장(§3.4 wander-out) 양쪽의 확률로 재사용된다. 스폰 3경로는 모두 방별 monotonic `InstanceIdAllocator`(D7)를 공유해, 사망 후 idx가 충돌하지 않게 한다.

### 사망 라이프사이클 + special 3도메인

`onCreatureDeath` seam은 E6이 HP<1을 판정한 뒤 호출하고, 처리는 E4-2가 맡는다:

- (a) MPERMT면 방 `permMon[]`에서 같은 이름의 슬롯을 `ltime = now`로 바꾼다(리스폰 타이머 리셋).
- (b) MSUMMO면 `creature.special`(소환 몹번호)로 `onDeathSummon`을 실행한다.
- (c) 활성 집합과 방 크리처 컬렉션에서 제거한다.

`special`은 3도메인에서 이름만 같고 뜻이 다르므로 통합 레지스트리를 만들지 않는다. creature `onDeathSummon`(MSUMMO)만 구현한다. room `special`(가문·결혼 게이트 → E5/E7)과 object `special`(명령 디스패치 → 명령 에픽)은 별개 개념의 seam이다.

### 컴포지션 루트 (`createWorldRuntime`)

`worldRuntime.ts`가 슬롯을 조립하고 훅을 연결한다. `index.ts`는 `now: () => worldClock.currentTick()` 하나만 주입하고, 반환된 `slots`를 register한다. `onRoomEntered`/`onRoomLeft` 훅은 구성돼 있다. 하지만 프로덕션에서 `tryMove`를 실제로 호출하는 쪽(movement 에픽)이 아직 없어 dormant 상태다. `alloc`과 `templates`는 E6 death 연결에서 재사용하도록 노출한다.

## 제약사항

- **invasion 게이팅**: invasion 슬롯은 실제 `invasionRng`가 주입될 때만 boot에서 register된다. E4-2 `index.ts`는 이를 주입하지 않으므로 invasion은 inert다.
  - invasion은 확률 게이트 없이 주기마다 무조건 `count`만큼 스폰한다. 그래서 기본 stub(항상 min)을 쓰면 고정된 방(8000·3601)에 결정적으로 누적된다. E4-2에는 전투 정리도, 해당 방 활성화도 없다.
  - 슬롯 자체는 조립되고 테스트된다. E8-2가 범위 분산 rng를 주입하면 바로 활성화된다.
- **RNG seam 결정적 stub**: 스폰 확률(traffic), scavenge 15%, wander-out, gold 랜덤화는 주입 seam이다. E4-2 기본값은 결정적이다(동작하지 않거나 identity). `spawnRng`를 주입하지 않으면 random 슬롯은 아무것도 하지 않는다. 실제 확률과 시드 규약은 E8-2 RNG가 이 seam으로 주입한다.
- **dormant 경계**: `onCombatTick`, broadcast, `onCreatureDeath`, entry/leave 훅은 모두 기본이 no-op인 주입 seam이다. 프로덕션에서 실제로 동작하는 것은 (게이트를 통과한 경우) invasion 슬롯뿐이다.
- **전투·전술 판정 범위 밖**: 전투 실행, 어그로 타깃(piety 역가중), 특수공격(breath, 드레인, 상태이상, 아이템파괴), 주문 시전, HP<1 사망 판정은 E6이 맡는다. 사망 보상(경험치, gold 드롭, 인벤 드롭)은 E6/E8이 맡는다.
- **명령·특수 디스패치 범위 밖**: 플레이어 WS 명령 연결, object/room `special` 디스패치, interactive talk는 명령 에픽/E5/E7이 맡는다.
- **데드 스캐폴드 미구현**: 몬스터 도주(MFLEER)와 주기 발화(MSAYTLK)는 출시본(as-shipped)에서도 동작하지 않는 데드 코드다. 그래서 그대로 재현한다(구현하지 않음). 되살릴지는 별도 결정 게이트에서 정한다.
- **영속화 없음**: 라이브 상태와 perm `ltime`은 인메모리에만 있고, write-back은 후속 작업이다. 재부팅하면 스폰 상태는 기본값으로 돌아간다.
