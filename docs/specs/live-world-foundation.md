# 라이브 월드 foundation (라이브 캐릭터 상태원·방 배치·이동 배선)

> 세션과 인게임 캐릭터 상태를 잇는 연결 조직. 캐릭터를 진입 시점에 1회 로드해 인메모리 라이브 객체로 담고, 저장된 방에 배치하고, `world:move`를 실 `tryMove`에 결선하고, 방 채팅을 실제로 전파하고, 종료 시 마지막 위치를 영속화한다.

## 개요

E4 월드 엔진([`movement-rooms.md`](movement-rooms.md)·[`runtime-foundation.md`](runtime-foundation.md))과 E3 세션 계층([`session-lifecycle.md`](session-lifecycle.md)·[`freechat-permission-seam.md`](freechat-permission-seam.md))은 seam-only 패턴으로 순수 핸들러와 포트만 제공하고 라이브 결선을 유예했다. 그 결과 `tryMove`·`occupants`·`createRoomChannelAdapter`는 완비돼 있으나 프로덕션 caller가 0건인 dormant 상태였고, `ActorContext`는 인증 신원만 실어 게임 상태를 읽을 곳이 없었다.

이 계층이 그 연결 조직을 세운다. **라이브 진실의 단일 출처**는 프로세스 메모리의 라이브 캐릭터 레지스트리이며(`architecture.md`의 "라이브 상태 = 프로세스 메모리 객체 그래프" 결정과 정합), 명령 핸들러는 `actor.characterId`로 레지스트리를 조회해 상태를 읽고 in-place 변이한다. 이 토픽이 동작 배선하는 라이브 필드는 `currentRoom` 하나이며, HP/MP/spells/인벤 등 나머지 필드는 로드되나 dormant다(후속 규칙 배선 토픽이 소비).

walking-skeleton 완결 조건은 **입장 → 저장된 방 배치 → 이동 → 점유 갱신 → 같은 방 채팅 전파 → 종료 시 위치 저장**이다.

## 구조 / 스키마

### 컴포넌트 배치

| 파일 | 레이어 | 역할 |
|---|---|---|
| `server/src/world/liveCharacterRegistry.ts` | world | `character._id → LiveCharacter` 인메모리 Map. 등록·조회·제거·목록. |
| `server/src/world/liveCharacterEntry.ts` | world | 진입 코어 — `hydrate`(로드) / `place`(방 배치) / `release`(퇴장). |
| `server/src/ws/handlers/move.ts` | ws | `world:move` → 레지스트리 조회 → `tryMove` → `currentRoom` 갱신 + `markDirty`. |
| `server/src/ws/liveWorldBinding.ts` | ws | FSM이 소비하는 `SessionLiveWorld`(hydrate/place/roomSummary) 조립. |
| `server/src/ws/liveSessionLifecycleAdapter.ts` | ws | 세션 종결 시 `markDirty` → `release` 수렴하는 실 `SessionLifecyclePort`. |
| `server/src/ws/liveWorldWiring.ts` | ws | 부트 의존 묶음을 진입·이동·수명·방 채널 seam으로 파생하는 조립 팩토리. |
| `server/src/world/roomTargetResolvers.ts` | world | 방 스코프 크리처·플레이어 이름 해소자 + `find_crt` 가시성 게이트. 정본은 [`name-matching.md`](name-matching.md). |

레이어 방향은 ws → world 단방향이다. 세션 수명 어댑터는 도메인 상태를 변이하지만 **세션 종결이라는 transport 수명 이벤트에 반응하는 ws 관심사**이므로 포트·no-op 형제와 같은 `ws/`에 둔다. `world/`에 두면 도메인이 ws 포트를 역참조해 레이어링이 뒤집힌다.

### `LiveCharacter`

```ts
interface LiveCharacter {
  readonly character: Character              // 라이브 가변 문서
  readonly inventory: readonly ObjectInstance[]  // 소지품 인스턴스(#120)
}
```

`inventory`는 세션 진입 시 1회 적재되는 소지품 스냅샷이다(#120). 인스턴스는 **런타임 가변값만** 담고(`shotscur`·`slot`·`equipped`·`owner`) 불변 스탯·이름·별칭은 템플릿이 소유하므로, 소비자는 `items/objectPairing.ts`로 두 참조를 결합해 쓴다([`items-equipment.md`](items-equipment.md)). 갱신은 배열 교체(`{ ...live, inventory }`)로만 하고 in-place 변형하지 않는다 — `character`의 carve-out은 `inventory`로 확장되지 않는다.

**방 위치의 단일 출처는 `character.currentRoom`이며, 별도 방 필드를 두지 않는다.** 같은 원칙을 소유 계정에도 적용해 `character.accountId`(필수 FK)로 역참조하고 복제 필드를 만들지 않는다 — 같은 값의 출처가 둘이 되어 분기하는 것을 구조적으로 막는다. `character` 자체는 immutability 규칙의 **승인된 라이브 carve-out**으로, 이 계층은 `currentRoom`만 in-place 갱신한다.

레지스트리는 `combatRegistry`와 **분리한다**. 이 계층은 장비·유효 스탯을 다루지 않아 `PlayerCombatState`(유효 스탯 컨텍스트·장비 해소 요구)를 파생할 수 없고, `combatRegistry`는 런타임 caller 0건(dormant)이라 지금 통합해도 이득이 없다. 후속 전투 배선 토픽이 `LiveCharacter.character`에서 필요 시점에 파생해 등록하면 되므로 분리가 재설계를 강제하지 않는다. `liveCharacterRegistry.ts`는 `combat/`에서 아무것도 import하지 않는다.

### 프로토콜 표면

이 계층이 도입한 variant 3종은 [`transport-protocol.md`](transport-protocol.md)가 정본이며(`PROTOCOL_VERSION` 현재값도 그쪽이 단일 출처다 — 이 계층은 1 → 2 bump를 소유했다) 요약은 다음과 같다.

| 방향 | variant | 형태 |
|---|---|---|
| client → server | `world:move` | `{ direction: string(1~32), id?: string }` |
| server → client | `world:room` | `{ roomId, exits, name, longDesc, occupants[], items[], creatures[] }` (E11에서 7필드로 확장) |
| server → client | `chat:said` | `{ channel, speakerCharacterId, text, target? }` |

`world:move.direction`은 방 그래프 출구 **이름**과 정확 일치할 문자열이다. 방향 별칭·단축키(numpad·자모·대각선) 해소는 **클라이언트 책임**이며, 서버는 해소된 최종 문자열만 받아 `resolveExit` mode를 `directional`로 고정한다 — flee/sneak/named mode를 와이어에 노출하지 않는다. 상한 32는 입력 위생이다(방 그래프의 어떤 출구 이름도 이 안에 든다).

## 동작

### 진입 (hydrate → place)

`hydrate(characterId)`는 **부수효과 없는 비동기 로드**다. 레지스트리 등록도 occupants 변경도 하지 않고 `LiveCharacter`만 조립해 돌려주며, 등록·배치는 동기 caller인 `place`의 몫이다.

1. 이미 등록된 엔트리가 있으면 `findById` 없이 그대로 반환한다 — **재접속은 재로드하지 않는다.** 재로드하면 아직 영속되지 않은 라이브 `currentRoom`을 디스크 문서로 덮어쓴다.
2. `peekPendingCharacter(characterId)`로 미영속 스냅샷을 **동기로 먼저** 조회한다(아래 pending overlay).
3. 문서가 없으면 던진다.
4. 스냅샷이 있으면 DB 문서 위에 overlay한다.
5. `currentRoom`이 월드 그래프에서 미해소(orphan/삭제)면 `DEFAULT_START_ROOM = 1`로 교정하고 경고를 남긴다. 캐릭터 생성 기본값(START_ROOM=1)을 미러하는 단일 안전 홈이며, 레벨·종족·소속별 완전한 스폰 정책은 이 계층 범위 밖이다.
6. `hydrateInventory(characterId)`로 소지품을 적재해 `LiveCharacter.inventory`에 싣는다(#120). 조기 반환 경로(1번)는 이미 인벤을 가진 엔트리를 돌려주므로 재조회하지 않는다.

#### pending 스냅샷 overlay (#124)

1번의 재로드 금지는 **엔트리가 살아 있는 동안**만 유효하다. grace 만료로 엔트리가 완전히 release된 뒤 재접속하면 `findById`가 저장소를 다시 읽는데, write-behind에서 저장소는 flush 전까지 정의상 stale하다. 그 재읽기 결과가 같은 `characters:<id>` 키에서 LWW 승자가 되어 진행도가 되돌아갔다 — grace(30초)가 flush 주기(120초)보다 짧아 창이 상시 열려 있었다.

`hydrate`는 저장소 문서 위에 `SaveEngine.peekPending('characters', id)`의 반환값을 덮는다. `CharacterRepository.updateById`가 검증된 patch를 `$set`하므로, 같은 정규화·검증·합성을 하면 **재접속 직후 상태 = flush 직후 상태**가 정의상 성립한다.

- **조회 순서가 계약이다** — `peekPending`을 `findById`보다 **먼저** 동기로 끝낸다. 역순이면 TOCTOU가 열린다: `await` 중 in-flight write가 착지·ack되면 스냅샷이 사라지고, 이미 낡은 문서를 손에 쥔 채 "미영속 없음"으로 판정해 진행도가 되돌아간다. 이 순서는 최악이라도 이미 저장된 값을 다시 덮는 것뿐이다.
- **역방향 레이스는 도달 불가다** — "peek 직후 새 `markDirty`가 생겨 `findById`가 그보다 앞선 값을 읽는다"는 경로는 비-라이브 캐릭터에 writer가 존재하지 않아 성립하지 않는다(`train`·`move`·`study`는 라이브 actor를, `regen`은 라이브 플레이어 순회를, `onSessionEnd`는 레지스트리 엔트리를 각각 요구한다). 이 경로는 `liveRegistry.get` 미스 뒤에만 도달하므로 그 시점의 writer는 0개다.
- **검증은 영속 경로와 같은 스키마 인스턴스로 한다** — `characterPatchSchema`는 의존 0 모듈 `repo/characterSchemas.ts`가 소유하고 저장소와 여기가 같은 인스턴스를 쓴다. 재파생하면 overlay가 받아들인 patch와 flush가 저장할 patch가 갈리는데, 그 불일치는 예외도 로그도 남기지 않는다.
- **검증 실패는 던지지 않는다** — `logger.error` 1건을 남기고 저장소 문서로 폴백한다. 검증을 통과하지 못하는 스냅샷은 flush에서도 `ZodError`로 폐기되므로 폴백값이 곧 최종 영속값이다. 진행도 일부를 잃는 쪽이 진입 자체를 막는 것보다 낫다.
- **값이 `undefined`인 키는 떨군다** — zod `.partial()`은 키가 존재하면 값이 `undefined`여도 출력에 남긴다. 그대로 spread하면 `{ gold: undefined }` 같은 patch가 `stored`의 필수 필드를 지워, 타입은 `number`인데 런타임 값이 `undefined`인 캐릭터가 레지스트리에 들어가고 다음 flush가 그 `undefined`를 `$set`한다.
- **`_id`는 항상 요청한 `characterId`로 고정한다** — `peekPending`이 이미 `_id`를 벗겨 주지만, 스냅샷이 엉뚱한 `_id`를 들고 있을 때 라이브 엔트리의 신원이 바뀌면 이후 모든 마킹·해소가 잘못된 키로 간다.
- **overlay는 orphan 폴백보다 앞에 온다** — pending의 새 `currentRoom`이 유효한데 저장소 문서의 것이 orphan이면, 순서가 뒤집힐 경우 멀쩡한 위치를 버리고 시작 방으로 되돌린다.
- **보장 범위** — "pending이 `DirtyTracker`에 살아 있는 동안 hydrate가 그것을 채택한다"이고, 그 수명은 [`save-policy.md`](save-policy.md) §스냅샷 수명 계약이 정의한다. write가 영구 실패해 `discard`된 스냅샷은 범위 밖이다.

인벤 적재가 추가하는 DB 왕복은 **세션당 정확히 1회**이며(단위 테스트가 이 상한을 고정해 N+1 유입을 막는다) `owner` 복합 인덱스를 탄다. 조회 실패는 **fail-closed**다 — 예외가 FSM으로 올라가 `error{internal}`로 진입이 거부된다. 빈 인벤으로 degrade하지 않는 이유는 소지품을 조용히 감추는 쪽이 더 나쁘기 때문이다. 소유 object 수 p95 > 50건 또는 hydrate p95 > 200ms가 관측되면 진입 지연 측정 토픽을 연다(구현부 헤더가 이 임계를 소유한다).

`place(live)`는 동기이며 occupants Set을 in-place 변경한다.

1. 방 미해소면 던진다 — `hydrate`가 유효 방을 보장하지만 async hydrate와 sync place 사이에 그래프가 바뀔 수 있는 TOCTOU 가드다. 배치 계약 경계이므로 `tryMove`의 soft `NO_EXIT`과 달리 조용히 삼키지 않는다.
2. 이미 점유자면 즉시 반환한다(**멱등** — 재접속의 중복 추가·중복 훅 호출 방지).
3. 레지스트리 등록 → `occupants.add` → `onRoomEntered` 훅.

FSM(`sessionFsm.ts`)은 레지스트리·월드 그래프를 직접 만지지 않고 주입된 `SessionLiveWorld`의 3콜백(`hydrate`/`place`/`roomSummary`)만 호출한다. 인터페이스는 소비자인 FSM이 소유하고(DIP), `liveWorldBinding.ts`가 실 진입 코어·그래프로 배선한다.

`enterCommand`가 **`enterWorld`(세션 등록/재연결 rebind) → `place` → `session:entered`/`session:resumed` → `world:room`** 순서를 소유한다. 이 순서를 함수 하나가 소유해야 caller가 순서를 어겨 옛 세션 종결(등록이 트리거)이 새 배치를 지우는 레이스를 만들 수 없다. `world:room`은 `place` 실행 여부와 독립적으로 `live.character.currentRoom`에서 파생하므로 place가 no-op된 resumed 경로에서도 발화된다 — 재연결 클라도 command 상태에 진입해 자기 위치가 필요하기 때문이다.

라이브 월드 의존이 미주입이면 진입 seam 전체를 건너뛴다(기존 동작 보존).

### 이동 (`world:move`)

1. `liveRegistry.get(actor.characterId)` — 미등록이면 `error{internal}`(배선 격리). `currentRoom`은 **오직 레지스트리에서** 읽고 actor에서 읽지 않는다(actor에는 방 필드가 없다).
2. `MoveActor{characterId, currentRoomId}` 조립 → `tryMove(deps, actor, direction, 'directional')`.
3. 거부 → `error{rule_rejected, reason}`(`id`가 있으면 correlationId 반향). `tryMove`가 어떤 mutation·방송보다 먼저 bail하므로 거부 경로에서 라이브 상태와 markDirty는 불변이다.
4. 성공 → `live.character.currentRoom`을 도착 방으로 in-place 갱신하고 `markCharacterDirty(id, live.character)`로 **전체 문서 스냅샷**을 write-behind한 뒤 `world:room` 반환. 페이로드는 필드를 손으로 열거하지 않고 `projectRoomView(arrivedRoom, resolveCharacterName)` 스프레드로 조립한다(아래 §방 뷰 투영). `exits`는 출구 **이름** 목록이다(인덱스가 아니다). 부분 스냅샷 `{currentRoom}`을 넘기지 않는 이유는 [`save-policy.md`](save-policy.md)의 `characters` 전체 문서 계약을 참조한다.

점유자 재배치·leave/join 방송·leave/enter 훅은 전부 `tryMove`가 소유한다 — 핸들러는 occupants Set을 건드리지 않는다.

### 방 채널 전파

`liveWorldWiring`이 실 `ChannelPort`를 조립해 `chat:message`가 같은 방 점유자에게 실제로 전파된다(이전에는 로깅만 하는 no-op 어댑터였다).

fan-out 대상 결정은 `createRoomChannelAdapter`(발화자 현재 방의 occupants 전 멤버)에 위임하고, 조립 팩토리는 멤버 한 명에게 실제로 보내는 `sendTo` 클로저 하나만 담당한다 — **이것이 유일한 transport 결합 지점**이다. `sendTo`는 세션 색인에서 바인딩을 찾고 소켓을 역참조해 `ChannelDeliveryContext`를 `chat:said`로 평탄화한 뒤 `safeSend`로 내보낸다. 미등록 멤버·정리된 소켓은 조용히 스킵한다. Socket 타입이 제네릭이라 fake 소켓으로 단위 테스트된다.

발화자 방 해소자는 `characterId → 레지스트리 엔트리 → currentRoom → 방` 경로로 단일 출처를 따른다.

### 종료 수렴 (`SessionLifecyclePort`)

세션 종결 시 두 단계를 **이 순서로** 처리한다.

1. `markCharacterDirty(id, live.character)` — 종료 시점 캐릭터를 전체 문서로 스냅샷.
2. 진입 코어의 `release` — `occupants.delete` → `onRoomLeft` → 레지스트리 제거.

**dirty-before-release가 순서 계약이다.** release가 엔트리를 제거하면 `currentRoom`을 더 이상 읽을 수 없다. `release` 내부의 `occupants.delete` → `onRoomLeft` 순서도 계약이며(leave-hook은 빈 방을 전제로 비활성화한다) `tryMove`의 순서를 미러한다.

이 `markDirty`는 이동 핸들러의 write-through와 중복이 아니다. **한 번도 이동하지 않고 종료한 경로에서는 유일한 영속 경로**이며, 특히 hydrate가 orphan `currentRoom`을 폴백으로 교정한 경우 그 교정은 이 지점에서만 영속된다. 향후 비-이동 `currentRoom` 변이(recall·teleport·respawn)가 자기-markDirty를 빠뜨려도 여기서 최종 값이 잡힌다.

종료 사유(`evictedByNewLogin`·`graceExpired`·`idleTimeout`·`shutdown`)는 읽지 않는다 — 네 경우 모두 "위치를 저장하고 점유를 푼다"는 동일 후처리를 요구한다. 미등록 characterId는 no-op으로 흡수해 중복 종료 통지를 안전하게 흘린다.

포트 계약대로 **동기**다. 인메모리 변이와 `markDirty`(동기 side registry 기록)만 하고 실 DB write는 저장 스케줄러의 비동기 flush가 소유한다 — 신규 영속 인프라는 0이다.

### 조립 (부트 → 팩토리)

부트(`index.ts`)는 원재료 묶음(월드 그래프·레지스트리·characterRepo·markDirty·peekPending·currentHour·방 진입/퇴장 훅·logger·오브젝트 템플릿 인덱스·`now`)만 조립해 넘기고, `createLiveWorldWiring`이 진입 바인딩·이동 의존(`moveDeps`)·연마 의존(`trainDeps`)·비법서 연마 의존(`studyDeps`)·수명 포트·방 해소자(`resolveRoom`)·`markCharacterDirty`·`markObjectDeleted` seam을 파생한다. 부트는 커버리지 제외 배선 코드이므로 파생 로직을 테스트 가능한 순수 팩토리로 뽑고 부트에는 묶음 전달만 남긴다.

규칙 명령이 늘어도 원재료는 **거의** 늘지 않는다 — 팩토리가 기존 묶음에서 명령별 deps를 파생하기 때문이다. `train` 배선은 신규 원재료 0건이었고, `study` 배선은 `objectTemplates`(부팅 시 1회 조립하는 템플릿 인덱스)와 `now`(실명 만료 판정 기준 틱) 둘만 더했다. 두 번째 영속 seam인 `markObjectDeleted`는 원재료가 아니라 기존 `bundle.markDirty`에서 파생한다 — `markCharacterDirty`와 같은 규약이다.

`markCharacterDirty`는 원시 `bundle.markDirty`를 1회 감싼 **단일 인스턴스**로, `moveDeps`·`lifecyclePort`·`trainDeps`가 같은 참조를 공유한다(`characters` 스냅샷 계약의 단일화 — [`save-policy.md`](save-policy.md)). 읽기 짝인 `peekPendingCharacter`도 같은 규약이다 — 팩토리가 원시 `bundle.peekPending`을 `CHARACTERS_COLLECTION`으로 **1회 좁혀** 진입 코어에 준다. 좁힘이 여러 곳에 흩어지면 컬렉션 리터럴 오타가 조용한 "pending 없음"이 되어 #124가 되살아난다. save 계층은 collection 무지라 반환이 `unknown`이고, 좁힘 지점이 아니라 **소비 지점**(hydrate)이 자기 스키마로 런타임 검증한다.

`LiveCharacterEntryDeps.peekPendingCharacter`는 **optional이 아니다**. 미주입이면 hydrate가 DB 문서만 읽어 진행도를 되돌리는데 그 실패는 예외도 로그도 남기지 않으므로, 배선 누락을 타입으로 차단한다. 같은 이유로 `EntryLogger`에 `error`가 추가됐다 — 검증 실패를 폴백으로 삼키되 흔적은 남긴다. `resolveRoom`은 `characterId → 레지스트리 엔트리 → currentRoom → 방` 경로의 by-character 해소자이며, 소비자가 방 채널 조립에 더해 `trainDeps`까지 둘로 늘었다(방 그래프 직접 조회 `roomId → 방`은 별개 해소자다).

**단일 공유 불변식**: 진입 코어와 레지스트리는 hydrate/place·이동·종료 release·발화자 방 해소가 **동일 인스턴스**를 배후에 둬야 상태가 분기하지 않는다. 팩토리가 진입 코어를 1회 생성해 네 소비자에 같은 참조를 전달한다.

`resolveCharacterName: (characterId) => string | undefined`도 같은 규약을 따른다 — 팩토리가 `bundle.liveRegistry.get(id)?.character.name`으로 클로저를 **1회 생성해** `liveWorldBinding`과 `moveDeps`에 같은 참조를 넘긴다(테스트가 참조 동일성으로 단정). 레지스트리를 통째로 넘기지 않고 해소자 하나만 주입해 바인딩이 레지스트리 전 표면에 의존하지 않게 한다.

**방 스코프 대상 해소자 2종**(`resolveRoomCreature`·`resolveRoomPlayer`)이 `resolveCharacterName`의 역방향 형제로 함께 노출된다 — 저쪽이 id→이름이면 이쪽은 이름→대상이다. 규칙 본체는 [`name-matching.md`](name-matching.md)가 소유하고 여기서는 배선만 한다.

- `resolveRoomCreature`는 의존이 없어 모듈 함수를 그대로 싣는다(참조가 곧 단일 인스턴스). 관찰자 flags는 **호출 인자**이지 배선 원재료가 아니다 — 호출부가 `composeCharacterFlags(character, now)`로 합성해 넘기므로 `now` 의존성이 순수 해소자 밖에 남는다.
- `resolveRoomPlayer`는 위 `resolveCharacterName` **인스턴스를 재사용해** 1회 생성한다(불변식 확장). 새로 만들면 지목 경로가 두 `world:room` 생산자와 다른 클로저를 배후에 두게 되어 "보이는 이름"과 "지목되는 이름"이 갈린다. 테스트가 행동 동등이 아닌 **객체 동일성**으로 이를 잡는다.

### 방 뷰 투영 (`world/roomView.ts`)

`projectRoomView(room, resolveCharacterName)`가 `RoomNode`를 `world:room` 표시 페이로드로 거르는 **순수 함수**다. 정본은 [`movement-rooms.md`](movement-rooms.md) §방 표시 가시성 필터.

진입(`sessionFsm.enterCommand`)과 이동(`handlers/move.ts`) 두 발화 경로가 이 단일 투영을 공유해 같은 방에 대해 **동일한 페이로드**를 낸다. 두 생산자가 필드를 각자 열거하면 진입·이동 페이로드가 조용히 분기하므로, 양쪽 모두 `{ type: 'world:room', ...projectRoomView(...) }` 스프레드만 쓴다.

`buildRoomSummary(resolveRoom, resolveCharacterName)`는 이 투영에 위임하며 미해소 방은 계속 `undefined`를 돌려 발화를 생략한다. FSM 쪽 `SessionLiveWorld.roomSummary`의 반환 타입은 server 셸 모듈이 아니라 shared 계약(`Omit<Extract<ServerEvent, {type:'world:room'}>, 'type'>`)으로 표현해 3층 경계를 유지한다.

명시 `lifecyclePort`·`channelPort`가 함께 주어지면 묶음 파생보다 우선한다(explicit > bundle). 묶음 미주입이면 라이브 상태 seam을 요구하는 게임 명령(`world:move`·`progress:train`)이 라우터에 등록되지 않아 `unknown_type`으로 남고, 진입 seam도 통째로 생략된다(조건부 등록 번들 `GameCommandDeps`는 [`transport-protocol.md`](transport-protocol.md)가 정본).

부트는 `onRoomEntered`/`onRoomLeft`를 월드 런타임 훅에 위임해 이동과 세션 진입/퇴장이 **동일 활성 집합**을 갱신하게 한다 — 이전까지 dormant였던 활성 집합 경계가 여기서 해소된다.

## 제약사항

- **이동 leave/join 방송 미결선** — `tryMove`의 `broadcastLeave`/`broadcastJoin`은 no-op으로 채운다. 방 채팅 전파는 채널 포트가 소유하고, 이동 통지(누가 들어왔다/나갔다)는 후속 토픽 몫이다.
- **규칙 명령은 `train`·`study` 둘이 배선됨** — 이 foundation 위에 `progress:train`(디스패처 패턴 확립 + 레벨·경험치·gold·능력치 변이)과 `progress:study`(#120 — 소지품 이름 해소 + 주문 지식 변이 + 비법서 소멸)가 얹혔다. 나머지 규칙 명령은 여전히 미배선이며 선행 결손이 배선이 아닌 신규 구현을 요구한다: `teach`(#119)·`attack`(#121)·`cast`(#122). 장비 슬롯 스탯 파이프는 여전히 dormant다(#121).
- **인벤 서수 기준이 오라클과 다르다** — 오라클 `add_obj_crt`(`legacy/muhan/src/player.c:857-898`)는 EUC-KR `strcmp` 이름 사전순(동명 시 `adjustment` 순) 삽입으로 인벤 순서를 유지하지만, 포트는 `findByOwner`의 `_id` 오름차순이다. KS X 1001 완성형 배열이 Unicode Hangul Syllables 배열과 달라 JS 문자열 비교로 재현되지 않는 것이 원인이며, 방 대상 서수 divergence(#137)와 같은 성격이다. `_id` 정렬은 **결정적 순서를 보장하기 위한 것**이지 오라클 재현이 아니다(Mongo 자연 순서는 계약이 아니라 같은 인벤이 조회마다 다른 서수를 낼 수 있다). 추적 이슈 [#142](https://github.com/smalljiny/muhan/issues/142), 근거는 `world/liveCharacterEntry.ts` 헤더가 소유한다.
- **인벤 변경의 영속 경로는 삭제뿐** — `study`의 비법서 소멸만 `markObjectDeleted`로 write-behind에 실린다. 착용 토글·`shotscur` 감소·줍기 같은 비-삭제 인벤 변경은 라이브 메모리에만 남고 영속되지 않는다. 해당 명령들이 배선될 때 함께 온다.
- **pending overlay는 캐릭터 문서에 한한다(#124)** — hydrate가 합성하는 것은 `characters` 스냅샷뿐이고 `objectDeletions`는 합성하지 않는다. 그래서 grace 만료 재접속 시 삭제 마킹됐지만 아직 flush되지 않은 비법서가 인벤에 **유령으로 남는다**. 현재 무해하다 — 재연마 시 `setKnown`·`markObjectDeleted` 모두 멱등해 수렴하고, 줍기·버리기·건네주기 경로가 0건이라 복제 경로가 없다. #119(teach)·#121(attack)이 건네주기·전리품 경로를 열면 재평가가 필요하다. 인벤 자체의 재접속 revert(위 항목)는 여전히 열려 있다 — 캐릭터 문서 쪽만 닫혔고 인벤은 닫히지 않았다.
- **`world:room`은 스냅샷이지 델타가 아니다** — E11(#60)이 방 이름·설명·점유자·아이템·크리처를 실어 최소 통지에서 벗어났다. 그러나 발화 시점은 여전히 진입·이동 성공 두 곳뿐이라, 내가 가만히 있는 동안 다른 사람이 들어와도 목록이 갱신되지 않는다. 실시간 입·퇴장 델타는 #116 소관이다.
- **스폰 정책 미완결** — orphan `currentRoom`은 `DEFAULT_START_ROOM = 1` 단일 폴백으로만 방어한다. 레벨·종족·소속별 시작지 정책은 별도다.
- **채널 fan-out에 가시성 필터 없음** — 방 채널 fan-out은 occupants 전 멤버 대상이며 발화자 자신도 제외하지 않는다. PINVIS·어둠·투명 필터는 E5 소관이다. (방 **표시**의 가시성 필터는 E11에서 별도로 들어왔다 — [`movement-rooms.md`](movement-rooms.md) §방 표시 가시성 필터. 두 필터는 다른 관심사다.)
- **broadcast·yell 채널 미분화** — 실 방 어댑터가 붙었으므로 `broadcast`·`yell`도 방 단위로만 전달된다(전서버 방송·1홉 인접 전파 아님). 전역 fan-out과 `minLevel` 게이트 강제는 소셜·채널 에픽(#37)이 함께 소유한다.
- **몬스터 측 live-ization 없음** — 크리처 틱 부트 배선·마나 재생은 별도 토픽이다.

## 관련 문서

- 선행: [`movement-rooms.md`](movement-rooms.md), [`runtime-foundation.md`](runtime-foundation.md), [`session-lifecycle.md`](session-lifecycle.md), [`freechat-permission-seam.md`](freechat-permission-seam.md), [`transport-protocol.md`](transport-protocol.md), [`persistence.md`](persistence.md), [`save-policy.md`](save-policy.md)
- 파생: [`name-matching.md`](name-matching.md)(방 스코프 이름 해소자 — 본 팩토리가 배선)
- 후속: 규칙 명령 배선(#106), 소셜·채널 전역 fan-out(#37), 프론트엔드 월드뷰(#60)
