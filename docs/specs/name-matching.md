# 이름 매칭 (주문명·대상 해소 + 별칭 `key[3][20]`)

> 사용자가 친 한글 이름을 주문·대상(크리처·플레이어·아이템)으로 해소하는 오라클 규칙 2종과, 그 규칙이 실데이터에서 동작하는 데 필요한 별칭 파이프라인.

## 개요

라이브 게임 명령은 입력 문자열을 게임 객체로 해소해야 한다. 오라클은 이를 **서로 다른 두 규칙**으로 처리하며, 이 포트는 두 규칙을 각각 순수 함수로 이식한다.

| | 주문명 (`magic1.c:49-70` cast · `163-175` teach) | 대상 (`find_crt`·`find_obj`, `EQUAL` 매크로) |
|---|---|---|
| 규칙 | 완전일치 우선(즉시 확정) → 접두 누적 | **순수 접두만** — 완전일치 특례 없음 |
| 검사 필드 | `koreanName` 1개 | `name` + `keys[0..2]` **4개** |
| 모호할 때 | **거부** | 거부 없음 — **서수로 N번째 선택** |
| 미발견 | `notFound` (호출자가 메시지 소유) | `undefined` |

두 규칙을 한 함수로 합치면 어느 한쪽이 오라클과 어긋나므로 **통합하지 않는다**.

별칭 `key[3][20]`이 함께 필요한 이유: 매칭이 접두 전용이라 `strncmp(name, "거미", 4)`는 `작은 거미`에 절대 일치하지 않는다. 별칭 없이 매처만 이식하면 규칙은 맞지만 플레이어가 몬스터를 지목하지 못한다.

## 구조 / 스키마

### 컴포넌트 배치

| 파일 | 레이어 | 역할 |
|---|---|---|
| `shared/src/naming/matchSpellName.ts` | shared | 주문명 규칙 — 완전일치 우선 + 유일 접두 + 모호 거부 |
| `shared/src/naming/matchTarget.ts` | shared | 대상 규칙 — 4필드 순수 접두 + 서수 선택 |
| `shared/src/magic/catalog.ts` | shared | `spellByName(query)` — `SPELL_CATALOG`를 바인딩한 얇은 래퍼 |
| `server/src/world/roomTargetResolvers.ts` | world | 방 스코프 크리처·플레이어 해소자 + `find_crt` 가시성 게이트 |
| `server/src/ws/liveWorldWiring.ts` | ws | 해소자 2종을 seam으로 노출 (1회 생성 공유) |
| `port/templates.js`·`parseRoom.js` | port | `key[3][20]` 추출 (OBJ 오프셋 160 · CRT 오프셋 255, 3×20B) |

매처는 shared 순수 함수이고 가시성 게이트·관찰자 flags는 server 해소자에 격리된다. 매처는 `{ name, keys? }` 형상만 보므로 크리처·아이템·플레이어 타입에 무관하다.

### 매처 계약

```ts
matchSpellName(entries, query)
  → { kind:'found', spellNo } | { kind:'ambiguous' } | { kind:'notFound' }

matchTarget(candidates, query, ordinal = 1) → T | undefined

// 방 스코프 해소자
resolveRoomCreature(room, query, observerFlags, ordinal = 1) → CreatureInstance | undefined
createRoomPlayerResolver(resolveCharacterName)(room, query, ordinal = 1) → characterId | undefined
```

**매처는 관찰자를 받지 않는다.** 오라클이 가시성 게이트를 `match++` **앞**에 두므로 게이트에 걸린 후보는 서수 슬롯을 소모하면 안 되고, 따라서 해소자가 후보를 **먼저 거른 뒤** 매처에 넘긴다. 매처 시그니처에 관찰자를 넣으면 순수 함수가 flag 표상에 결합된다.

### 별칭 `keys`

`CreatureInstance.keys?: string[]`·`ItemInstance.keys?: string[]` — 원본 `char key[3][20]`을 위생 처리한 배열.

**선택 필드**로 둔다(`experience`/`alignment` 선례) — required면 흩어진 인라인 리터럴 테스트 픽스처가 전부 컴파일 실패한다. 다만 프로덕션 리더·물질화는 **항상 배열을 채운다**(없으면 `[]`, `undefined` 금지) — 매처가 두 형상을 분기하지 않도록.

실데이터 보유율: creature 681중 607(89%, name과 다른 진짜 별칭 359) · object 744중 666(90%). 실례 — `작은 거미`→`거미` · `야바단의 유령`→`유령`·`야바단`·`nildredge` · `검의 달인`→`달인`.

## 동작

### 주문명 매칭

```c
if(!strcmp(str, spllist[c].splstr)) { match = 1; splno = c; break; }  // 완전일치: 리셋 + 즉시 종료
else if(!strncmp(str, spllist[c].splstr, strlen(str))) { match++; splno = c; }
```

완전일치는 누적을 **1로 리셋하고 즉시 break**하므로 선언 순서와 무관하게 이긴다. 이 리셋이 없으면 진접두 형제(`X`와 `X…`)가 있을 때 `X` 질의가 모호로 잘못 거부된다. 카탈로그 실사례가 `은둔법`(SINVIS)/`은둔감지술`(SDINVI)이다 — `은둔`은 두 건 접두 일치라 모호 거부, `은둔법`은 완전일치라 확정된다.

`else if` 구조를 그대로 유지해 완전일치가 접두 분기로 흘러들지 않게 한다. 결과는 순회 순서에 **완전히 독립**이다(모호는 거부, 유일 접두는 순서 무관).

소비자는 cast(`str[1]`)와 teach(`str[2]`) 둘이며, 오라클이 같은 do-while을 문자 그대로 복제한 코드라 함수 하나가 양쪽을 덮는다.

### 대상 매칭 + 가시성 게이트

`EQUAL`은 `name`·`keys[0..2]` 중 하나라도 질의를 접두로 가지면 참인 단락 OR다. 후보를 선언 순서대로 순회하며 `match++`하고 `match === ordinal`에서 확정한다.

`find_crt`의 게이트 2종은 매칭 루프 **안**, `match++` **앞**에 있다:

- **DM 투명** — `class >= CARETAKER(10)`와 비트 10의 **결합(AND)**이다. `creatures.json` 실측으로 `class >= 10`은 52마리, 비트 10은 50마리지만 **교집합은 0건**이라 `class` 단독으로 축약하면 52마리가 잘못 스킵된다.
  - 비트 10의 정체 주의: C `F_ISSET`은 구조체 무관 매크로라 오라클도 몬스터 순회에서 `PDMINV`를 그대로 호출하지만, `PDMINV`는 P-flag 공간의 "DM Invisibility"이고 크리처 M-flag 공간의 같은 비트 10은 `MFLEER`다. 위 "50마리"는 DM 투명이 아니라 `MFLEER` 보유 몬스터다. 이 비트 겹침은 오라클의 성질이므로 그대로 이식한다.
- **투명** — 관찰자가 `PDINVI`(투명 감지)를 들면 무조건 통과, 아니면 크리처의 `MINVIS`가 없어야 한다.

게이트가 `match++` 앞이라는 점이 곧 구현 계약이다 — 매칭 *후에* 거르면 투명 후보가 앞에 있을 때 `고블린 2`가 엉뚱한 대상을 고른다.

### 배선 (1회 생성 공유)

`resolveRoomCreature`는 의존이 없어 모듈 함수를 그대로 노출한다(참조가 곧 단일 인스턴스). `resolveRoomPlayer`는 기존 `resolveCharacterName` **인스턴스를 재사용해** 1회 생성한다 — 지목 경로가 표시 경로와 다른 클로저를 배후에 두면 "보이는 이름"과 "지목되는 이름"이 갈린다. 정본은 [`live-world-foundation.md`](live-world-foundation.md) §조립.

### 별칭 추출 위생

| 항목 | 건수 | 처리 |
|---|---|---|
| 공백 전용 슬롯 | 74 | 배열에서 제외 — 남기면 `strncmp(key, " ", 1)` 위양성 경로가 열린다 |
| 정확히 20바이트 (NUL 미종단) | 119 | 필드 길이로 절단 (`cstr` 관례) |
| EUC-KR 깨짐 (U+FFFD) | 1 (`m00#87` key[1]) | **보존** — 원본 바이트 충실, 매칭에 무해 |

방 embedded 개체도 리더가 직접 추출한다 — `templateId=null`이라 템플릿 재조회가 불가능해, 여기를 빼면 같은 몬스터가 방마다 별칭 유무가 갈린다.

## 제약사항

### 알려진 divergence (의도)

- **서수 기준 순서** — 오라클 `first_ply`·`first_mon`은 도착 순서 리스트가 아니라 **`strcmp` 이름 정렬 삽입 리스트**다(`room.c:17-19`). 이 포트는 도착 순서를 쓴다: `strcmp`는 EUC-KR 바이트 비교인데 KS X 1001 완성형 배열과 Unicode Hangul Syllables 배열이 달라 JS 문자열 비교로 재현되지 않으며, collation 테이블 없이는 이식이 불가능하다. 영향 범위는 **질의 접두가 같고 이름이 다른 후보가 공존할 때의 서수뿐**이다(한 방의 `고블린`·`고블린 대장`에 질의 `고`). 이식 여부는 **#137**이 소유한다.
- **플레이어 별칭 미검사** — 오라클 `EQUAL`은 `first_ply`에도 `key[]`를 적용하나 플레이어 세이브의 key는 실무상 비어 있어 `characterSchema`에 별칭 필드를 두지 않는다.
- **별칭 보관값 trim** — 리더가 빈 슬롯 판정뿐 아니라 보관값도 trim한다. 오라클은 앞뒤 공백을 보존하므로 `strncmp(" 거미", "거미", 4)`가 의도적으로 실패하는 반면 포트는 `거미`로 지목된다. 실측 영향은 앞공백 27·뒤공백 28슬롯이고 **전량 표지판 오브젝트**(key 필드에 안내문을 넣은 사례), 크리처는 0건이다. 값이 이미 `data/world/objects.json`에 동결돼 있다.
- **20B NUL 미종단 키 절단** — 오라클 `strncmp`는 연속 메모리라 20B 경계를 넘어 다음 슬롯까지 이어 읽는다. 포트는 필드 길이에서 자른다(`name`·`description`의 기존 `cstr` 관례와 일관). 발현 조건은 병리적이며 테스트가 60B over-read 부재를 lock한다.

### 미구현 경계 (소유권 분리)

매처·해소자에 의도적으로 넣지 않은 것들이다. 미리 넣으면 소비 토픽의 게이트와 중복·충돌한다.

- **플레이어 후보 가시성 게이트** — `PHIDDN`·`PINVIS`·`PDMINV` 점유자 필터는 표시 경로와 함께 **#129**가 소유한다(두 경로가 같은 관찰자 인자 설계를 공유해야 한다). 그때까지 플레이어 해소자는 이름이 해소되는 점유자를 무조건 후보로 싣는다 — 크리처 해소자와 **비대칭**이다.
  - 세 비트의 도달 가능성이 다르다: `PHIDDN`·`PDMINV`는 영속 경로 부재로 영구 0이지만, **`PINVIS`는 `SINVIS` 버프 → `projectBuffFlags` → `composeCharacterFlags` 경로가 이미 완성돼 있고 시전 커맨드 부재만이 차단막**이다. 그 커맨드를 다는 #122(cast)가 착지하면 이 게이트는 즉시 필요해진다.
- **자기 자신 제외 · `strlen(str) < 2` 거부** — `command5.c:79`의 2단 해소 조건은 **#121**(attack) 몫이다. 질의가 빈 문자열이면 `strncmp(a,b,0)===0`이라 첫 후보에 매치한다(오라클 그대로).
- **질의 전처리** — `command5.c:76`의 첫 바이트 대문자화는 영문 플레이어명 관례이며 한글에 무효라 이식하지 않는다. 서수 토큰 분해·SOV 어순 처리도 입력 계층 소관이다.
- **생존·은신 게이트** — `hpcur > 0`과 `MHIDDN`은 `find_crt`에 없어 두지 않는다. 결과적으로 **숨은 크리처는 방 목록에 안 보여도 이름으로는 지목된다** — 표시 경로(`roomView.isCreatureHidden`)와 의도된 비대칭이다.

### 미배선 소비자

- **아이템 해소자** — `characterSchema`에 `inventory`/`ready`가 없어 study 대상 자체가 존재하지 않는다(**#120**). 매처는 타입 무관이라 그대로 재사용된다.
- **`ObjectTemplate.keys`** — 템플릿 인덱스는 `keys`를 전파하지 않는다. 이 인덱스를 읽는 이름 매칭 소비자가 0건이기 때문이며, #120이 template-backed 아이템 별칭을 필요로 할 때 함께 전파한다.
- **명령 variant** — teach(#119)·study(#120)·attack(#121)·cast(#122)가 각자 배선한다. 본 문서 범위는 공유 seam까지다.

## 관련 문서

- 선행: [`live-world-foundation.md`](live-world-foundation.md), [`creature-spawn.md`](creature-spawn.md), [`magic.md`](magic.md), [`world-view.md`](world-view.md)
- 후속: teach(#119) · study(#120) · attack(#121) · cast(#122) · 표시 가시성(#129) · 서수 순서 divergence(#137)
