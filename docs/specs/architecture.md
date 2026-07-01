# 무한 서버 아키텍처 스펙

**상태**: Accepted (아키텍처 결정 기록, 이슈 #14)
**작성일**: 2026-07-01
**작성자**: @smalljiny

> **문서 범위**: 무한 MUD 포팅의 서버·클라이언트 기술 스택과 아키텍처를 확정하는 **정본 결정 기록(ADR)**이다. 게임 분석 A1~A13 노트와 이슈 #14 결정 대화를 입력으로, 런타임·영속화·전송·프로토콜·i18n·인증·테스트·프로젝트 구성 8개 축을 확정한다. 개별 서브시스템의 상세 구현 스펙은 이 문서에서 파생되는 후속 토픽이 다룬다(§1.3, §6). 게임 규칙 공식(전투·마법·경제 수치)은 A5~A9 노트가 정본이며 여기서 재기술하지 않는다.

## 1. 개요

### 1.1 배경

무한은 1991~93년 Mordor MUD의 한국어 파생본(32비트 C, telnet, fork 없는 단일 프로세스 `select` 루프, 파일 기반 세이브)이다. 전 디스크 포맷 역설계·JSON 변환이 완료됐고(`data/world/` = 방 2341 + object 709 + creature 674 ≈ 2.9MB), 게임 분석 A1~A13이 런타임·명령·전투·마법·진행·경제·몬스터 AI·소셜·특수 오브젝트·세션·DM 전 영역의 동작 명세를 확보했다. 남은 것은 서버 코드 이전에 스택·아키텍처를 확정하는 것이다(이슈 #14).

포팅 원칙: 게임 콘텐츠·규칙(무엇을)은 충실 이식, 소프트웨어 형상(어떻게)은 신규 스택으로 재설계. 1:1 트랜스파일이 아니다. `legacy/muhan/src`는 이식 대상이 아니라 behavioral oracle이다.

### 1.2 목적

- 8개 결정 축을 확정해 서버 스캐폴딩·구현 토픽이 시작할 수 있는 아키텍처 기준선을 세운다.
- 각 결정의 근거를 게임 분석 노트·외부 선례 리서치와 함께 기록해, 후속 구현이 재논쟁 없이 참조하게 한다.
- 콘텐츠(충실 재현) vs 형상(적극 개선)의 경계와 두 프로젝트 정책(as-shipped 재현 / 형상 개선)을 명문화한다.

### 1.3 결합 근거 (Coupling Rationale)

이 스펙의 목표들(§2)은 개별 배포 단위가 아니라 **하나의 일관된 대상 아키텍처를 함께 정의**한다. 전송(D0)이 프로토콜(D4)·브로드캐스트(D3)·틱(D1)을 규정하고, 영속화(D2)가 인증(D6)·상태 모델을 규정하는 등 상호 의존한다. 따라서 이 문서는 **분할하지 않는 결정 기록(ADR)** 으로 유지한다. 실제 *구현*은 이 기준선에서 파생되는 서브시스템 단위 **에픽**(예: monorepo 스캐폴딩, 전송·세션 계층, 월드 상태 엔진, 게임 규칙 엔진, 인증, 소셜·채널, 테스트 인프라)으로 나뉜다(§6.7). 이 ADR의 플랜을 서브시스템 전체 구현 계획으로 확장하지 않는다.

> **용어 위계**: **에픽**(서브시스템 단위 작업 묶음) → **토픽**(하네스 `/flow-spec`→`/flow-pr` 단위, `dev-context.json` 1항목·spec 1개·PR 1개) → **Story**(토픽 플랜 내 단일 커밋 단위). 에픽 하나는 1개 이상의 토픽을 낳는다(작은 에픽은 1:1, 게임 규칙 엔진 같은 큰 에픽은 여러 토픽으로 분할).

## 2. 목표

1. **런타임 모델 확정** — 단일 프로세스 이벤트 루프 + 중앙 heartbeat + 엔티티별 next-action 스케줄.
2. **영속화 경계 확정** — 인메모리 권위 상태 그래프 + MongoDB DB-네이티브 세이브 정책.
3. **전송 계층 확정** — 손수 `ws` + in-process EventEmitter 채널(Colyseus 반려).
4. **프로토콜 확정** — 구조화 JSON command/event 계약 + Zod 단일 출처 + 공유 타입.
5. **입력·i18n 확정** — 구조화 UI + 자유 텍스트 병행, UTF-8 전용, 조사 규칙 클라 렌더.
6. **인증·권한 확정** — account/character 분리, argon2id, RBAC, WS 핸드셰이크.
7. **테스트 전략 확정** — C oracle 대조 frozen 골든 fixture + property 테스트.
8. **프로젝트 구성 확정** — pnpm monorepo + Vite/tsup.
9. **정책 명문화** — §4의 두 전역 정책(as-shipped 재현 / 형상 개선)과 전역 불변식.

## 3. 아키텍처

### 3.1 전역 정책

- **P1. as-shipped 재현 기본 + 항목별 결정.** 게임 규칙(콘텐츠)은 원본 동작을 충실 재현하며, 노트가 발견한 ~40개 버그·데드코드도 기본값은 재현(behavioral parity, binary parity 아님). 되살림·수정은 항목별 명시 결정. 테스트는 '선택된 동작'을 assert.
- **P2. 형상은 재현이 아니라 개선.** 과거 기술 제약(파일 저장·telnet·select·32비트·평문)의 산물인 형상은 신규 스택으로 적극 개선한다. 단 이 원칙은 일반 현대화 인프라를 정당화할 뿐 특정 프레임워크 채택을 자동 정당화하지 않는다(적합성 별도 판단).
- P1·P2는 상보적: 콘텐츠=충실 재현, 형상=개선. 경계가 모호하면(예: 조사 ㄹ 예외) 제약 산물인지로 판정한다.

### 3.2 전역 불변식 (노트 확정)

1. 선언적 데이터 테이블 > 하드코딩 공식 — bonus·thaco·exp·class_stats·spell·price·spawn을 JSON/config로(A5~A9). 밸런스 튜닝·테스트를 코드에서 분리.
2. base 스탯 + 모디파이어 레이어 분리 — 파생 스탯(AC·thaco·소지량·재생)은 유효 스탯의 순수 함수(A7 §12 최우선, A8 §2).
3. 효과/전달 분리 — 순수 효과 함수 + delivery 어댑터(cast/scroll/potion/wand), caster 공통 인터페이스(A6).
4. 타이머 = 스케줄러·이벤트 — `lasttime`+`LT` 매크로 → "다음 가용 시각" 필드 + 만료 이벤트(A1·A5·A6·A7·A9).
5. 단일 object 스키마 + 참조 컨테이너 — 방·몹·플레이어·은행이 objectId 배열로 참조, 착용은 슬롯 맵(A8 §11.1).
6. 보안 결함 수정 필수(재현 금지) — 셸 인젝션(board/mail/suicide `system()`)·평문 비밀번호·금화 무가드(A10·A12·A8).

### 3.3 런타임 모델 (D1)

단일 프로세스 + Node(libuv) 이벤트 루프. 중앙 heartbeat(1Hz `setInterval`)가 저빈도 갱신(게임시간·랜덤 스폰·침공·출구 개폐)을 modulo 간격으로 게이트한다(원본 `update_game` + `update_*` 구조 재현, LuminariMUD·DikuMUD 계열의 표준 패턴). 전투·몬스터 AI는 매초 전체 순회 대신 **활성 크리처의 next-action 우선순위 큐**로 스케줄하고(A9), "빈 방=시간 정지" 의미를 유지한다(방 점유 이벤트로 활성 집합 증분 갱신). 게임 시계 단위=초. 범용 스크립팅 엔진 불필요 — 유한한 special handler 레지스트리로 충분(A11).

### 3.4 영속화 (D2)

라이브 권위 상태 = 프로세스 메모리 객체 그래프(방 2341 부팅 시 전량 로드, 원본 `load_rom` LRU+write-back 폐기). MongoDB = 영속화 계층이며 hot-path 왕복 금지. **세이브 정책은 DB-네이티브로 신규 설계**(원본의 이벤트-only 세이브 타이밍은 파일 시대 형상 P2): (1) 플레이어=dirty-flag 주기 flush(60~300초) + 중요 이벤트(레벨업·거래·로그아웃) 즉시 write, (2) 월드 변경(문·리스폰 타임스탬프)=비동기 배치, (3) 경제·은행=트랜잭션(원자성). "객체 그래프가 아니라 값을 저장"(안정 ID·평문·version 필드). account/character는 별도 문서, 인벤토리·통화는 character에 임베드. 금화 무결성 가드(상한·음수·트랜잭션) 필수.

### 3.5 전송·브로드캐스트 (D0·D3)

**손수 `ws` + in-process EventEmitter 채널.** Colyseus 반려(성능 아님 — 장르 부적합·A10 소셜 밀도로 채널 레이어 재구현·상태 커플링·목표 소규모는 단일 프로세스로 충분; 단일 Node 프로세스가 WS 3만~10만 연결 처리로 수십~수백 CCU 목표를 압도). 채널 = EventEmitter 토픽 + 구독 필터: 방=채널(이동=leave+join), 전역(잡담·환호)·패거리·결혼·wiz·eaves 토픽. 수신자 플래그(PNOBRD·PEAVES·class)=구독 술어, 가시성(어둠·투명) 필터=송신 시점. 비용·게이트 곡선(잡담 HP·레벨20·일일한도·외침 1홉)은 수치까지 이식. Redis pub/sub은 수평 확장 시점 후순위(도입 시 wildcard 금지·방별 on-demand 구독).

### 3.6 프로토콜·입력·i18n (D4·D4-b·D5)

command(클라→서버)·event(서버→클라) 계약을 명시 분리. 메시지당 Zod 스키마 1개 + `z.infer`로 TS 타입 파생(병렬 `type` 금지), `domain:action` discriminator 봉투. 명령 인자는 5개 패턴으로 수렴(무인자 / 대상+서수 / 대상+보조대상 / 자유텍스트 / 대화형 다단). 권한=미들웨어 레이어(입력 파싱과 분리). 좌표=클라 파생(서버는 그래프 권위, A4). **입력=구조화 UI + 자유 텍스트 병행**(명령=버튼·메뉴·타겟, 말·이모트=자유 채팅, 파워유저 자유 명령줄 옵션; 한글 동사-후치 파싱은 자유 모드 한정 콘텐츠). **i18n**: UTF-8 전용(EUC-KR→UTF-8은 `port/`에서 1회), 런타임 변환 경계 없음. 조사=Unicode 산술(`(code-0xAC00)%28`) 클라 i18n 레이어 렌더(서버는 명사+조사 슬롯 코드 전송), `으로/로` ㄹ 예외 수정(형상 P2).

### 3.7 인증·권한 (D6)

account 1급 + `account 1:N character`. argon2id 해시 + 상수시간 비교(평문 교체). 세션 FSM 명시(상태 enum + 핸들러 맵, `io->fn` 함수 포인터 대체). WS 핸드셰이크 + TLS, identd·telnet 협상 폐기. 로그인 실패 잠금 → rate-limit. authz=RBAC 역할(builder/moderator/admin, 원본 클래스 계급 이상현상 재현 안 함, P2), 빌더/운영 권한 분리·감사 로그 유지. `system()` 셸 호출 제거(DB soft-delete). DM/빌더 표면은 post-MVP defer(별도 토픽).

### 3.8 프로젝트 구성 (D8)

pnpm workspaces monorepo. 패키지: `shared`(프로토콜 Zod 스키마·조사 유틸·게임 데이터 스키마) / `server`(게임 엔진·`ws`·영속화) / `client`(웹 UI) / `port`(기존 변환기 유지, 순수 JS). 빌드: 클라 Vite, 서버 tsup. TypeScript. 공유 타입은 `shared` 단일 출처로 서버·클라가 import(빌드 시 타입 소거).

### 3.9 테스트 전략 (D7)

C oracle을 behavioral oracle로 삼는 **frozen 골든 fixture**(characterization=golden master=approval 동일 기법). oracle은 fixture *생성기*로만 쓰고 체크인, CI는 순수 TS(32비트 툴체인 불요). 대상: 순수 공식 함수(전투 데미지·thaco·명중, 마법 지속·데미지, exp 곡선·레벨업, 가격 배수). 다중 파라미터 테이블은 combination approval. property 테스트는 RNG 시드 고정 전제로 불변식(데미지≥0·명중률 범위) 범위 검증. fixture는 함수별·입력 범위별로 좁게 유지(큰 공유 fixture 회피). 버그는 P1대로 bug-for-bug 재현/수정을 항목별 태깅. testing.md 정합(TDD·80% 커버리지·vitest).

> **테스트 인프라 주의**: 기존 oracle은 `mstruct.h` 헤더-only struct 바이트 대조다. 공식 oracle은 `command5.c`/`magic*.c` 함수를 struct·전역 의존성까지 컴파일해야 하므로 실 작업량이 크다 — frozen fixture 채택 근거이며, 후속 테스트 인프라 토픽이 oracle 함수 컴파일 범위를 별도 스코핑한다.

## 4. 의사결정

| 항목 | 결정 | 근거 |
|------|------|------|
| P1 재현 정책 | as-shipped 기본 + 항목별 결정 | 포팅 원칙 "동작 충실 재현"; A5·A6·A7·A9·A10 버그 목록. 확정 2026-07-01 |
| P2 형상 정책 | 형상은 신규 스택으로 개선 | 형상 개선 원칙 2026-07-01; 노트 전반(telnet→WS·평문→argon2id·파일→Mongo) |
| D0 전송 | 손수 `ws` + EventEmitter (Colyseus 반려) | 장르 부적합·A10 소셜 밀도·상태 커플링·소규모는 단일 프로세스 충분; StateView 대규모 필터 비권장(Colyseus 문서); 단일 프로세스 3만~10만 WS 연결(Stack Harbor) |
| D1 런타임 | 단일 프로세스, 1Hz heartbeat, next-action 큐 | A1(update_game 1Hz), A9(활성 집합 이벤트 구동), A11(스크립팅 불요); LuminariMUD·Evennia·LPMud 선례 |
| D2 영속화 | 메모리 그래프 권위 + MongoDB, DB-네이티브 세이브 신규 설계 | A4(load_rom 폐기·전량 로드), A12(원본 세이브 타이밍=형상 재분류), A8(은행·금화); AlgoDaily 스냅샷 경계·dirty-flag autosave |
| D3 브로드캐스트 | in-process EventEmitter 채널, Redis 후순위 | A10(채널=토픽+필터), A4(방=채널); 단일 프로세스 여유·wildcard fan-out 함정(AhsanLab) |
| D4 프로토콜 | 구조화 JSON command/event, Zod 단일 출처, 공유 타입 | A2(명령=구조화 이벤트·5 패턴), A3·A11; zod-sockets·OpenFrontIO·tRPC 선례 |
| D4-b 입력 | 구조화 UI + 자유 텍스트 병행 | A2 §arch(자유 모드 한정 동사-후치); 확정 |
| D5 i18n | UTF-8 전용, 클라 조사 렌더 + ㄹ 예외 수정 | A3(변환 1지점·조사 콘텐츠·ㄹ 버그); 확정 |
| D6 인증 | account/character, argon2id, RBAC, WS 핸드셰이크 | A12(account 승격·평문 교체·FSM), A13(RBAC·DM defer) |
| D7 테스트 | frozen 골든 fixture(oracle=생성기) + property | A5~A8 공식·버그 목록; characterization/approval/oracle 대조(Feathers·ApprovalTests·Fallout2-RE) |
| D8 구성 | pnpm monorepo(shared/server/client/port) + Vite/tsup | D4 공유 타입; MongoDB 문서 스키마; monorepo 타입 공유 선례 |
| 동시 접속 규모 | 소규모(~수십~수백 CCU) | 원본 fd 제한 256; 확정 → D0·D1·D3 단일 프로세스 근거 |

## 5. 범위 밖 (Non-goals)

- **게임 규칙 공식 재기술** — 전투·마법·경제 수치는 A5~A9 노트가 정본. 이 스펙은 그 공식을 *어떻게 테스트·저장·재계산하는가*만 규정.
- **개별 서브시스템 구현 스펙** — 전송 계층·월드 엔진·전투 엔진·인증 등의 상세 설계·구현은 후속 에픽(§6.7).
- **DM/빌더 도구 표면** — post-MVP defer(A13 §7.1). 초기 운영=JSON 직접 수정 + DB 직접 접근.
- **수평 확장·멀티노드·Redis pub/sub** — 목표 소규모에선 단일 프로세스로 충분. 확장 필요 시점에 별도 결정.
- **Redis 세션·캐시** — 후순위.
- **네트워크 프레임워크(Colyseus 등) 재검토** — 반려 확정. 수평 확장이 실제 필요해지면 재평가.
- **클라이언트 UI 상세 디자인** — 별도 프론트엔드 토픽.
- **버그별 재현/수정 개별 태깅** — P1 정책만 확정. ~40건 개별 판정은 각 서브시스템 구현 토픽에서.

## 6. Open Questions

1. **autosave/flush 주기 값** — 60~300초 범위 제시, 정확값은 부하 테스트로 결정(신규 값, 원본 참조 없음).
2. **은행 문서 위치** — character 인라인 vs 별도 컬렉션(A8: 둘 다 정합). 영속화 구현 토픽에서.
3. **은행 이자** — 원작 무이자(as-shipped) vs 경제 확장. 기본 무이자(P1).
4. **계정 email 필수/선택** — 인증 구현 토픽에서.
5. **PFMBOS(패거리 두목) 임명 규칙** — oracle상 불명(A10 §6.5). 신규 설계 필요(소셜 구현 토픽).
6. **oracle 함수 컴파일 범위** — 어느 공식을 실제 C 함수 대조까지 갈지 vs 수동 검산 fixture로 충분한지. 테스트 인프라 토픽에서.
7. **후속 구현 에픽 순서** — 제안: (a) monorepo 스캐폴딩 → (b) 영속화 기반 → (c) 전송·세션 계층 → (d) 테스트 인프라(게임 규칙 엔진 선행) → (e) 월드 상태 엔진(방·이동·인메모리 그래프) → (f) 게임 규칙 엔진(전투·마법·진행·아이템, 다수 토픽) → (g) 인증·계정 → (h) 소셜·채널. 의존 그래프·에픽 카드 상세는 working 로드맵 `docs/_local/impl-roadmap.md`. 순서는 각 에픽 착수 시 확정.

## 7. 관련 문서

- 리서치 보고서: `docs/research/research-architecture-20260701222202.md` (MUD 서버 아키텍처·프로토콜·테스트 전략 22개 출처)
- 게임 분석 노트: `docs/notes/game-analysis-20260625/a1~a13-*.md`
- 결정 브리핑(working 근거, git-ignored): `docs/_local/decision-brief-14.md`
- 이슈: [#14 스택·아키텍처 결정 게이트](https://github.com/smalljiny/muhan/issues/14)
