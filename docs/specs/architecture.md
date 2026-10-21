# 무한 서버 아키텍처 스펙

**상태**: Accepted (아키텍처 결정 기록, 이슈 #14)
**작성일**: 2026-07-01
**작성자**: @smalljiny

> **문서 범위**: 이 문서는 무한 MUD 포팅의 서버·클라이언트 기술 스택과 아키텍처를 확정하는 **기준 결정 기록(ADR)**이다. 게임 분석 A1~A13 노트와 이슈 #14의 결정 대화를 바탕으로 8개 축을 확정한다: 런타임, 영속화, 전송, 프로토콜, i18n, 인증, 테스트, 프로젝트 구성. 서브시스템별 상세 구현 스펙은 이 문서에서 파생되는 후속 토픽이 다룬다(§1.3, §6). 게임 규칙 공식(전투·마법·경제 수치)은 A5~A9 노트가 기준이며 여기서 다시 적지 않는다.

## 1. 개요

### 1.1 배경

무한은 1991~93년 Mordor MUD의 한국어 파생본이다(32비트 C, telnet, fork 없는 단일 프로세스 `select` 루프, 파일 기반 세이브). 전체 디스크 포맷의 역설계와 JSON 변환은 끝났다(`data/world/` = 방 2341 + object 709 + creature 674 ≈ 2.9MB). 게임 분석 A1~A13은 다음 전 영역의 동작 명세를 확보했다: 런타임, 명령, 전투, 마법, 진행, 경제, 몬스터 AI, 소셜, 특수 오브젝트, 세션, DM. 남은 일은 서버 코드를 옮기기 전에 스택과 아키텍처를 확정하는 것이다(이슈 #14).

포팅 원칙: 게임 콘텐츠와 규칙(무엇을)은 충실히 이식하고, 소프트웨어 구현 방식(어떻게)은 신규 스택으로 재설계한다. 1:1 트랜스파일이 아니다. `legacy/muhan/src`는 이식 대상이 아니라 behavioral oracle이다.

### 1.2 목적

- 8개 결정 축을 확정해, 서버 스캐폴딩과 구현 토픽을 시작할 수 있는 아키텍처 기준선을 세운다.
- 각 결정의 근거를 게임 분석 노트, 외부 선례 리서치와 함께 기록해 후속 구현이 다시 논쟁하지 않고 참조하게 한다.
- 콘텐츠(충실 재현)와 구현 방식(적극 개선)의 경계, 그리고 두 프로젝트 정책(as-shipped 재현 / 구현 방식 개선)을 문서로 못박는다.

### 1.3 결합 근거 (Coupling Rationale)

이 스펙의 목표들(§2)은 따로 배포하는 단위가 아니라 **하나의 일관된 대상 아키텍처를 함께 정의**한다. 목표들은 서로 의존한다. 예를 들어 전송(D0)이 프로토콜(D4), 브로드캐스트(D3), 틱(D1)을 규정하고, 영속화(D2)가 인증(D6)과 상태 모델을 규정한다. 따라서 이 문서는 **분할하지 않는 결정 기록(ADR)** 으로 유지한다. 실제 *구현*은 이 기준선에서 파생되는 서브시스템 단위 **에픽**으로 나뉜다(§6.7). 예를 들면 monorepo 스캐폴딩, 전송·세션 계층, 월드 상태 엔진, 게임 규칙 엔진, 인증, 소셜·채널, 테스트 인프라다. 이 ADR의 플랜을 서브시스템 전체의 구현 계획으로 넓히지 않는다.

> **용어 위계**: **에픽** → **토픽** → **Story** 순서로 작아진다.
> - **에픽**: 서브시스템 단위의 작업 묶음.
> - **토픽**: 하네스 `/flow-spec`→`/flow-pr` 단위. `dev-context.json` 1항목, spec 1개, PR 1개에 해당한다.
> - **Story**: 토픽 플랜 안의 단일 커밋 단위.
>
> 에픽 하나는 1개 이상의 토픽을 낳는다. 작은 에픽은 1:1이고, 게임 규칙 엔진 같은 큰 에픽은 여러 토픽으로 나뉜다.

## 2. 목표

1. **런타임 모델 확정**: 단일 프로세스 이벤트 루프 + 중앙 heartbeat + 엔티티별 next-action 스케줄.
2. **영속화 경계 확정**: 인메모리 권위 상태 그래프 + MongoDB DB-네이티브 세이브 정책.
3. **전송 계층 확정**: 손수 `ws` + in-process EventEmitter 채널(Colyseus 기각).
4. **프로토콜 확정**: 구조화 JSON command/event 계약 + Zod 단일 출처 + 공유 타입.
5. **입력·i18n 확정**: 구조화 UI와 자유 텍스트 병행, UTF-8 전용, 조사 규칙은 클라이언트에서 렌더.
6. **인증·권한 확정**: account/character 분리, ~~argon2id~~ **Firebase Auth(세션 쿠키)**(§3.7 보정), RBAC, WS 핸드셰이크.
7. **테스트 전략 확정**: C oracle과 대조한 frozen 골든 fixture + property 테스트.
8. **프로젝트 구성 확정**: pnpm monorepo + Vite/tsup.
9. **정책 명문화**: §4의 두 전역 정책(as-shipped 재현 / 구현 방식 개선)과 전역 불변식.

## 3. 아키텍처

### 3.1 전역 정책

- **P1. as-shipped 재현 기본 + 항목별 결정.** 게임 규칙(콘텐츠)은 원본 동작을 충실히 재현한다. 노트가 찾아낸 ~40개 버그와 데드코드도 기본값은 재현이다(behavioral parity이며 binary parity는 아니다). 되살리거나 고치는 것은 항목마다 명시적으로 결정한다. 테스트는 '선택된 동작'을 assert한다.
- **P2. 구현 방식은 재현하지 않고 개선한다.** 과거 기술 제약(파일 저장, telnet, select, 32비트, 평문)에서 나온 구현 방식은 신규 스택으로 적극 개선한다. 단 이 원칙은 일반적인 현대화 인프라를 정당화할 뿐, 특정 프레임워크 채택까지 자동으로 정당화하지는 않는다(적합성은 따로 판단).
- P1과 P2는 서로 보완한다. 콘텐츠는 충실히 재현하고, 구현 방식은 개선한다. 경계가 모호하면(예: 조사의 ㄹ 예외) 과거 제약에서 나온 것인지로 판정한다.

### 3.2 전역 불변식 (노트 확정)

1. 선언적 데이터 테이블 > 하드코딩 공식. bonus·thaco·exp·class_stats·spell·price·spawn을 JSON/config로 둔다(A5~A9). 밸런스 튜닝과 테스트를 코드에서 분리한다.
2. base 스탯과 모디파이어 레이어를 분리한다. 파생 스탯(AC, thaco, 소지량, 재생)은 유효 스탯의 순수 함수다(A7 §12 최우선, A8 §2).
3. 효과와 전달을 분리한다. 순수 효과 함수 + delivery 어댑터(cast/scroll/potion/wand), caster 공통 인터페이스(A6).
4. 타이머 = 스케줄러·이벤트. `lasttime`+`LT` 매크로를 "다음 가용 시각" 필드와 만료 이벤트로 바꾼다(A1·A5·A6·A7·A9).
5. 단일 object 스키마 + 참조 컨테이너. 방, 몹, 플레이어, 은행이 objectId 배열로 참조하고, 착용은 슬롯 맵으로 표현한다(A8 §11.1).
6. 보안 결함 수정 필수(재현 금지). 셸 인젝션(board/mail/suicide `system()`), 평문 비밀번호, 금화 무가드(A10·A12·A8).

### 3.3 런타임 모델 (D1)

단일 프로세스 + Node(libuv) 이벤트 루프를 쓴다. 중앙 heartbeat(1Hz `setInterval`)가 저빈도 갱신(게임시간, 랜덤 스폰, 침공, 출구 개폐)을 modulo 간격으로 실행 여부를 정한다. 이는 원본 `update_game` + `update_*` 구조를 재현한 것이며, LuminariMUD·DikuMUD 계열의 표준 패턴이다. 전투와 몬스터 AI는 매초 전체를 순회하지 않고 **활성 크리처의 next-action 우선순위 큐**로 스케줄한다(A9). "빈 방=시간 정지" 의미는 유지한다(방 점유 이벤트로 활성 집합을 증분 갱신). 게임 시계 단위는 초다. 범용 스크립팅 엔진은 필요 없고, 유한한 special handler 레지스트리로 충분하다(A11).

### 3.4 영속화 (D2)

라이브 권위 상태는 프로세스 메모리의 객체 그래프다. 방 2341개를 부팅 시 전부 로드하고, 원본 `load_rom`의 LRU+write-back은 버린다. MongoDB는 영속화 계층이며 hot-path에서 왕복하지 않는다.

**세이브 정책은 DB-네이티브로 신규 설계**한다(원본의 이벤트 기반 세이브 타이밍은 파일 시대의 구현 방식이므로 P2 대상). 정책은 세 가지다.
1. 플레이어: dirty-flag 주기 flush(60~300초) + 중요 이벤트(레벨업, 거래, 로그아웃) 시 즉시 write.
2. 월드 변경(문, 리스폰 타임스탬프): 비동기 배치.
3. 경제·은행: 트랜잭션(원자성).

"객체 그래프가 아니라 값을 저장"한다(안정 ID, 평문, version 필드). account와 character는 별도 문서이고, 통화(gold)는 character·bankAccount에 스칼라 필드로 넣는다. 금화 무결성 가드(상한, 음수, 트랜잭션)는 필수다.

**불변식 5 범위 명확화(E2-1 구현 반영)**: 불변식 5의 "참조 컨테이너"는 **라이브 인메모리 참조 모델**을 뜻한다. 부팅 그래프에서 방, 몹, 플레이어가 object 인스턴스를 참조한다(§3.3 런타임 모델과 `docs/specs/persistence.md`의 부팅 월드 그래프가 이를 따른다). **영속 계층은 이를 단일 소유권 `object.owner` 필드로 구체화한다.** object 문서마다 `owner:{type:'character'|'bank', id}`를 둬 소유자를 정식으로 하나로 정한다. character와 bank는 인벤토리나 보관함을 권위 배열로 저장하지 않고, `objects`를 owner로 쿼리해 파생한다. 이렇게 하면 데이터 불일치(드리프트)가 사라지고, 구조적으로 아이템 복제(dupe)를 막으며, 원작 세이브 타이밍의 복제 결함도 막는다. 즉 `object.owner`는 불변식 5를 대체(supersede)하는 것이 아니라 영속 계층의 표현 선택이며, 라이브 참조 모델과 모순되지 않는다. E2-1 세부는 `docs/specs/persistence.md`를 참조한다.

### 3.5 전송·브로드캐스트 (D0·D3)

**손수 `ws` + in-process EventEmitter 채널.** Colyseus는 기각했다. 성능 때문이 아니다. 기각 이유는 다음과 같다.
- 장르에 맞지 않는다.
- A10의 소셜 밀도 때문에 채널 레이어를 다시 구현해야 한다.
- 게임 상태와 강하게 결합된다.
- 목표 규모가 작아 단일 프로세스로 충분하다. 단일 Node 프로세스가 WS 3만~10만 연결을 처리할 수 있어, 수십~수백 CCU 목표를 넉넉히 넘는다.

채널은 EventEmitter 토픽 + 구독 필터다. 방이 채널이고(이동=leave+join), 그 밖에 전역(잡담, 환호), 패거리, 결혼, wiz, eaves 토픽이 있다. 수신자 플래그(PNOBRD·PEAVES·class)는 구독 술어로, 가시성(어둠, 투명) 필터는 송신 시점에 적용한다. 비용과 게이트 곡선(잡담 HP, 레벨20, 일일 한도, 외침 1홉)은 수치까지 이식한다. Redis pub/sub은 수평 확장할 때로 미룬다(도입 시 wildcard 금지, 방별 on-demand 구독).

> **HTTP 호스트 보정 (E1, 2026-07-02).** 원래의 "손수 `ws`"는 **HTTP 호스트 프레임워크를 배제하지 않는다**. E1 스캐폴딩은 **Fastify를 HTTP 호스트 계층**으로 채택한다. Fastify는 정적 클라이언트 서빙, `/health`, 후속 인증 REST 엔드포인트(D6)를 담당한다. **게임 소켓은 `@fastify/websocket`**(내부적으로 `ws`를 래핑)으로 붙인다. 그래서 D0의 "손수 `ws`" 원칙(프레임워크가 게임 상태와 채널을 소유하지 않음)이 그대로 유지된다. **Colyseus 기각 근거는 그대로다.** Colyseus는 게임 상태, 룸, StateView를 소유하는 게임 프레임워크라서 기각됐다. Fastify는 그 계층을 건드리지 않는 순수 HTTP 프레임워크이므로 기각 결정과 무관하다. 채널과 브로드캐스트(D3)는 여전히 in-process EventEmitter이며 이 보정으로 바뀌지 않는다.

### 3.6 프로토콜·입력·i18n (D4·D4-b·D5)

command(클라→서버)와 event(서버→클라) 계약을 명시적으로 분리한다.
- 메시지마다 Zod 스키마 1개를 두고 `z.infer`로 TS 타입을 파생한다(병렬 `type` 금지). `domain:action` discriminator 래퍼를 쓴다.
- 명령 인자는 5개 패턴으로 모인다: 무인자 / 대상+서수 / 대상+보조대상 / 자유텍스트 / 대화형 다단.
- 권한은 미들웨어 레이어로 처리한다(입력 파싱과 분리).
- 좌표는 클라이언트가 파생한다(서버는 그래프의 권위, A4).

**입력=구조화 UI + 자유 텍스트 병행.** 명령은 버튼, 메뉴, 타겟으로 입력하고, 말과 이모트는 자유 채팅으로 입력한다. 파워유저를 위한 자유 명령줄 옵션도 둔다. 한글 동사-후치 파싱은 자유 모드에서만 쓰는 콘텐츠다.

**i18n**: UTF-8 전용이다(EUC-KR→UTF-8 변환은 `port/`에서 1회). 런타임 변환 경계는 없다. 조사는 Unicode 산술(`(code-0xAC00)%28`)로 클라이언트 i18n 레이어가 렌더한다(서버는 명사와 조사 슬롯 코드를 보낸다). `으로/로`의 ㄹ 예외는 고친다(구현 방식 P2).

### 3.7 인증·권한 (D6)

- account를 독립시키고 `account 1:N character`로 둔다.
- argon2id 해시 + 상수시간 비교(평문 교체).
- 세션 FSM을 명시한다(상태 enum + 핸들러 맵으로 `io->fn` 함수 포인터를 대체).
- WS 핸드셰이크 + TLS를 쓰고, identd와 telnet 협상은 버린다.
- 로그인 실패 잠금 → rate-limit으로 바꾼다.
- authz는 RBAC 역할(builder/moderator/admin)로 한다. 원본 클래스 계급의 이상 동작은 재현하지 않는다(P2). 빌더/운영 권한 분리와 감사 로그는 유지한다.
- `system()` 셸 호출을 없앤다(DB soft-delete).
- DM/빌더 인터페이스는 post-MVP로 미룬다(별도 토픽).

> **인증 방식 보정 (E3, 2026-07-06, 이슈 #32).** 위 "argon2id 해시 + 상수시간 비교(평문 교체)"는 **Firebase Auth(Google OAuth) 위임으로 대체**한다. account = Firebase uid이며 서버는 비밀번호 해시를 보관하지 않는다. 인증 흐름은 다음과 같다.
> 1. 브라우저가 Firebase에 로그인한다.
> 2. HTTP 엔드포인트(`/session/login`)가 `createSessionCookie`로 HttpOnly·Secure·SameSite 세션 쿠키를 발급한다.
> 3. WS 핸드셰이크의 `@fastify/websocket` **preValidation 훅**에서 `verifySessionCookie`와 Origin allowlist(CSWSH 방어)로 검증한다.
>
> **세션 FSM·RBAC·감사 로그·soft-delete 결정은 그대로다.** 인증 크리덴셜을 저장하고 검증하는 메커니즘만 바뀐다. 원작의 "이름=크리덴셜, 평문 비번"(A12)은 여전히 버릴 대상이다. 이 보정은 그 대체 설계를 argon2id 자체 해싱에서 Firebase 위임으로 바꾼 것이다. 세부와 근거는 이슈 #32의 인증 확장 지점(seam) 코멘트에, 영향 범위는 E5(#35)에 있다. P2 구현 방식 정책(§5)과 D6 요약표의 argon2id 표기도 이 보정에 맞춰 갱신했다.

### 3.8 프로젝트 구성 (D8)

pnpm workspaces monorepo를 쓴다. 패키지는 다음과 같다.
- `shared`: 프로토콜 Zod 스키마, 조사 유틸, 게임 데이터 스키마
- `server`: 게임 엔진, `ws`, 영속화
- `client`: 웹 UI
- `port`: 기존 변환기 유지, 순수 JS

빌드는 클라이언트가 Vite, **서버는 tsc(번들러 없음, dev=tsx)**다. 언어는 TypeScript다. 공유 타입은 `shared`를 단일 출처로 서버와 클라이언트가 import한다(빌드 시 타입 소거).

> **서버 번들러 보정 (E1, 2026-07-02).** 원래의 "서버 tsup"은 채택하지 않는다. 착수 리서치에서 세 가지 문제가 드러났다. tsup의 유지보수가 정체됐고(공식 README가 후속작 tsdown을 권장), tsdown은 아직 성숙하지 않았다. 서버는 실행 앱이라 번들이 필요 없다. 그리고 Fastify의 플러그인 오토로드, pino 워커 같은 동적 require가 번들러와 충돌한다. E1은 **서버=tsc(`dist/` 산출)·dev=tsx·start=`node dist/index.js`**로 확정했다. 번들이 필요해지면 tsdown을 다시 평가한다. 태스크 오케스트레이션과 캐시는 Turborepo 2.x(`turbo run`, build/type-check/lint/test)가 담당한다. 구현과 툴체인 기준은 [`monorepo.md`](monorepo.md)를 참조한다.

### 3.9 테스트 전략 (D7)

C oracle을 behavioral oracle로 삼는 **frozen 골든 fixture**를 쓴다(characterization, golden master, approval은 같은 기법이다).
- oracle은 fixture *생성기*로만 쓰고 결과를 체크인한다. CI는 순수 TS로 돈다(32비트 툴체인 불필요).
- 대상은 순수 공식 함수다: 전투 데미지·thaco·명중, 마법 지속·데미지, exp 곡선·레벨업, 가격 배수.
- 다중 파라미터 테이블은 combination approval로 검증한다.
- property 테스트는 RNG 시드를 고정한다는 전제로 불변식(데미지≥0, 명중률 범위)의 범위를 검증한다.
- fixture는 함수별, 입력 범위별로 좁게 유지한다(큰 공유 fixture는 피한다).
- 버그는 P1에 따라 bug-for-bug 재현/수정을 항목마다 태깅한다.
- testing.md와 일치한다(TDD, 80% 커버리지, vitest).

> **테스트 인프라 주의**: 기존 oracle은 `mstruct.h` 헤더만 쓰는 struct 바이트 대조다. 공식 oracle은 `command5.c`/`magic*.c` 함수를 struct와 전역 의존성까지 포함해 컴파일해야 하므로 실제 작업량이 크다. 이것이 frozen fixture를 채택한 근거다. E8-1(#70)이 이 하네스를 실제로 만들었다. fixture 포맷, zod 스키마, approval 러너, manual 생성기를 `packages/shared/src/oracle/`에 두고, 대표 공식 `compute_ac`로 end-to-end 동작을 증명했다. 상세는 `docs/specs/golden-fixture-harness.md`에 있다. oracle 함수 컴파일 범위는 아래 Open Q 6에서 확정했다.

## 4. 의사결정

| 항목 | 결정 | 근거 |
|------|------|------|
| P1 재현 정책 | as-shipped 기본 + 항목별 결정 | 포팅 원칙 "동작 충실 재현"; A5·A6·A7·A9·A10 버그 목록. 확정 2026-07-01 |
| P2 구현 방식 정책 | 구현 방식은 신규 스택으로 개선 | 구현 방식 개선 원칙 2026-07-01; 노트 전반(telnet→WS, 평문→Firebase Auth 세션 쿠키(§3.7 E3 보정), 파일→Mongo) |
| D0 전송 | 손수 `ws` + EventEmitter (Colyseus 기각); **Fastify HTTP 호스트 + `@fastify/websocket` 보정(E1)** | 장르 부적합, A10 소셜 밀도, 상태 결합, 소규모는 단일 프로세스로 충분; StateView 대규모 필터 비권장(Colyseus 문서); 단일 프로세스 3만~10만 WS 연결(Stack Harbor). **Fastify=HTTP 호스트(정적·`/health`·인증 REST), 게임 소켓=`@fastify/websocket`(내부 `ws`)이므로 "손수 `ws`"·EventEmitter·Colyseus 기각 모두 그대로; §3.5 보정 참조** |
| D1 런타임 | 단일 프로세스, 1Hz heartbeat, next-action 큐 | A1(update_game 1Hz), A9(활성 집합 이벤트 기반), A11(스크립팅 불필요); LuminariMUD·Evennia·LPMud 선례 |
| D2 영속화 | 메모리 그래프 권위 + MongoDB, DB-네이티브 세이브 신규 설계 | A4(load_rom 폐기, 전량 로드), A12(원본 세이브 타이밍을 구현 방식으로 재분류), A8(은행·금화); AlgoDaily 스냅샷 경계·dirty-flag autosave |
| D3 브로드캐스트 | in-process EventEmitter 채널, Redis 후순위 | A10(채널=토픽+필터), A4(방=채널); 단일 프로세스 여유, wildcard fan-out 함정(AhsanLab) |
| D4 프로토콜 | 구조화 JSON command/event, Zod 단일 출처, 공유 타입 | A2(명령=구조화 이벤트, 5 패턴), A3·A11; zod-sockets·OpenFrontIO·tRPC 선례 |
| D4-b 입력 | 구조화 UI + 자유 텍스트 병행 | A2 §arch(동사-후치는 자유 모드 한정); 확정 |
| D5 i18n | UTF-8 전용, 클라 조사 렌더 + ㄹ 예외 수정 | A3(변환 1지점, 조사 콘텐츠, ㄹ 버그); 확정 |
| D6 인증 | account/character, ~~argon2id~~ **Firebase Auth 세션 쿠키**(§3.7 보정·E3), RBAC, WS 핸드셰이크 | A12(account 독립, 평문 교체, FSM), A13(RBAC, DM defer); Firebase 위임 보정 이슈 #32 |
| D7 테스트 | frozen 골든 fixture(oracle=생성기) + property | A5~A8 공식·버그 목록; characterization/approval/oracle 대조(Feathers·ApprovalTests·Fallout2-RE) |
| D8 구성 | pnpm monorepo(shared/server/client/port) + Turborepo; 클라 Vite, **서버 tsc(번들러 없음, dev=tsx), tsup 미채택 보정(E1)** | D4 공유 타입; MongoDB 문서 스키마; monorepo 타입 공유 선례. **tsup 유지보수 정체, 서버는 실행 앱이라 번들 불필요, Fastify 동적 require 충돌 → tsc; §3.8 보정 참조** |
| 동시 접속 규모 | 소규모(~수십~수백 CCU) | 원본 fd 제한 256; 확정 → D0·D1·D3 단일 프로세스 근거 |

## 5. 범위 밖 (Non-goals)

- **게임 규칙 공식 재기술**: 전투·마법·경제 수치는 A5~A9 노트가 기준이다. 이 스펙은 그 공식을 *어떻게 테스트·저장·재계산하는가*만 정한다.
- **개별 서브시스템 구현 스펙**: 전송 계층, 월드 엔진, 전투 엔진, 인증 등의 상세 설계와 구현은 후속 에픽에서 다룬다(§6.7).
- **DM/빌더 도구 범위**: post-MVP로 미룬다(A13 §7.1). 초기 운영은 JSON 직접 수정과 DB 직접 접근으로 한다.
- **수평 확장, 멀티노드, Redis pub/sub**: 목표 규모가 작아 단일 프로세스로 충분하다. 확장이 필요해지면 따로 결정한다.
- **Redis 세션·캐시**: 후순위.
- **네트워크 프레임워크(Colyseus 등) 재검토**: 기각이 확정됐다. 수평 확장이 실제로 필요해지면 다시 평가한다.
- **클라이언트 UI 상세 디자인**: 별도 프론트엔드 토픽.
- **버그별 재현/수정 개별 태깅**: 여기서는 P1 정책만 확정한다. ~40건의 개별 판정은 각 서브시스템 구현 토픽에서 한다.

## 6. Open Questions

1. **autosave/flush 주기 값**: 60~300초 범위를 제시했고, 정확한 값은 부하 테스트로 정한다(새로 정하는 값이며 원본에 참조할 값이 없다).
2. **은행 문서 위치**: character 인라인 vs 별도 컬렉션(A8: 둘 다 가능). 영속화 구현 토픽에서 정한다.
3. **은행 이자**: 원작의 무이자(as-shipped) vs 경제 확장. 기본은 무이자(P1).
4. **계정 email 필수/선택**: 인증 구현 토픽에서 정한다.
5. **PFMBOS(패거리 두목) 임명 규칙**: oracle에서 확인되지 않는다(A10 §6.5). 새로 설계해야 한다(소셜 구현 토픽).
6. **oracle 함수 컴파일 범위**: **E8-1(#70)에서 확정(closed)**. 수동 검산(manual)을 우선하고, 함수별로 실제 C 컴파일(c-compile)을 opt-in하는 하이브리드다. A5~A8이 공식을 라인 단위로 이미 추출해 두어서 대부분은 manual로 적은 비용에 만들 수 있다. 러너가 SUT와 교차 검증해 옮겨 적을 때의 실수(transcription)를 막는다. c-compile은 transcription 위험이 높거나 조합 공간이 큰 함수(RNG 굴림 분포, 13×20 thaco_list 등)에만 쓰며, 첫 소비자인 E6 서브 토픽이 opt-in한다. E8-1은 `method` enum만 남겨 두고 c-compile 드라이버는 만들지 않는다.
7. **후속 구현 에픽 순서**: 제안 순서는 다음과 같다. (a) monorepo 스캐폴딩 → (b) 영속화 기반 → (c) 전송·세션 계층 → (d) 테스트 인프라(게임 규칙 엔진보다 먼저) → (e) 월드 상태 엔진(방, 이동, 인메모리 그래프) → (f) 게임 규칙 엔진(전투, 마법, 진행, 아이템; 여러 토픽) → (g) 인증·계정 → (h) 소셜·채널. 의존 그래프와 에픽 카드 상세는 working 로드맵 `docs/_local/impl-roadmap.md`에 있다. 순서는 각 에픽을 시작할 때 확정한다.

## 7. 관련 문서

- 리서치 보고서: `docs/research/research-architecture-20260701222202.md` (MUD 서버 아키텍처·프로토콜·테스트 전략, 출처 22개)
- 게임 분석 노트: `docs/notes/game-analysis-20260625/a1~a13-*.md`
- 결정 브리핑(working 근거, git-ignored): `docs/_local/decision-brief-14.md`
- 이슈: [#14 스택·아키텍처 결정 게이트](https://github.com/smalljiny/muhan/issues/14)
