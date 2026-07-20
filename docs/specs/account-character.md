# 계정·캐릭터 라이프사이클 (E5)

> [`auth-session.md`](auth-session.md)(E3-2)가 세운 `SessionAuthPort` DIP seam·세션 FSM의 **실 구현**. account 1급 모델(accounts 컬렉션 + accountRepository)·character↔account 링크·firebase 세션쿠키 실 어댑터(주입 verifier seam)·8단계 캐릭터 생성 인터뷰·선택/진입/재개 배선·soft-delete(자살) FSM·RBAC `assertRole` seam을 얹고, 포트 계약을 sync→async로 마이그레이션한다. 게임 규칙(E6)·DM 권한 명령(A13)·파생 스탯(#80)은 범위 밖이다.

## 개요

무한 포팅의 계정·캐릭터 도메인 계층이다. [`auth-session.md`](auth-session.md)(E3-2)가 인증 게이트·3층 세션 FSM(`characterSelect → create → command`)·`SessionAuthPort` seam·in-memory 어댑터를, [`persistence.md`](persistence.md)(E2-1)가 repository 계층·문서 스키마를 확립했다. E3-2는 실 firebase-admin 어댑터·`accountId` Mongo 영구화를 E5로 명시 위임했고, 이 계층이 그 실 구현이다. 클라 진입 UI([`session-entry.md`](session-entry.md), E10)가 소비하는 characterList·selectCharacter·createField·resumed 동작에 실 백엔드를 배선한다.

원작 무한은 account 1급 객체 없이 "이름=크리덴셜=파일키" flat namespace였고(게임 분석 A12 §5), 재설계는 account(1)→character(N)로 승급한다(A12 §9). 원작 캐릭터 생성은 create_ply 8단계 대화형 상태머신(A12 §3·A7 §8)이며 이름은 그 앞 login 상태머신에서 받았다(이름=인증 크리덴셜). 재설계는 Firebase가 인증을 소유하므로 **비밀번호(형상)를 제거**하고 이름(더 이상 크리덴셜 아님)을 인터뷰로 이동시킨다. 자살(suicide)의 `system("mv")` 무덤 이동 셸(형상)도 제거하고 status 플래그 soft-delete로 대체한다.

계층 경계는 세 가지다.

1. **firebase 결합 ↔ 어댑터 로직** — 어댑터는 firebase-admin을 직접 import하지 않고 주입된 `SessionCookieVerifier`(`(cookie)=>Promise<{uid}|null>`) seam 뒤에 둔다. concrete verifier는 부팅(index.ts)에서만 firebase-admin을 조립한다(DIP — 실 creds 없이 어댑터 전체 테스트 가능).
2. **account 신원 ↔ character 소유** — firebase uid=accountId로 account를 upsert 승급하고, character는 `accountId` FK로 소유 계정을 역참조한다(1:N). 소유권은 `assertOwnership(accountId, characterId)`로만 판정한다.
3. **순수 결정 ↔ 부수효과(async)** — E3-2의 3층 FSM(순수 decider → 주입 emit StateHandler → 배선)을 보존하되, 포트 I/O가 실 Mongo·firebase가 되면서 StateHandler·배선층을 Promise 기반으로 전환한다. 순수 decider는 포트를 호출하지 않아 sync로 유지한다.

## 구조 / 스키마

### account 스키마 (`packages/shared/src/schema/account.ts`)

`accountSchema` = `z.strictObject`, `z.infer`로만 타입 파생([`persistence.md`](persistence.md) 관례):

| 필드 | 타입 | 비고 |
|------|------|------|
| `_id` | `string().min(1)` | firebase uid 자연키 |
| `email` | `email().optional()` | firebase 부가정보, 게임 필수 아님 |
| `role` | `enum(['player','builder','dm','admin']).default('player')` | RBAC 서열(§동작 assertRole) |
| `status` | `enum(['active','banned']).default('active')` | 계정 상태 |
| `createdAt` | `coerce.date()` | 최초 upsert 시각 |

role enum 선언 순서는 assertRole 서열(player < builder < dm < admin)과 일치시킨다 — enum index는 검증에 무관하나 소비자가 index를 rank로 오용하는 함정을 없앤다(rank는 명시 `ROLE_RANK` 맵이 소유).

### character 스키마 링크 (`packages/shared/src/schema/character.ts`)

E2-1 `characterSchema`에 계정 링크·soft-delete·생성 인터뷰 스칼라를 더한다(기존 필드·순서 보존):

- `accountId: string().min(1)` — 소유 계정 필수 FK(`account._id`).
- `status: enum(['active','deleted']).default('active')` + `deletedAt: coerce.date().optional()` — soft-delete graveyard 필드.
- `gender`·`alignment`·`weapon: int().optional()` — 생성 인터뷰가 고른 원시 스칼라. `.default()`가 아닌 `.optional()`이라(deletedAt 선례) 기존 fixture를 깨지 않고 `createCharacter`가 항상 채운다. proficiency[5] 배열·성향 시스템 모델링은 E6 소관.

### accountRepository (`packages/server/src/repo/accountRepository.ts`)

accounts 컬렉션(`_id`=firebase uid) 저장소. 생성자 주입(`Db`), insert 직후·find 직후 `accountSchema.parse` 경계 검증([`persistence.md`](persistence.md) repository 관례).

- `upsert(input)` — `findOneAndUpdate({_id}, {$setOnInsert: {role:'player', status:'active', createdAt, email?}}, {upsert:true, returnDocument:'after'})`. `$setOnInsert`라 이미 존재하면 role·status를 덮지 않는다(멱등 — 최초 인증 승급 경로).
- `findById`·`updateRole`·`setStatus` — patch는 `accountSchema.shape.role/status.removeDefault()`로 검증한다. `.partial()`을 쓰면 default가 patch에 없는 반대 필드에 재발화해 `$set`이 그 필드를 기본값으로 덮는 silent lost-write가 나므로 default를 벗긴 스키마로 넘긴 값만 검증한다. matchedCount===0이면 `DocumentNotFoundError`.
- `init()` — no-op. `_id`가 firebase uid 자연키라 Mongo 기본 `_id` 인덱스로 유일성이 충족된다(별도 인덱스 불필요, email 인덱스는 소비자로 defer).

### characterRepository 확장 (`packages/server/src/repo/characterRepository.ts`)

E2-1 저장소에 계정 조회·soft-delete를 더한다:

- `findByAccount(accountId)` — `find({ accountId, status: { $ne: 'deleted' } })`. graveyard 캐릭터를 목록에서 배제한다(재로그인 차단 불변식). name unique 인덱스는 보존.
- `init() += createIndex({ accountId: 1 })`(non-unique — 한 계정이 여러 캐릭터 소유). 기존 name unique 인덱스 생성은 보존.
- `softDelete(id)` — `updateById(id, { status: 'deleted', deletedAt })`. 물리 `deleteById` 미사용. `findById`는 여전히 문서를 돌려줘 감사·복원 여지를 남긴다(하드 삭제와 구별). matchedCount===0이면 `DocumentNotFoundError`.
- patch 검증 스키마는 `status.removeDefault()`를 벗겨 파생한다(accountRepository와 동일 이유) — status를 뺀 부분 패치가 무덤 문서를 `active`로 부활시키는 silent write를 막는다.

### 실 어댑터 + verifier seam (`packages/server/src/auth/`)

- `sessionCookieVerifier.ts` — `SessionCookieVerifier = (cookie: string) => Promise<{ uid: string } | null>` 주입 seam 타입. 어댑터는 이 함수만 주입받고 firebase-admin을 import하지 않는다.
- `firebaseSessionAuthAdapter.ts` — `SessionAuthPort` 실 구현. 생성자 주입(verifier, accountRepository, characterRepository, 전역 싱글턴 미조회). 매핑 규약: `CharacterSummary.characterId = Character._id`, 요약 `level`은 파생 미존재라 dev 기본값 1(#80 정합 전).
- `firebaseVerifier.ts` — `createFirebaseVerifier(projectId)` 팩토리가 firebase-admin `getAuth().verifySessionCookie`를 `SessionCookieVerifier` 형태로 감싼다. `getApps().length` 가드로 `initializeApp({ projectId })` 1회 초기화. **firebase-admin import는 이 파일과 index.ts로만 국한**(어댑터는 firebase-agnostic). 실 creds가 필요해 단위 테스트가 비실용적이라 커버리지에서 제외(index.ts와 동일 배선 코드 취급, seam은 통합 테스트가 FAKE verifier로 관통 검증).
- `assertRole.ts` — `assertRole(account, requiredRole)` 순수 함수. `ROLE_RANK` 맵(player=0<builder<dm<admin)으로 `rank(account.role) >= rank(requiredRole)`면 void, 미달이면 `RoleError`. 위계 비교(정확 일치 아님 — dm은 builder 게이트 통과). 비-enum role 누출 시 `undefined >= n`이 false라 fail-closed.
- `raceModifiers.ts` — 종족 스탯 보정 순수 함수(a7 §7 테이블). **server E5 코드에 둔다**(shared/stats 아님 — #80 병렬 토픽 파일 충돌 회피). stats 순서 [str,dex,con,int,piety], 보정 후 새 튜플 반환(불변성).

### 세션 FSM 확장 (`packages/server/src/ws/fsm/sessionFsm.ts`)

E3-2의 `ConnectionState` 핸들러 맵에 `delete` 상태를 더하고, create 인터뷰를 8단계로 확장한다. **신규 FSM 파일·wire 메시지 타입 없음** — 기존 `session:prompt{kind:createField|selectCharacter}` + `session:reply{value}` 계약을 재사용하고 promptId만 파생한다([`session-entry.md`](session-entry.md)의 `protocol/session.ts` 불변).

- `CREATE_PROMPT_IDS` 8단계: `name → gender → class → stats → weapon → alignment → race → confirm`. step만 저장하고 promptId는 step에서 파생(derivable-state 중복 저장 금지).
- `DELETE_SENTINEL='delete'`(선택 화면 삭제 진입 신호), `DELETE_CONFIRM_VALUE='찐짜로'`(삭제 확정값 — 원작 command5.c suicide "찐짜로? (찐짜로/뻥으로)" strcmp 충실 이식), `DELETE_CONFIRM_PROMPT_ID`(확인 입력 prompt).
- `createProgress`(create 대화)·`deleteProgress`(삭제 대상 characterId)는 소켓 수명 `FsmContext` 서브상태에 둔다(각 상태 밖에선 null 불변식, onExit이 정리).

### env·부팅 배선 (`packages/server/src/config/env.ts`, `index.ts`)

- `FIREBASE_PROJECT_ID: z.string().optional()` — 실 세션쿠키 검증 어댑터(`DEV_LOGIN_ENABLED=false` 경로) 조립에만 쓰인다. dev 부팅은 요구하지 않아 optional이나, 실 어댑터 조립 시점에 부재면 fail-fast로 방어.
- `index.ts` — `DEV_LOGIN_ENABLED` off면 accountRepository·characterRepository + concrete verifier로 `FirebaseSessionAuthAdapter`를 조립해 주입하고, on이면 dev 시드 인메모리 어댑터를 배선한다(기존 dev 경로 보존). 부팅 init 배치에 `accountRepository.init()`을 추가(기존 objects·characters·bank init 보존).

## 동작

### 신원 확립·account 승급

브라우저 upgrade의 `__session` 쿠키가 인증 게이트([`auth-session.md`](auth-session.md))를 지나 `validateSessionCookie(cookie)`에 도달한다. 어댑터는 주입 verifier로 uid를 얻고(verifier가 throw하거나 null이면 인증 실패=null로 collapse — throw를 삼켜 누출 방지), 성공 시 accountId=uid로 account를 upsert 승급한다(없으면 role='player' 생성). upsert는 in-process `upsertedAccounts` Set(dedup 캐시)로 미본 accountId만 호출한다 — 멱등 write를 hot path(upgrade)에서 매번 반복하지 않는다(add는 upsert resolve **후**라 실패 시 재시도가 오염되지 않는다). verify 결과 자체는 캐싱하지 않는다(verify는 연결당 1회이지 프레임당 아님).

### 캐릭터 생성 인터뷰 (8단계)

`characterSelect`에서 `CREATE_SENTINEL`로 답하면 `create`로 전이해 8단계 createField 대화를 돈다: 이름→성별(1남/2여)→직업→능력치→주력무기(1~5 도/검/봉/창/궁)→성향(1선/2악)→종족→확정. 각 단계는 `session:reply`의 `promptId`가 현재 step promptId와 일치해야 하고(stale reply 거부) 값을 서버에서 Zod 검증한다.

- **54pt 포인트바이** — 단일 구조화 문자열(공백 구분 5정수, 순서 str·dex·con·int·piety = characterSchema.stats 튜플 순서)을 한 프롬프트로 받는다(5개 서브 프롬프트 아님). 검증: 5값·각 3~18·합 ≤54. 위반 시 현재 단계 유지(재응답). decimal-only 토큰만 허용(`1e1`·`0x10`·`+5` 스머글링 차단).
- **종족 보정·확정** — confirm에서 point-buy 검증 **후** 종족 보정을 더한다(`applyRaceModifiers`). **no-clamp** — 보정 후 3~18 재검사 없이 저장한다(as-shipped 형상 후보, #80의 read-time bonus가 clamp). 세이브: 종족 보정 stats·gold=500·초기 방·accountId·gender·weapon·alignment. 파생 HP/MP·up_level은 #80로 defer.

### 선택·진입·재개

`characterSelect`에서 `session:selectCharacter{characterId}`를 받으면 `assertOwnership`으로 소유·상태를 검증한다 — 미존재·타 계정 소유·**status='deleted'** 중 하나면 `OwnershipError`(존재/소유/삭제를 하나로 collapse — 열거 oracle 차단). `findById`가 status를 필터하지 않으므로 이 삭제 검사가 삭제 캐릭터로의 월드 재진입(재로그인 차단 우회)을 막는 유일 지점이다. 통과 시 `session:entered` + `command` 전이. link-dead 재접속은 세션 레지스트리([`session-lifecycle.md`](session-lifecycle.md))를 경유해 `session:resumed`로 재개한다.

### soft-delete(자살) 서브플로우

`characterSelect` 선택 prompt에 `DELETE_SENTINEL` 옵션이 실린다. 답하면 `delete`로 전이: (1) 삭제 대상 select prompt → 대상 선택 시 조기 `assertOwnership`(clean early rejection), (2) 「찐짜로」 확인 prompt. 확인 reply.value가 **정확히 「찐짜로」**(trim·정규화 없는 raw 일치 — 「찐짜로 」는 취소)일 때만 `deleteCharacter`를 호출한다. 불일치(「뻥으로」 포함 그 외 전부)는 reject-retry가 아니라 **취소**로 `characterSelect` 복귀(원작 의미). 성공 시 `delete→characterSelect` 전이가 `listCharacters`를 재실행해 삭제 캐릭터를 자연 배제한다.

`deleteCharacter(accountId, characterId)` 포트 메서드는 **내부에서 `assertOwnership`을 재확인**한 뒤 `softDelete`한다(TOCTOU 방어 — 대상 선택과 확인 사이 sibling 세션이 소유를 바꾸는 레이스 차단). FSM 조기 assert와 어댑터 내부 assert는 이중 방어(중복 아님). 원작 비밀번호 확인(형상)·`system("mv")` 셸 이동은 재현하지 않는다(셸 인젝션 표면 제거).

### async 마이그레이션·프레임 직렬화

포트 4메서드 + `deleteCharacter`를 Promise 반환으로 전환하고, 그 호출 캐스케이드(StateHandler `onEnter`/`handleInput`/`onExit` → `applyTransition`·`enterState`·`handleSessionFrame`, plugin의 `accept`/`pass` 분기)를 async로 전파한다. 순수 decider는 포트를 안 호출하므로 sync 유지, command/dispatch 분기는 permissionPort가 sync라 sync 유지(경계 보존).

핸들러가 async가 되면 `ws`가 리스너를 await하지 않아 frame 1의 await 중 frame 2가 처리돼 공유 `ctx.state`·`createProgress`·deadline이 동시 변이될 수 있다(인간 타이핑 속도라 순차 테스트로 안 잡히는 latent 동시성 버그). **연결당 async 큐**(직전 프레임 Promise에 체이닝하는 tail-promise)로 프레임 처리를 직렬화한다 — 각 프레임은 이전 프레임 완결 뒤에만 시작하고, sync 경로도 순서 보존을 위해 같은 큐를 지난다. 각 await 후 상태 전이 전 `isClosed()` 가드로 죽은 소켓 register/state-write를 차단한다(frame-vs-close 레이스). 큐 내 예외는 기존 방어 try/catch로 격리하고 후속 프레임을 막지 않는다.

emit 순서(예: characterSelect 진입 시 `session:characterList`가 select prompt보다 먼저)는 await 삽입 후에도 보존되며, 중도 이탈 시 `createProgress`/`deleteProgress`는 `cleanupConnection`이 폐기하고 재접속은 `characterSelect`부터 재시작한다(부분 상태 재개 없음).

### RBAC seam

`assertRole`은 role 위계 판정 함수만 제공한다 — 실제 권한 게이트 명령은 소비자(A13 DM·모더레이션)로 defer한다. `plugin.ts`의 `permissivePermissionAdapter`는 permissive 기본값을 유지한다(실 RBAC 어댑터 미배선).

## 제약사항

- **세션 revocation·`banned` 강제는 하드닝 defer([#89](https://github.com/smalljiny/muhan/issues/89))** — `firebaseVerifier`는 `checkRevoked` 없이 서명·만료만 검증하므로 revoke된 세션이 자연 만료(최대 ~2주)까지 인증을 통과한다. `account.status='banned'`도 연결 게이트가 강제하지 않는다(setStatus 저장 경로는 존재). 둘 다 현재 트리거 불가한 잠복 갭이며, `checkRevoked=true`가 요구하는 서비스 계정 credential 프로비저닝과 함께 랜딩한다. banned 강제는 `validateSessionCookie` 본체에 두어야 하며 dedup 캐시 경로에 얹으면 재검증에서 건너뛴다.
- **게임 비밀번호 없음** — 인증은 Firebase 세션쿠키가 소유(ADR D6). account/character 스키마·repository·로그·프로토콜 어디에도 게임 비밀번호를 저장·노출하지 않는다.
- **파생 스탯·HP/MP 계산은 #80 stats-core** — 생성은 base 스탯(종족 보정 포함)만 채우고, up_level·HP/MP 파생과 read-time clamp는 병렬 토픽 소관이다. 요약 `level`은 dev 기본값 1.
- **DM/빌더 권한 명령은 A13** — E5는 `role` 필드 + `assertRole` seam만 제공하고 실제 권한 게이트 명령(*delete 등)·모더레이션 도구는 별도 에픽이다.
- **class/race 범위 코드 테이블 검증은 E6** — 생성 인터뷰는 gender·weapon·alignment·point-buy를 서버 검증하나 class는 `port/templates.js` 코드 테이블 대조 전까지 자유값이다.
- **Mongo 런타임 마이그레이션 없음** — 영속 프로덕션 character 문서가 없고(legacy 타이/테스토스는 디스크 포맷 픽스처이지 Mongo 문서 아님) `accountId` required 전환은 스키마 개정만으로 충분하다.
- **저레벨 자동 퍼지 cron 없음** — 원작 세션 계층에 자동 퍼지 코드가 없다(DM 수동), YAGNI.
