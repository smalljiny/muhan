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
| **E1** monorepo 스캐폴딩 (이슈 #30) | ✅ 완료 |
| **E2-1** 영속화 기반 (연결·스키마·repository·부팅 로드, 이슈 #39) | ✅ 완료 |
| **E2-2** 세이브 정책 엔진 (이슈 #40) | 🔜 다음 |
| E3 전송·세션 · E4 월드 엔진 · E5 인증 · E6 게임 규칙 · E7 소셜 · E8 테스트 인프라 | ⏳ 예정 |

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
│   ├── shared/   # 공유 Zod 스키마·타입, 월드 로더, 그래프 타입 (단일 출처)
│   ├── server/   # Fastify 부팅, MongoDB 연결·repository, 인메모리 월드 그래프
│   ├── client/   # Vite 웹 UI 스켈레톤
│   └── port/     # 1993 디스크 포맷 파서·변환기 (순수 JS)
├── data/world/   # port/로 변환된 JSON 월드 데이터 (산출물, 정본)
├── legacy/muhan/ # 원본 C 소스·월드·세이브 (읽기 전용 oracle, EUC-KR)
└── docs/
    ├── specs/    # 정본 스펙 (architecture · monorepo · persistence)
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

| 문서 | 내용 |
|------|------|
| [`docs/specs/architecture.md`](docs/specs/architecture.md) | 서버·클라이언트 스택과 8개 결정 축의 정본 ADR (이슈 #14) |
| [`docs/specs/monorepo.md`](docs/specs/monorepo.md) | pnpm + Turborepo 4패키지 스캐폴딩·툴체인 (E1) |
| [`docs/specs/persistence.md`](docs/specs/persistence.md) | MongoDB 연결·문서 스키마·repository·부팅 월드 로드 (E2-1) |
| `docs/notes/game-analysis-20260625/` | 게임 분석 노트 A1–A13 (런타임·전투·마법·경제·소셜·세션) |
| `docs/research/` | 아키텍처·스캐폴딩 리서치 보고서 (결정 근거 출처) |
