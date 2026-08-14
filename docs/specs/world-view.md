# 월드 뷰 (E11 — 방 표시·출구 이동)

> 방에 들어섰을 때 보이는 것을 화면에 낸다 — 이름·설명·출구·사람·사물·몬스터. 출구를 눌러 이동한다.

## 개요

CP1("걸어볼 수 있는 무한")이 요구하는 "방 설명을 읽고 이동한다"를 닫는 계층이다. 이슈 **#60**(E11).

착수 시점의 병목은 프론트엔드가 아니라 **프로토콜 한 겹**이었다. 데이터(`data/world/rooms.json` 2341방)와 서버 상태(`RoomNode`)는 이름·설명·출구·아이템·점유자·크리처를 모두 보유했으나, `world:room` 이벤트가 `{roomId, exits}`만 날랐고 클라이언트에는 `world:room`·`world:move` 처리가 0건이었다. 따라서 이 계층은 `shared`(와이어 계약) · `server`(파생 확장 + 가시성 필터) · `client`(수신·렌더·송신) 세 계층을 걸친다.

세 계층을 한 단위로 묶는 이유는 부분 착지가 성립하지 않기 때문이다 — 스키마만 넣으면 관측 가능한 변화가 0이고, 클라만 넣는 것은 필드 부재로 불가능하며, `PROTOCOL_VERSION` bump가 동시 착지를 강제한다(서버만 올리면 구버전 클라 핸드셰이크가 거부되고 그 역도 같다).

## 구조 / 스키마

### 컴포넌트 배치

| 파일 | 계층 | 역할 |
|---|---|---|
| `shared/src/protocol/events.ts` | shared | `world:room` variant 7필드 계약 |
| `shared/src/protocol/version.ts` | shared | `PROTOCOL_VERSION` — 이 계층이 3 → 4 bump를 소유했다(현재값은 [`transport-protocol.md`](transport-protocol.md)가 단일 출처) |
| `server/src/world/roomView.ts` | server | `projectRoomView` — 가시성 필터 + 이름 해소 순수 함수 |
| `server/src/world/door.ts` · `hexFlags.ts` | server | 표시 필터용 비트 상수(`XSECRT`/`XINVIS`, `OINVIS`/`MHIDDN`/`MINVIS`) |
| `server/src/ws/liveWorldWiring.ts` | server | `resolveCharacterName` 단일 인스턴스 파생 |
| `server/src/ws/liveWorldBinding.ts` | server | `buildRoomSummary` → 투영 위임 |
| `client/src/transport/wsClient.ts` | client | `room` 스냅샷 서브상태 · `characterId` 보관 · `move()` |
| `client/src/components/RoomPanel.tsx` | client | 방 패널 렌더 |

정본 분담 — 와이어 계약은 [`transport-protocol.md`](transport-protocol.md), 가시성 필터 규칙은 [`movement-rooms.md`](movement-rooms.md) §방 표시 가시성 필터, 서버 배선은 [`live-world-foundation.md`](live-world-foundation.md), 클라 스냅샷 층 경계는 [`session-entry.md`](session-entry.md). 이 문서는 E11이 세 계층을 어떻게 잇는지를 소유한다.

### `world:room` 페이로드

| 필드 | 형태 | 비고 |
|---|---|---|
| `roomId` | `int ≥ 0` | |
| `exits` | `string[]` | 출구 **이름**(인덱스 아님). 가시 출구만 |
| `name` | `string` | 빈 문자열 유효(97방) — 클라 fallback |
| `longDesc` | `string` | 빈 문자열 유효(433방, 18.5%) — 클라 fallback |
| `occupants` | `{ characterId, name }[]` | **본인 포함** — 제외는 클라 책임 |
| `items` | `{ instanceId, name }[]` | 바닥 아이템 |
| `creatures` | `{ instanceId, name, level }[]` | #99 미배선이라 정적 스냅샷 |

`shortDesc`는 싣지 않는다 — 2341방 중 2327방(99.4%)이 빈 문자열이라 정보량이 0이다. 문 상태(`XLOCKD`/`XCLOSD`)도 싣지 않는다 — `exits`는 `string[]`을 유지하고, 잠긴 문은 눌렀을 때 서버가 기존 `error{rule_rejected}`로 답한다.

### 클라이언트 상태

```
WsClientSnapshot
├─ status, events, errors …        전송 라이프사이클
├─ room: RoomState | null          ← 서버 권위 월드 스냅샷 (E11이 추가)
└─ session: { phase, characterList, activePrompt, lastError, characterId }
```

`RoomState`는 `Omit<Extract<ServerEvent, { type: 'world:room' }>, 'type'>`로 shared 계약에서 파생한다 — 서버의 `RoomView`와 같은 뿌리라 수기 재선언이 없고 스키마-소비자 드리프트가 타입 에러로 즉시 드러난다. `room === null`은 방 상태가 없는 구간을 표현한다(서버가 미해소 방이라 발화를 생략한 경우).

## 동작

### 서버 — 단일 투영을 두 생산자가 공유

`world:room` 발화 경로는 진입(`sessionFsm.enterCommand`)과 이동(`handlers/move.ts`) 둘뿐이다. 양쪽 모두 `{ type: 'world:room', ...projectRoomView(room, resolveCharacterName) }` 스프레드만 쓰고 필드를 손으로 열거하지 않는다 — 열거하면 두 경로의 페이로드가 조용히 분기한다. 통합 테스트가 같은 방에 대해 두 경로 산출이 동일함을 실물 점유자·아이템·크리처로 단정한다.

`resolveCharacterName: (characterId) => string | undefined`는 `createLiveWorldWiring`이 `liveRegistry.get(id)?.character.name`으로 **1회 생성**해 `liveWorldBinding`과 `moveDeps`에 같은 참조로 넘긴다(파일이 선언한 단일 공유 불변식). 레지스트리를 통째로 넘기지 않아 바인딩이 레지스트리 전 표면에 의존하지 않는다.

가시성 필터 규칙(숨김 아이템·숨김 크리처·죽은 개체·비밀 출구 제외)과 관찰자 비의존 계약은 [`movement-rooms.md`](movement-rooms.md) §방 표시 가시성 필터가 정본이다.

### 클라이언트 — 수신·렌더·송신

1. `dispatch`의 `world:room` case가 `type`을 뺀 나머지를 `room` 스냅샷으로 **교체**한다(누적이 아니라 치환 — 방을 옮기면 이전 방은 사라진다). 갱신은 전부 새 객체 재할당이다.
2. `session:entered`·`session:resumed` 양쪽이 `characterId`를 보관한다(본인 제외용).
3. `App`이 `phase === 'entered' | 'resumed'` 분기에서 `snapshot.room !== null`일 때만 `RoomPanel`을 `EventLog` **위에** 렌더한다.
4. 출구 버튼 클릭 → `WsClient.move(direction)` → `clientCommandSchema` 검증 → `world:move{direction}` 송신. 검증 실패 시 프레임을 보내지 않고 `false`를 돌려준다.
5. 서버가 응답 `world:room`을 발화하면 1번으로 돌아가 패널이 갱신된다.

출구 이름은 **가공 없이 그대로** 보낸다 — `world:move.direction`은 방 그래프 출구 이름과 정확 일치할 최종 문자열이며 방향 별칭 해소가 불필요하다.

### 표시 규칙

| 상황 | 표시 |
|---|---|
| `name === ''` | `이름 없는 곳` |
| `longDesc === ''` | `설명이 없다.` |
| `exits.length === 0` | `나갈 곳이 없다.` |
| `occupants`·`items`·`creatures`가 빈 목록 | 해당 섹션을 렌더하지 않음 |
| `characterId === selfCharacterId`인 점유자 | 사람 목록에서 제외 |

빈 `name`·`longDesc` 대체 문구는 **표시 계층이 소유한다** — 서버가 채우면 월드 데이터를 오염시킨다. 반면 `나갈 곳이 없다.`는 데이터 결손 대체가 아니라 가시 출구 0개인 방의 정식 카피다(빈 `exits`는 그 자체로 정확한 표현이다).

본인 제외를 클라가 맡는 이유: 서버가 수신자별로 페이로드를 달리하면 방 단위 fan-out 캐시가 불가능해진다.

**표시 경로와 지목 경로는 가시성 게이트가 다르다.** 이름으로 대상을 지목하는 경로가 [`name-matching.md`](name-matching.md)로 신설되면서 두 경로가 비대칭이 됐고, 이는 오라클을 그대로 따른 결과다.

| 게이트 | 표시(`roomView`) | 지목(`find_crt`) |
|---|---|---|
| `MINVIS`(크리처 투명) | 거름 | 거름 (관찰자 `PDINVI` 보유 시 통과) |
| `MHIDDN`(크리처 은신) | 거름 | **거르지 않음** — `find_crt`에 없다 |
| 사망(`hpcur <= 0`) | 거름 | 거르지 않음 (제거는 `creatureDeath` 소유) |
| 플레이어 `PHIDDN`·`PINVIS` | 미구현 (#129) | 미구현 (#129) |

즉 **숨은 크리처는 방 목록에 안 보여도 이름으로는 지목된다**. 오라클 그대로이므로 여기서 맞추지 않는다. 플레이어 가시성은 두 경로가 같은 관찰자 인자 설계를 공유해야 하므로 #129가 표시·지목을 함께 연다.

### 표시 안전

서버발 문자열(`name`·`longDesc`·`occupants[].name`·`items[].name`·`creatures[].name`)은 전부 React 텍스트 노드로만 렌더한다. `dangerouslySetInnerHTML`·`innerHTML`·`insertAdjacentHTML` 경로를 만들지 않으며(`packages/client/src` 전체 grep 0건), `<script>alert(1)</script>` 페이로드가 텍스트로 노출되고 `querySelector('script')`가 `null`임을 테스트가 단정한다.

`occupants[].name`은 플레이어가 캐릭터 생성 시 정한 **사용자 입력**이라 신뢰 경계 밖이다. 나머지도 1993년 월드 데이터에서 온 문자열이라 같은 규칙을 적용한다.

## 제약사항

- **`occupants`는 스냅샷이지 델타가 아니다** — 발화 시점이 진입·이동 성공 두 곳뿐이라, 내가 가만히 있는 동안 다른 사람이 들어와도 목록이 갱신되지 않는다. 실시간 입·퇴장 통지는 **#116** 소관이다.
- **`creatures`는 정적** — 몬스터 실시간 이동·전투(**#99**) 미배선. `name`·`level`만 싣는다(hp·전투 스탯은 E12 **#61**).
- **크리처 표시 문구가 근사** — 오라클 방 표시는 몬스터를 `description`으로 출력하고 동명 개체를 `(xN)`으로 묶는다. 이 계층은 `name`을 쓴다 — `CreatureInstance`에 `description` 필드가 없어 월드 로더·타입 변경이 동반되기 때문이다. 오라클 이식이 아니라 근사다.
- **`items`는 표시 전용** — 집기·버리기는 **#120**.
- **automap 없음** — 현재 방만 렌더한다. 좌표 합성은 서버가 그래프+방향 힌트만 권위이므로 별도 파생이 필요하다.
- **텍스트 명령 파서 없음** — 이동 입력은 출구 버튼뿐이다. 파서는 E12·E13도 요구하는 공통 관심사라 소비자가 셋일 때 한 번에 설계한다.
- **방향 별칭 단축키 없음** — numpad·자모·대각선은 향후 사용자 커스텀 단축키 기능이 흡수한다.
- **디자인 시스템 없음** — 기능-우선이며 스타일은 FE-6 소관이다. `RoomPanel`은 `aria-label`만 두고 클래스·스타일을 두지 않는다.
- **관찰자 비의존 투영** — 점유자 은신 필터·광원/실명 게이트를 구현하지 않는다. 현재 그 상태를 세울 라이브 경로가 없어 누출이 없으나 `magic/`·`combat/` 배선이 전제를 깬다([`movement-rooms.md`](movement-rooms.md)).
- **오류 배너가 해제되지 않는다** — `lastError`를 세팅하는 경로만 있고 해제 경로가 없다. 출구 버튼이 잠긴 문 거부(`rule_rejected`)를 일상 이벤트로 만들면서, 한 번 거부되면 이후 이동에 성공해도 배너가 남는다. 선재 기전이나 E11의 상호작용 모델에서 드러났다.
- **`EventLog` 누적 비용 재정량화** — `world:room`이 세션당 1건에서 **이동 횟수 비례**로, 페이로드도 방 전체 스냅샷으로 커졌다. `recordEvent`가 상한 없이 누적하고 `EventLog`가 매 렌더마다 전량을 `JSON.stringify`한다(메모이제이션 0건). 이 계층은 `EventLog`를 변경하지 않으므로 별도 항목이다.

## 관련 문서

- 선행: [`live-world-foundation.md`](live-world-foundation.md)(라이브 상태원·`tryMove` 결선) · [`movement-rooms.md`](movement-rooms.md)(월드 그래프·문 상태머신·가시성 필터) · [`transport-protocol.md`](transport-protocol.md)(와이어 계약·버전 협상)
- 지목 경로: [`name-matching.md`](name-matching.md)(표시와 다른 가시성 게이트 — 위 대조표)
- 클라이언트 선례: [`transport-shell.md`](transport-shell.md)(E9) · [`session-entry.md`](session-entry.md)(E10)
- 이슈: **#60**(E11 본 계층) · **#116**(이동 방송·점유자 델타) · **#99**(몬스터 tick) · **#120**(아이템 라이브화) · **#61**(E12 스탯·전투·인벤 패널)
