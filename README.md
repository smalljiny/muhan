# 무한대전 (Muhan)

> 모뎀의 연결음과 터미널에 끝없이 올라가는 텍스트들이 나의 세상이던 그때가 가끔은 그립습니다.
> 아주 오래전부터 하드디스크 한켠에 숨겨둔 무한대전을 웹버전으로 포팅해보고 싶었습니다.
> 하지만 현실의 수많은 제약과 게으름으로 엄두를 못내고 있었는데 시도할 수 있게 해준 claude와 codex에 경의를 표합니다. 

1991–93년 **Mordor** MUD의 한국어 파생본 **"무한대전"**(32비트 C, telnet)을 **Node.js 서버 + 웹 UI**로 재구현하는 포팅 프로젝트.

원본은 `fork` 없는 단일 프로세스 `select` 루프에 파일 기반 세이브를 쓰는 1993년 32비트 C 텔넷 서버다. 이 저장소는 원본의 **디스크 포맷을 바이트 단위로 역설계**해 월드 데이터를 JSON으로 변환했고(전 포맷 해독 완료), 그 위에 TypeScript 서버·웹 클라이언트를 세우는 중이다.

---

## 포팅 원칙

**"포팅" = 게임 콘텐츠·구조·규칙(무엇을)은 충실히 이식 + 소프트웨어 형상(어떻게)은 신규 스택으로 재설계.** 1:1 코드 트랜스파일이 아니다.

| | 다루는 방식 |
|---|---|
| **충실히 이식** (콘텐츠) | 월드 데이터, 게임 규칙(전투 공식·thaco·마법·경제·레벨링), 명령 어휘·한글 의미론, 틱/라운드 타이밍 *의미* |
| **자유롭게 재설계** (형상) | 디스크 포맷 → MongoDB, `fork()+select` → 이벤트 루프+EventEmitter, `lasttime` → JS 스케줄러, telnet → WebSocket+구조화 JSON, 평문 비번 → argon2id 해시 |

원본 `legacy/muhan/src`는 이식 *대상*이 아니라 **동작 명세(behavioral oracle)**다 — 코드를 옮기지 않고 게임이 *무엇을 하는지*를 읽어 관용적으로 재구현한다.

---

## 현재 상태

| 단계 | 상태 |
|------|------|
| 디스크 포맷 역설계 + JSON 변환 | ✅ 완료 (방 2341 · object 709 · creature 674) |
| 게임 분석 A1–A13 (런타임·전투·마법·경제·소셜·세션 전 영역) | ✅ 완료 |
| 스택·아키텍처 결정 (ADR, 이슈 #14) | ✅ 확정 |
| **E1** monorepo 스캐폴딩·툴체인 | ✅ 완료 |
| **E2** 영속화 — 기반(E2-1)·세이브 정책 엔진(E2-2) | ✅ 완료 |
| **E3** 전송·세션 — 프로토콜(E3-1)·인증세션 FSM(E3-2)·연결 수명주기(E3-3)·자유채팅권한 seam(E3-4)·WS 하드닝(유량 제한·자원 가드) | ✅ 완료 |
| **E4** 월드 상태 엔진 — 런타임 기반(1Hz 틱)·이동·방·크리처 스폰/AI | ✅ 완료 |
| **E5** 계정·캐릭터 라이프사이클 (account 1급 모델·생성 인터뷰·진입/재개·soft-delete) | ✅ 완료 |
| **E6** 게임 규칙 — 파생 스탯(stats-core)·근접 전투(combat)·**진행 루프(progression)** | 🔄 진행 중 (진행 루프 = 현재 PR) |
| **웹 클라이언트** — 전송 셸(E9-1)·세션 진입(E10-1) | ✅ 부분 |
| **테스트 인프라** — 골든 fixture 하네스·property 테스트 | ✅ 완료 |
| **E7** 소셜·채널 · 마법·경제 규칙 엔진 확장 | ⏳ 예정 |

---

## 기술 스택

- **런타임**: Node.js 24, TypeScript, ESM
- **서버**: Fastify(HTTP 호스트) + `@fastify/websocket`(게임 소켓) + in-process EventEmitter(채널·브로드캐스트)
- **영속화**: MongoDB (라이브 권위 상태는 프로세스 메모리 객체 그래프, DB는 세이브 계층)
- **클라이언트**: Vite + 구조화 웹 UI
- **프로토콜**: 구조화 JSON command/event 계약, Zod 단일 출처 + 공유 타입
- **모노레포**: pnpm workspaces + Turborepo, 테스트 Vitest
- **변환기(`packages/port`)**: 순수 CommonJS JS, 의존성 없음

아키텍처 결정의 전체 근거는 [`docs/specs/architecture.md`](docs/specs/architecture.md)(ADR)를 참조한다.

---

## 저장소 구조

```
muhan/
├── packages/
│   ├── shared/   # 공유 Zod 스키마·타입, 월드 로더, 순수 게임 규칙(stats·progression·oracle fixture)
│   ├── server/   # Fastify 부팅, MongoDB 연결·repository, 월드 틱·세션 FSM·전투·진행 seam 소비
│   ├── client/   # React 웹 클라이언트 (전송 셸·세션 진입 플로우)
│   └── port/     # 1993 디스크 포맷 파서·변환기 (순수 JS)
├── data/world/   # port/로 변환된 JSON 월드 데이터 (산출물, 정본)
├── legacy/muhan/ # 원본 C 소스·월드·세이브 (읽기 전용 oracle, EUC-KR)
└── docs/
    ├── specs/    # 정본 스펙 21종 (아키텍처·영속화·전송/세션·월드/게임규칙·클라이언트·테스트 인프라)
    ├── notes/    # 게임 분석 노트 A1–A13
    └── research/ # 아키텍처·스캐폴딩 리서치 보고서
```

`legacy/muhan/`은 빌드/실행 대상이 아니라 **읽기 전용 참조 oracle**이다 — 원본 C 소스(`src/`, EUC-KR), 도움말, 게시판, 월드 데이터, 테스트 캐릭터 세이브를 담는다.

---

## 시작하기

**사전 조건**: Node.js ≥ 24, pnpm 10.33.0 (`packageManager` 핀이 단일 출처), 로컬/원격 MongoDB.

```bash
# 의존성 설치
pnpm install

# 전체 태스크 (Turborepo 오케스트레이션, 증분 캐시)
pnpm build        # turbo run build
pnpm type-check   # turbo run type-check
pnpm lint         # turbo run lint
pnpm test         # turbo run test (Vitest, 80%+ 커버리지 게이트)
```

**서버 실행** (`packages/server`) — MongoDB 연결이 필요하며, 부팅 시 env를 fail-fast 검증한다:

```bash
# .env: MONGODB_URI (필수), MONGODB_DB_NAME (기본 muhan_db_dev), PORT (기본 3000)
pnpm --filter server dev     # tsx watch (개발)
pnpm --filter server build && pnpm --filter server start   # tsc → node dist/index.js
```

부팅 시퀀스는 `getConfig()` → `connectMongo` → repository 인덱스 `init()` → `loadWorldGraph`(방 2341 인메모리) → Fastify 리슨 순의 fail-fast 체인이다. `/health`는 DB ping 기반 상태를 반환한다.

**디스크 포맷 변환기** (`packages/port`, 무빌드 · Node 직접 실행):

```bash
# 방 파일 1개 파싱 검사 (leftover=0 이어야 완벽 파싱)
node packages/port/parseRoom.js legacy/muhan/rooms/r00/r00001 --json

# objmon 템플릿 정규 라인 출력 (C oracle 대조용)
node packages/port/templates.js obj legacy/muhan/objmon/o05

# 전체 월드 → JSON 재변환 (멱등, data/world/ 덮어씀)
node packages/port/convertWorld.js legacy/muhan data/world --pretty
```

**전송 왕복 e2e** (`packages/client/e2e`, Playwright 실브라우저) — compose 스택(server+mongo)을 SUT로 삼아 인증 접속(G1)·버전 협상(G2)·`debug:echo` 왕복(G3)을 end-to-end 검증한다. compose는 e2e 실행 전 외부에서 미리 부팅하고(server:3000+mongo), Playwright는 호스트 Vite(5173)만 기동한다 — Vite가 `/game`·`/dev/login`을 서버로 프록시해 브라우저가 same-origin으로만 통신한다.

```bash
# 최초 1회: chromium 브라우저 설치
pnpm --filter client exec playwright install chromium

# 1. compose 스택 부팅 (server:3000 + mongo, dev 로그인·시드 인증 활성)
docker compose up -d --build

# 2. e2e 실행 (호스트 Vite 5173 자동 기동 + Playwright)
pnpm --filter client e2e

# 3. 정리
docker compose down
```

수집·config resolve만 확인하려면 compose 없이 `pnpm --filter client exec playwright test --list`.

---

## 디스크 포맷 역설계

원본 데이터는 **1993년 32비트 raw 구조체 덤프**다. 모든 포팅·검증이 다음 ABI 위에 선다.

- **32비트 ABI**: `long`=4B, 포인터=4B, little-endian. 텍스트는 **EUC-KR**(완성형).
- **확정 구조체 크기**: `room`=480, `exit_`=44, `object`=352, `creature`=1184, `lasttime`=12.
- 이 크기·필드 오프셋은 i386 Docker로 `sizeof`/`offsetof`를 추출하고, 원본 `mstruct.h`를 그대로 컴파일한 **C oracle**과 JS 파서 출력을 바이트 단위로 diff해 검증 완료(object 907 + creature 1049 전 필드 일치).
- **방의 진짜 ID = 로드 경로 번호**(`rooms/r{N/1000}/r{N:05d}`)이지 구조체 내부 `rom_num`이 아니다. 경로 공식과 안 맞는 파일은 게임이 로드 못 하는 **orphan**(백업/구버전)이라 변환에서 제외한다 — 전체 3216 = 정본 2341 + orphan 875.

세부는 `packages/port/`의 파서(`parseRoom.js`)와 검증된 오프셋 테이블(`templates.js`)을 참조한다.

---

## 작업 추적 모델

별도 progress/backlog 문서를 두지 않는다. 다음이 단일 출처다.

- **GitHub 이슈** = 백로그 (에픽 → 토픽, 1 토픽 = 1 항목)
- **PR** = 완료 항목의 투영 (해당 이슈를 close)
- **`docs/specs/`** = 정본 스펙 (프로젝트 최종 상태와 항상 일치)

용어 위계: **에픽**(서브시스템 단위 작업 묶음) → **토픽**(spec 1개·PR 1개 단위) → **Story**(단일 커밋 단위). 

---

## 문서 안내

**아키텍처·인프라**

| 문서 | 내용 |
|------|------|
| [`architecture.md`](docs/specs/architecture.md) | 서버·클라이언트 스택과 8개 결정 축의 정본 ADR (이슈 #14) |
| [`monorepo.md`](docs/specs/monorepo.md) | pnpm + Turborepo 4패키지 스캐폴딩·툴체인 (E1) |

**영속화**

| 문서 | 내용 |
|------|------|
| [`persistence.md`](docs/specs/persistence.md) | MongoDB 연결·문서 스키마·repository·부팅 월드 로드 (E2-1) |
| [`save-policy.md`](docs/specs/save-policy.md) | dirty-flag 추적·주기 flush·은행 트랜잭션 원자성 세이브 엔진 (E2-2) |

**전송·세션**

| 문서 | 내용 |
|------|------|
| [`transport-protocol.md`](docs/specs/transport-protocol.md) | WS 게임 소켓 배선·Zod 프로토콜 계약·버전 협상·하트비트·라우터 (E3-1) |
| [`auth-session.md`](docs/specs/auth-session.md) | 인증 게이트·세션 FSM(select→create→command)·SessionAuthPort DIP seam (E3-2) |
| [`session-lifecycle.md`](docs/specs/session-lifecycle.md) | 세션 레지스트리·link-dead grace 재연결·idle timeout·disconnect 수렴 seam (E3-3) |
| [`freechat-permission-seam.md`](docs/specs/freechat-permission-seam.md) | actor-context threading·ChannelPort·PermissionPort seam+skeleton (E3-4) |
| [`ws-rate-limit.md`](docs/specs/ws-rate-limit.md) | 인바운드 프레임 토큰 버킷 유량 제한 (WS 하드닝) |
| [`ws-resource-guard.md`](docs/specs/ws-resource-guard.md) | 연결 정원 + 아웃바운드 backpressure 자원 고갈 방어 (WS 하드닝) |

**월드·게임 규칙**

| 문서 | 내용 |
|------|------|
| [`runtime-foundation.md`](docs/specs/runtime-foundation.md) | 1Hz 중앙 월드 틱·타이머 주입 seam·graceful shutdown 수렴 (E4) |
| [`movement-rooms.md`](docs/specs/movement-rooms.md) | 방 그래프·`tryMove`·문 상태머신·방=채널 방송·출구 자동 재잠금 |
| [`creature-spawn.md`](docs/specs/creature-spawn.md) | 크리처 라이브 인스턴스·활성 집합·autonomic AI·스폰 3트리거·사망 라이프사이클 (E4-2) |
| [`stats-core.md`](docs/specs/stats-core.md) | base+modifier 능력치·파생 스탯(AC·THAC0·소지량·HP/MP 최대치) 순수 계산 |
| [`combat.md`](docs/specs/combat.md) | `resolveAttack` 단일 근접 전투 파이프·몬스터 라운드·플레이어 반격 (E6a-1) |
| [`progression.md`](docs/specs/progression.md) | 경험치 곡선·연마 레벨업·능력치 성장·HP/MP 재생·사망 페널티·승급 ← **현재 PR** |

**계정·클라이언트**

| 문서 | 내용 |
|------|------|
| [`account-character.md`](docs/specs/account-character.md) | account 1급 모델·캐릭터 생성 인터뷰·진입/재개·soft-delete FSM·RBAC seam (E5) |
| [`transport-shell.md`](docs/specs/transport-shell.md) | React 클라이언트 WS 인증 접속·프로토콜 왕복·Docker 개발 하네스 (E9-1) |
| [`session-entry.md`](docs/specs/session-entry.md) | 캐릭터 목록·선택·생성·진입/재개 사용자 구동 UI 진입 계층 (E10-1) |

**테스트 인프라**

| 문서 | 내용 |
|------|------|
| [`golden-fixture-harness.md`](docs/specs/golden-fixture-harness.md) | C oracle 대조 frozen 골든 fixture approval-test 인프라 |
| [`property-testing.md`](docs/specs/property-testing.md) | RNG 시드 고정 입력 범위 불변식 검증 fast-check property 테스트 인프라 |

**노트·리서치**

| 문서 | 내용 |
|------|------|
| `docs/notes/game-analysis-20260625/` | 게임 분석 노트 A1–A13 (런타임·전투·마법·경제·소셜·세션) |
| `docs/research/` | 아키텍처·스캐폴딩 리서치 보고서 (결정 근거 출처) |
