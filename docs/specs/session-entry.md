# 세션 진입 플로우 (E10-1)

> 웹 클라이언트가 서버 세션 FSM(캐릭터 목록·선택·생성·진입·재개)을 사용자 구동 구조화 UI로 소비하는 진입 계층. `autoSelect` 스텁을 실제 선택·생성·진입/재개·에러 표면화 흐름으로 대체하고, 진입 완료 후 placeholder 게임 셸을 표시한다.

## 개요

[`transport-shell.md`](transport-shell.md)(E9-1)가 WS 접속·`__session` 인증·hello→ready 버전 협상·`debug:echo` 왕복을 확립했고, [`auth-session.md`](auth-session.md)(E3-2)가 3층 세션 FSM(`characterSelect → create → command`)을, [`session-lifecycle.md`](session-lifecycle.md)(E3-3)이 재연결 재바인드(`session:resumed`)를 확립했다. 이 계층은 그 서버 FSM을 **재구현하지 않고** `shared/protocol` 계약 위에서 사용자 구동 UI로 소비한다.

진입 흐름은 서버 세션 FSM이 push하는 이벤트에 클라가 응답하는 왕복이다: 접속 시 `session:characterList` + select `session:prompt`가 도착하면 클라가 캐릭터 카드와 생성 진입 버튼을 렌더하고, 사용자가 카드를 선택(`session:selectCharacter`)하거나 생성 진입 옵션에 응답(`session:reply`)한다. 생성은 `createField` 다단 대화(name→class→race→confirm)를 제네릭 입력으로 왕복하며, 서버가 `session:entered`(신규 진입)/`session:resumed`(재개)를 발화하면 클라가 placeholder 게임 셸로 전이한다. `error` 이벤트는 code별로 배너에 표면화한다.

실제 월드 뷰·전투·소셜 UI는 이 토픽 범위 밖(E11~E13)이며, 진입 후 셸은 E9의 `EventLog`+`CommandInput` placeholder를 재사용한다.

## 구조 / 스키마

### 서버 seam (`packages/server/src/ws/fsm/sessionFsm.ts`)

`characterSelect` 상태의 `onEnter`가 select prompt를 emit할 때 생성 진입 옵션을 함께 싣는다:

```
session.emit({
  type: 'session:prompt',
  promptId: SELECT_CHARACTER_PROMPT_ID,
  kind: 'selectCharacter',
  options: [{ value: CREATE_SENTINEL, label: '새 캐릭터 생성' }],
})
```

이로써 클라는 `CREATE_SENTINEL`('create') 매직값을 하드코딩하지 않고 `option.value`를 그대로 `session:reply`로 되돌려 생성에 진입한다(프롬프트 자기기술 → `shared/protocol` 경계 유지). `session:prompt{promptId, kind, options?}` 와이어 계약 자체는 E3-2([`auth-session.md`](auth-session.md))가 이미 정의했으며, 이 변경은 select prompt가 그 `options`를 실제로 채우는 한 곳뿐이다 — FSM의 선택/생성/검증 전이 로직은 불변이다. class/race `createField` prompt에는 옵션을 싣지 않는다(서버가 카탈로그 없이 `z.coerce.number().int()`로 any 정수를 수용하므로 클라는 제네릭 텍스트/숫자 입력으로 렌더).

### 클라이언트 전송 상태 (`packages/client/src/transport/wsClient.ts`)

`WsClientSnapshot`에 세션 서브상태 `session`을 추가한다:

- `SessionPhase` — `connecting | negotiating | selecting | creating | entered | resumed`. 전송 라이프사이클 `status`(`disconnected`…`ready`)와 독립적으로 갱신되는 파생 필드다.
- `SessionState { phase, characterList, activePrompt, lastError, characterId }` — 진입 서브상태 단일 출처. `characterId`는 E11이 더했다 — `session:entered`·`session:resumed` 양쪽에서 보관하며 방 패널의 본인 제외에 쓴다.
- `ActivePrompt { promptId, kind, options? }` — 진행 중 prompt 요약.

**층 경계 규칙** — 스냅샷 최상위는 전송 라이프사이클 + **서버 권위 월드 스냅샷**이고, `session`은 진입 대화 서브상태다. E11이 최상위에 `room: RoomState | null`을 더하며 첫 월드-도메인 멤버가 생겼다([`world-view.md`](world-view.md)). 후속 에픽이 `progress:trained`·`chat:said`를 상태로 승격할 때 이 경계가 배치 근거다 — 진입 대화에 속하지 않는 서버 권위 상태는 최상위에 둔다.

`dispatch`가 `session:characterList`/`session:prompt`/`session:entered`/`session:resumed`/`error`를 이 세션 상태로 반영한다(변경 키만 새 `session` 객체로 교체하는 불변 재할당, 기존 `useSyncExternalStore` 구독 유지). 사용자 구동 명령 메서드 `selectCharacter(characterId)`·`replyPrompt(promptId, value)`를 노출하며, 둘 다 기존 `send()` 경로(`clientCommandSchema.safeParse` 검증)를 재사용한다. `replyPrompt`의 `value`는 호출자가 넘긴 그대로 전달한다(sentinel·confirm 값 하드코딩 없음). 이전 `autoSelect`/`selectSent` 스텁은 제거됐다.

### UI 컴포넌트 (`packages/client/src/components`, `App.tsx`)

- `CharacterList.tsx` — `CharacterList`/`CharacterCard`. 캐릭터 카드를 name·`Lv.{level}` 주표시, class·race 원시 정수 코드로 렌더하고 카드마다 '선택' 버튼(`onSelect(characterId)`)을 둔다. 목록이 비면 "캐릭터가 없습니다"를 표시한다. 순수 컴포넌트로 `WsClient`를 참조하지 않고 prop 주입만으로 동작한다.
- `SessionPrompt.tsx` — 제네릭 prompt 렌더. `options`가 있으면 각 `option.value`를 가공 없이 콜백에 넘기는 라벨 버튼을, 없으면 텍스트 입력 폼을 렌더한다. `STEP_GUIDANCE`(`create:name`/`create:class`/`create:race`/`create:confirm` → 안내 문구, 미매핑 promptId는 `FALLBACK_GUIDANCE`)로 각 단계 화면 안내를 표시하며, confirm 단계는 요구 확인값 `yes`를 안내 텍스트에 명시한다. 빈 입력은 제출하지 않는다.
- `SessionErrorBanner.tsx` — `error`가 `null`이면 아무것도 렌더하지 않고, 아니면 `CODE_GUIDANCE`(`unauthorized`/`forbidden`/`session_state` → 사용자 안내, 미매핑 code는 `FALLBACK_GUIDANCE`)와 서버 원본 `message`를 `role="alert"`로 함께 표시한다.
- `App.tsx` — `snapshot.session.phase`로 화면을 분기한다(`renderPhase`). `selecting`은 `CharacterList` + select `SessionPrompt`, `creating`은 `createField` `SessionPrompt`, `entered`/`resumed`는 게임 셸(`EventLog`+`CommandInput`)을 렌더하며 `resumed`일 때 "재접속됨" 문구를 함께 표시한다. `SessionErrorBanner`는 phase와 무관하게 상단에 항상 배치되어 흐름 위에 겹친다. prompt 응답 클로저는 렌더 시점 `activePrompt.promptId`를 캡처해 `replyPrompt`로 전달한다.

## 동작

### 캐릭터 목록·선택

버전 협상(`system:ready`) 완료 후 서버가 `characterSelect`로 진입해 같은 턴에 `session:characterList{characters[]}` + select `session:prompt`를 동기 발화한다. 클라는 `session:characterList` 수신 시 `characterList`를 스냅샷에 반영하고, select prompt(`kind === 'selectCharacter'`) 수신 시 phase를 `selecting`으로 전이한다. `App`이 카드 목록과 생성 진입 버튼을 함께 렌더한다. 사용자가 카드의 '선택'을 누르면 `selectCharacter(characterId)` → `session:selectCharacter{characterId}`가 송신되고, 서버가 소유권을 검증해 `session:entered`를 발화한다.

### 생성 다단 대화

select prompt의 '새 캐릭터 생성' 버튼을 누르면 `option.value`(=`CREATE_SENTINEL`)가 `session:reply`로 되돌아가 서버가 `create` 서브 FSM으로 전이한다. 서버가 `createField` prompt(name→class→race→confirm)를 순차 push하면 클라 phase가 `creating`으로 바뀌고 `SessionPrompt`가 제네릭 텍스트 입력으로 각 단계를 왕복한다. 검증 실패 시 서버는 현재 단계를 유지하고 `session_state` error를 보내므로, 클라는 같은 prompt에 재응답할 수 있다(`SessionErrorBanner`가 "다시 입력해 주세요" 안내). confirm 단계에서 `yes`를 입력해 완주하면 서버가 `session:entered`를 발화한다. create 진행 필드는 서버 권위(`createProgress`)이며 클라가 상태를 왕복 보관하지 않는다.

### 진입·재개 전이

`session:entered` 수신 시 phase를 `entered`, `status`를 `ready`로 전환하고 placeholder 게임 셸(`EventLog`+`CommandInput`)을 표시한다. `session:resumed`(재연결 재바인드) 수신 시 phase를 `resumed`로 전환하고 동일 셸에 "재접속됨" 문구를 함께 표시한다. `resumed` 처리는 "재개된 캐릭터로 게임 셸에 복귀"까지이며, [`session-lifecycle.md`](session-lifecycle.md)(E3-3)가 command 상태 rebind와 재개 신호만 제공하므로 단절 구간 이벤트 리플레이·월드 스냅샷 복원은 하지 않는다.

### 에러 표면화

`error{code, message}` 수신 시 `lastError`를 스냅샷에 반영하고 `SessionErrorBanner`가 code별 안내와 서버 message를 표시한다. `unauthorized`는 재인증 유도, `forbidden`은 권한 안내, `session_state`는 재입력 안내로 구분하며, 미매핑 code는 일반 오류 안내로 폴백한다. 에러는 phase 전이가 아니라 오버레이 배너이므로 진행 중 흐름 위에 겹쳐 표시된다.

### 계약 검증 (`e2e/transport.spec.ts`)

전송 왕복 e2e(E9-1 소유, G4 정본 검증)는 진입이 사용자 구동으로 바뀐 뒤 캐릭터 목록 도착을 기다렸다가 시드 캐릭터의 '선택' 버튼을 클릭해 `ready` 도달을 단언한다. autoSelect 제거로 클릭 없이는 `session:entered`가 발화하지 않으므로, 이 선택 단계가 e2e 진입 경로의 필수 단계다.

## 제약사항

- **재연결 시 세션 phase 미초기화** — `connect`/`disconnect`/`reconnect`는 `status`만 바꾸고 `session.phase`/`activePrompt`/`characterList`/`lastError`/`characterId`와 최상위 `room`을 리셋하지 않는다. `entered`에서 재연결하면 새 소켓이 `CONNECTING`인 동안 stale 셸이 유지되어, 이때 명령을 제출하면 `send()`가 소켓 non-null만 검사(`readyState` 미검사)하므로 브라우저가 `InvalidStateError`를 throw할 수 있다.

  **E11 이후 영향 범위가 넓어졌다** — 이전 판정은 "stale 셸, 비블로킹"이었으나 방 패널 도입으로 잔존 상태가 **조작 가능 표면**이 됐다. (a) 직전 방의 출구 버튼이 그대로 렌더되므로, 재연결이 다른 캐릭터로 착지한 뒤 서버가 미해소 방이라 `world:room` 발화를 생략하면 그 방에서만 유효한 방향으로 `world:move`가 나간다. (b) stale `characterId`는 `RoomPanel`의 본인 제외가 엉뚱한 점유자를 지우게 만든다. 여전히 `ConnectionStatus`가 실제 연결 상태를 독립 렌더하고 서버가 방향을 권위 판정하므로 치명적이지는 않으나, 단절 구간 상태 복원(#116·E3-3 재연결 에픽)이 닫아야 할 항목이다.
- **class/race 원시 코드** — 카드 표시와 생성 입력 모두 카탈로그 없이 원시 정수 코드다. 코드→이름 카탈로그·직업/종족 콘텐츠 이식은 E6 소관이다.
- **실제 월드 뷰 없음** — 진입 후 셸은 `EventLog`+`CommandInput` placeholder다. 방·이동·주변 렌더는 E11, 전투·인벤 패널은 E12, 소셜은 E13이 소유한다.
- **디자인·시각 스타일링 없음** — 컴포넌트는 최소 시맨틱 마크업만 제공한다(기능 freeze 후 별도 등록).
- **서버 세션 FSM 로직 소비만** — 선택/생성/검증 규칙·전이의 정본은 [`auth-session.md`](auth-session.md)이며, 이 토픽은 select prompt `options`를 채우는 seam만 건드린다. 클라는 그 FSM이 push하는 prompt/이벤트를 렌더할 뿐 진입 규칙을 재정의하지 않는다.
