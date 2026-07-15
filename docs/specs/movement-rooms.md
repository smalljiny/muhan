# 이동·방 (월드 그래프·tryMove·문 상태머신·방 채널)

> 무한의 첫 게임플레이 경로 — 인메모리 방 그래프 위에서 단일 `tryMove` 이동, 문 개폐/잠금 상태머신, 방=채널 방송, 출구 자동 재잠금·게임시각 월드클럭 슬롯을 제공한다.

## 개요

E4-1a 런타임 뼈대(1Hz `WorldClock`·타이머 주입 seam·graceful shutdown) 위에 무한 월드의 이동·방 서브시스템을 얹는다. 콘텐츠 출처는 `docs/notes/game-analysis-20260625/a4-movement-rooms.md`(A4)이며, 무한 월드가 **좌표 없는 방향성 그래프**, 이동이 **순차 게이트 건틀릿 → 점유자 리스트 재배치**, 문이 별도 엔티티가 아니라 **출구 플래그 상태머신**, 방이 곧 **메시지 채널**이라는 오라클 규명을 충실히 이식한다. 형상(원본 4중 이동 코드 복제·`load_rom` LRU 캐시·연결 리스트·`F_ISSET` 비트 배열)은 신규 스택으로 재설계한다.

캐릭터 스탯·전투·진영·레벨 게이트의 *실 강제*, 인벤토리·플레이어 WS 명령 배선, 클라측 automap 렌더는 범위 밖이며 seam으로 남긴다. A4 §1 20단 게이트 순서는 콘텐츠로 보존하되 **입력이 존재하는 강제 게이트 6종만 실 거부**하고 나머지는 순서-유지 pass-through stub이다.

## 구조 / 스키마

### 컴포넌트 배치

| 컴포넌트 | 위치 | 책임 |
|---|---|---|
| `RoomNode`·`ExitEdge`·`getDirectionHints` | `packages/shared/src/worldGraph.ts` | 인메모리 그래프 타입 + 방향 힌트 파생 순수 함수 |
| `loadWorldGraph` | `packages/server/src/world/worldGraph.ts` | `data/world/rooms.json` → `Map<roomId, RoomNode>` 로드 |
| `createGameTime` | `packages/server/src/world/gameTime.ts` | 게임시각 진행 월드클럭 슬롯 + `currentHour()` seam |
| `tryMove`·`chooseFleeExit` | `packages/server/src/world/tryMove.ts` | 통합 이동 경로 + flee 출구 선택 |
| `evaluateMoveGates` + 게이트 predicate | `packages/server/src/world/moveGates.ts` | A4 §1 게이트 건틀릿(강제 6 + 순서-유지 stub) |
| door 전이 함수·`keyMatch`·플래그 헬퍼 | `packages/server/src/world/door.ts` | open/close/lock/unlock 상태머신 + 열쇠 매칭 |
| `createCheckExitsSlot` | `packages/server/src/world/checkExits.ts` | 출구 타이머 자동 재잠금/재닫힘 월드클럭 슬롯 |
| `createRoomChannelAdapter` | `packages/server/src/ws/roomChannelAdapter.ts` | `ChannelPort` 실 구현 — 방 멤버 동기 fan-out |

### 그래프 타입 (`shared/worldGraph.ts`)

```ts
export type ExitEdge = {
  name: string
  targetRoomId: number   // raw exit의 room(대상 방 번호) 매핑
  flags: number[]        // 32비트 출구 플래그(바이트당 1원소). 라이브 가변(문 상태)
  key: number            // 열쇠 ID(keyMatch가 obj.ndice와 대조)
  ltime: number          // 마지막 상태 변경 실초(기본 0). 라이브 가변
  interval: number       // 재잠금/재닫힘 지연 초
}

export type RoomNode = {
  roomId: number
  name: string
  shortDesc: string
  longDesc: string
  exits: ExitEdge[]
  items: ItemInstance[]
  flags: number[]         // 64비트 raw 방 flags(8바이트). 불변(콘텐츠)
  occupants: Set<string>  // 방에 있는 characterId 집합. 라이브 가변
}

export type DirectionHints = { cardinal: ExitEdge[]; other: ExitEdge[] }
export function getDirectionHints(room: RoomNode): DirectionHints
```

**가변성 경계** (프로젝트 CRITICAL immutability 규칙의 의도된 carve-out): 라이브 가변은 `RoomNode.occupants`(점유자 Set)와 `ExitEdge.flags`·`ExitEdge.ltime`(문 상태머신)뿐이다. 정적 로드 필드 전부와 `RoomNode.flags`(64비트 방 flags)는 불변이다. 방 flags(불변)와 출구 flags(가변 문 상태)를 혼동하지 않는다.

`getDirectionHints`는 노드 필드로 물질화하지 않는 on-demand 파생 조회다. 출구를 기본 6방향(`동/서/남/북/위/밑`)과 그 외(명명·대각·밖)로 분류한다. 무한 월드에는 좌표(x/y/z)가 없어 좌표를 합성하지 않는다.

### 로드 (`server/worldGraph.ts`)

`loadWorldGraph(worldRoot?)`가 `rooms.json` 배열을 읽어 `room.id`를 키로 하는 Map을 구성한다. 출구는 `ltime=0`·`interval=DEFAULT_EXIT_INTERVAL_SEC(60)`으로 초기화하고, `occupants`는 빈 Set으로 시작한다(이동 시 채워짐). raw flags·items는 복사(deep-copy)해 폐기될 raw 번들과 배열을 공유하지 않는다. objmon 템플릿·리스폰·몬스터 로딩은 하지 않는다(후속 에픽). 순수 함수 — 전역·부수효과 없이 Map만 반환한다.

## 동작

### tryMove 통합 이동 경로

원본 A4 §8의 4중 복제 이동 코드(`move`/`go`/`flee`/`sneak`)를 단일 `tryMove(deps, actor, selector, mode)`로 통합한다. `mode ∈ {directional, named, flee, sneak}`는 **출구 선택 방식만** 분기하고 게이트 건틀릿 본체·통과 후 부수효과는 전 mode가 공유한다.

의존성은 인자 주입 seam(`TryMoveDeps`: `resolveRoom`·`currentHour`·`broadcastLeave`·`broadcastJoin`·`rng`)으로 받는다(전역 금지). 순서:

1. 출발 방 = `resolveRoom(actor.currentRoomId)`. 없으면 거부.
2. mode별 출구 해석 — `directional/named/sneak`는 `selector`와 이름이 일치하고 `XNOSEE` 아닌 출구를 선형 탐색, `flee`는 가시 출구 중 `chooseFleeExit(visibleExits, rng)`로 선택. 못 찾으면 거부.
3. 도착 방 = `resolveRoom(exit.targetRoomId)`. 미해석(dangling)이면 undefined를 그대로 건틀릿에 넘긴다.
4. 공유 게이트 건틀릿 `evaluateMoveGates` 실행. 거부면 이동 취소(재배치·방송 없음).
5. 통과 시 순서: `broadcastLeave`(actor가 아직 출발 방 점유자) → `occupants` 재배치(`source.delete`/`target.add`) → `broadcastJoin`(actor가 이미 도착 방 점유자).

`flee` 확률 선택은 `FleeRng` seam에 위임한다. E4-1b 기본 `defaultFleeRng`는 첫 가시 출구를 고르는 결정적 stub이라 단위 테스트가 결정적으로 통과한다. 실 확률(65%+dex 굴림)·시드 규약은 E8-2 RNG 규약과 정합해 이 seam에 주입한다. `directional/named/sneak`는 출구 선택 단계에서 의도적으로 동일한 이름 탐색이다 — 은신 유지 판정은 게이트 14(stub) 소관이라 선택 단계에서 갈리지 않는다.

### 게이트 건틀릿 (`moveGates.ts`)

A4 §1 순서(1b~20)를 `MOVE_GATE_GAUNTLET` 배열 순서로 인코딩한다. `evaluateMoveGates`가 순차 평가하며 첫 거부에서 즉시 정지한다. 순수 함수 — 입력을 변형하지 않는다.

| 순서 | 게이트 | 처리 | 대기 에픽 |
|---|---|---|---|
| 1b | dangling(`targetRoom===undefined`) | **강제** | — |
| 2 | 침묵 `PSILNC` | stub(pass) | E5 |
| 3 | 전투 중 | stub(pass) | E6 |
| 4 | 잠김 `XLOCKD` | **강제** | — |
| 5 | 닫힘 `XCLOSD` | **강제** | — |
| 6 | 비행 `XFLYSP` | stub(pass) | E5/E6 |
| 7·8 | 야간/주간 `XNGHTO`/`XDAYON` | **강제** | — |
| 9 | 경비 `XPGUAR`+`MPGUAR` | stub(pass) | E4-2 |
| 10·11 | 성별 `XFEMAL`/`XMALES` | stub(pass) | E5 |
| 12 | 무소지 `XNAKED` | stub(pass) | E5/E6 |
| 13 | 등반 `XCLIMB`/`XREPEL` | stub(pass) | E5/E6 |
| 14 | 은신 유지 | stub(pass) | E5/E6 |
| 15·16 | 레벨 `lolevel`/`hilevel` | stub(pass) | E5 |
| 17 | 정원 `RONEPL`/`RTWOPL`/`RTHREE` | **강제(근사)** | 가시성 필터 E5 |
| 18·19·20 | 패거리·결혼 | stub(pass) | E5/E7 |

gate 1(출구 존재)과 `XNOSEE` 이름 탐색 제외는 `tryMove`가 담당한다(건틀릿 밖). `MOVE_GATE_ORDER`는 게이트 이름을 순서대로 노출해 순서 검증 테스트에 쓴다.

**시간 게이트**는 게임시각(`currentHour`, 0~23)으로 strict 비교한다 — `XNGHTO`(야간전용)는 `6<t<20`에 거부(t=6·20 통과), `XDAYON`(주간전용)은 `t<6 || t>20`에 거부. **정원 게이트**는 알려진 근사다 — 원본은 가시 플레이어 수(`PINVIS` 제외)로 판정하나 여기서는 `occupants.size` 전 카운트로 근사한다(E5 가시성 필터 도입 후 정정).

### 문 상태머신 (`door.ts`)

문은 별도 엔티티가 아니라 출구 플래그 조합이다. 상태 2비트(`XCLOSD=3`·`XLOCKD=2`)와 능력 3비트(`XCLOSS=5`·`XLOCKS=4`·`XUNPCK=6`)로 상태머신을 이룬다. `hasFlag`/`setFlag`/`clearFlag`가 원본 `F_ISSET`(`flags[f/8] & (1<<(f%8))`)를 이식한다.

| 전이 | 전제 | 효과 |
|---|---|---|
| `openexit(exit, now)` | `XLOCKD` 아님 | `XCLOSD` 해제 + `ltime=now`(타이머 리셋) |
| `closeexit(exit)` | `XCLOSS` 능력 | `XCLOSD` 설정 |
| `lock(exit, key)` | `XLOCKS` + `XCLOSD` + `keyMatch` | `XLOCKD` 설정 |
| `unlock(exit, key, now)` | `XLOCKD` + `keyMatch` | `XLOCKD` 해제 + `key.shotscur -= 1` + `ltime=now` |

거부 경로는 부수효과 없이 `false`만 반환한다. `keyMatch(obj, exit)`는 이름이 아니라 숫자 매칭이다 — `obj.type === KEY(11) && obj.ndice === exit.key`. 열쇠 0 소진 시 파괴 처리는 호출자 seam이다. WS 명령 배선·인벤토리 조회·picklock(도둑 전용)은 모두 호출자 seam으로 범위 밖이다.

### 출구 자동 재잠금 (`checkExits.ts`)

`createCheckExitsSlot(graph)`는 `intervalSec=1`(매 틱 평가) 월드클럭 슬롯을 반환한다. `run(tickSec)`은 `now=tickSec`으로 그래프 모든 방·출구를 순회하며 만료(`ltime + interval < now`, strict less-than)를 판정한다. 두 능력 비트는 원본 `room.c:469`대로 `if / else if`로 배타 평가한다:

- 만료 `XLOCKS` → `XLOCKD`·`XCLOSD`를 **둘 다** 재설정(잠금은 닫힘을 함의). 이 분기가 잡히면 `XCLOSS`는 별도 평가하지 않는다.
- 만료 `XCLOSS`(단, `XLOCKS` 아님) → `XCLOSD`만 재설정.

즉 열고 들어간 문은 `interval`초 후 다시 닫히고 잠긴다. `ltime`은 재설정하지 않는다(재설정은 open/unlock만 담당). 라이브 문 상태를 in-place 변경하는 carve-out이며 그 외 입력은 변형하지 않는다.

### 게임시각 소스 (`gameTime.ts`)

`createGameTime(options?)`는 게임시각 진행 슬롯과 `currentHour()` 조회 seam을 반환한다. 원본 `update.c:717` `update_time` 케이던스 미러 — `intervalSec=150`(150 실초마다 발화), 발화당 `Time += 1`, 초기 `Time`은 주입 가능(기본 0). `currentHour()`는 `((Time % 24) + 24) % 24`로 0~23 계약을 입력과 무관하게 고정한다. 게임시각 상태는 전역 변수가 아니라 팩토리 클로저에 캡슐화한 라이브 가변이며, `currentHour`는 스냅샷이 아니라 라이브 클로저를 읽어 발화 후 변화를 반영한다.

### 방 채널 어댑터 (`roomChannelAdapter.ts`)

`createRoomChannelAdapter(deps)`는 `ChannelPort` 실 구현을 반환한다(생성자 주입 — `resolveRoom`·`sendTo`). `deliver(ctx)`는 발화자의 현재 방을 조회해 `occupants` 전 멤버에게 동기 fan-out한다. 방 미해석 시 조용히 no-op한다(배치 seam 미완 방어). `occupants`는 읽기만 한다. 가시성 필터(어둠·투명)와 발화자 자신 제외는 송신 시점 seam(`sendTo`)의 소관이며, 어댑터는 방 멤버십에 따른 fan-out 대상 집합만 결정한다. `deliver`는 동기(`void`) 시그니처를 유지한다(`channelPort.ts` 계약).

### 월드클럭 배선

`gameTime`·`checkExits`는 WS 명령 배선 없이 `WorldClock`만으로 동작하는 자족 슬롯이다. `index.ts` boot가 `createGameTime()`·`createCheckExitsSlot(worldGraph)`를 `WorldClock.register`한 뒤 `start`한다. 슬롯 실패 격리 logger는 `app.log.error`에 위임한다. `index.ts`는 커버리지 제외 배선 코드이므로 두 슬롯 동시 등록·발화는 별도 통합 테스트(`worldClockSlots.integration.test.ts`)가 검증한다.

## 제약사항

- **강제 게이트 6종만 실 거부** — 출구 존재+`XNOSEE`·dangling·`XLOCKD`·`XCLOSD`·시간·정원. 나머지 15종(진영·레벨·전투·경비 등)은 순서-유지 pass-through stub이며 입력 에픽(E4-2/E5/E6/E7) 대기다.
- **정원 게이트 근사** — 전 점유자 카운트로 판정한다(가시 플레이어 필터 `PINVIS`는 E5 입력). 투명 플레이어가 있으면 원본보다 빨리 만원 판정될 수 있다.
- **문 명령·인벤토리·picklock 미배선** — 전이 함수·`keyMatch` predicate만 제공한다. 플레이어 WS 명령(openexit/lock 등)·열쇠 오브젝트 실 조회·picklock(도둑 클래스·쿨다운·dex)은 호출자 seam(명령/인벤토리 에픽·E5).
- **actor 방 배치 미완** — `tryMove`의 `MoveActor.currentRoomId`는 후속 방 배치 에픽이 서버 세션 상태에서 채운다. 클라 메시지에서 직접 역직렬화하지 않는 것이 seam 계약이다. `resolveExit`의 `mode`·`selector`도 WS 명령 경계에서 런타임 검증(Zod)이 필요하다.
- **채널 기본 어댑터 교체 유예** — 실 어댑터는 주입 가능한 구현으로 제공만 하고, `plugin.ts`의 no-op 기본 어댑터 교체는 런타임 방 배치(초기 occupancy) seam이 붙는 시점으로 유예한다.
- **라이브 상태만 — write-back 없음** — 방 점유자·문 상태는 인메모리 라이브 상태다. 영속화(write-back)는 seam이며 재부팅 시 문 상태는 기본값(`ltime=0`·`interval=60`)으로 복귀한다.
- **좌표 없음** — 서버는 그래프+방향 힌트만 권위다. automap 좌표 합성·렌더는 클라 파생(E11).
- **flag 52 latent bug 미재현** — A4 §8이 경고한 `F_ISSET(ext, 52)` 경계 밖 접근(비트 52는 4바이트 출구 flags 범위 밖 → ltime 침범)은 어떤 게이트·flee 로직도 읽지 않는다.

## 관련 문서

- 선행: [`runtime-foundation.md`](./runtime-foundation.md) (E4-1a — `WorldClock`·타이머 seam·shutdown 수렴)
- ADR: [`architecture.md`](./architecture.md) (D1 런타임·틱, D2 월드 상태 영속화, D3 방=채널)
- 콘텐츠 출처: `docs/notes/game-analysis-20260625/a4-movement-rooms.md` (A4 — 이동·방·출구 의미론)
- 기존 seam: `packages/server/src/ws/channelPort.ts`(`ChannelPort`), `packages/shared/src/schema/roomState.ts`(영속 스키마)
- 이슈: #69 (E4-1b 이동·방), 부모 #34 (E4 월드 상태 엔진). 후속: #68 (E4-2 스폰·AI — 방 채널·점유자 소비), #71 (E8-2 property 테스트 — RNG 시드 규약)
