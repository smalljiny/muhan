# A13 DM/빌더 기능 카탈로그

**이슈**: [#13](https://github.com/smalljiny/muhan/issues/13) · **분석 대상 oracle**: `dm1.c`~`dm6.c`(운영자·빌더 명령 49종), `global.c`(`cmdlist[]` 디스패치 테이블), `command1.c`(`process_cmd` 권한 게이트 + `log_dmcmd` 호출), `mtype.h`(클래스 계급 상수), `util/ed/`(오프라인 독립 에디터 `editor.c`~`editor4.c`).

## 개요

운영자(DM)·월드 빌더가 게임 안에서 쓰는 명령 표면과, 게임 밖에서 데이터 파일을 직접 편집하는 오프라인 에디터를 카탈로그화한다. 결론부터: **이 표면 전체는 콘텐츠가 아니라 툴링·운영 형상이다.** DM 명령은 `*`로 시작하는 49개 특수 명령이며, 전부 `dm1.c`~`dm6.c`에 구현되고 `global.c`의 단일 `cmdlist[]` 테이블에서 일반 명령과 함께 디스패치된다. `util/ed`는 서버와 별개로 도는 **DOS/curses 메뉴 프로그램**으로, object/creature/room/player 파일을 디스크에서 직접 열어 편집한다(자체 직렬화 루틴 사본 보유).

가장 중요한 구조적 발견: **인게임 편집 명령(방/오브젝트/크리처 생성·필드 설정)은 최소한이고 대부분 DM 최상위 등급으로 게이트된다.** "빌더" 등급인 ZONEMAKER는 실제로 순간이동·인스펙션·저장만 할 수 있고 방을 편집하지 못한다. 즉 **실제 월드 제작은 게임 밖 `util/ed` 에디터에서 이뤄졌고**, 인게임 명령은 그 결과물을 순회·점검·미세조정하는 보조 도구였다.

따라서 각 명령의 포팅 질문은 "이 C 함수를 이식하나?"가 아니라 **"이 capability가 신규 스택에서도 필요한가, 필요하면 어떤 표면(웹 admin/builder UI + API)으로 다시 제공하나?"** 이다. 이 렌즈로 판단이 세 갈래로 정렬된다 — **드롭**(구 아키텍처 종속: 디스크 flush/reload, fork 셧다운 타이머), **대체**(운영·빌딩 capability는 유지, 표면만 교체: 대다수), **이식**(명령이 실제 게임 규칙·시나리오를 인코딩한 드문 경우: `*gcast`/`*떨어져라`/`*침공`의 시나리오 상수만).

이슈 비고대로 이 표면은 **후순위(post-MVP)** 가능성이 크다. 초기 운영은 DB 직접 접근으로 충분하고, 빌더 UI는 월드 규칙(A4~A9)이 서버에 살아난 뒤 얹는다. 본 노트의 산출물은 **카탈로그 + 이식/대체/드롭 판단 + defer 권고**이며, 대체 표면의 상세 설계는 범위 밖이다.

## 핵심 발견 요약

1. **`*` 명령 = 49종, 단일 테이블 디스패치**. 모든 DM 명령은 `*`로 시작하고 `global.c:452~556`의 `cmdlist[]`에 일반 명령과 **한 테이블에** 등록된다(`cmdno` 101~148). 별도 DM 파서·디스패처가 없다. 구현은 `dm1.c`~`dm6.c`(+ `update.c`의 `list_act`)에 분산. 한글 별칭이 명령마다 1~3개씩 붙어 있다(`*teleport`=`*순간이동`).

2. **2계층 권한 게이트, 임계값 어긋남**. (a) **Outer**(`process_cmd`, `command1.c:608`): `*` 명령은 `class >= CARETAKER(10)` 또는 `class == ZONEMAKER(0)`만 통과, 아니면 "이런 명령어는 없네요"로 **존재 자체를 은폐**. (b) **Inner**(각 `dm_*` 함수 첫 줄): 명령마다 `< SUB_DM(11)` 또는 `< DM(12)`, 일부는 `!= ZONEMAKER && < SUB_DM`(빌더 특례), 3종은 게이트 없음. 두 게이트의 임계값이 어긋나 아래 이상현상이 발생한다.

3. **클래스 계급이 정수 순서와 어긋남**. `ZONEMAKER=0`(빌더)이 플레이어(1~8)·`INVINCIBLE=9`보다 **낮은 값이지만 더 높은 권한**을 갖는다. Outer 게이트가 `!= ZONEMAKER` 특례로 0을 통과시키기 때문. 계급: `ZONEMAKER 0 < 플레이어 1~8 < INVINCIBLE 9 < CARETAKER 10 < SUB_DM 11 < DM 12`.

4. **인게임 편집은 DM 전용, 빌더 등급은 편집 불가**. 방 생성(`*add`)·필드 설정(`*set`)·방 이름/설명 편집(`*name`/`*append`/`*replace`/`*delete`)은 전부 **DM(12) 전용**이다. 아이템/크리처 스폰(`*create`/`*monster`)만 SUB_DM(11). ZONEMAKER(0)이 쓸 수 있는 편집 명령은 **하나도 없다** — 순간이동(`*순간이동`)·인스펙션(`*status`/`*방번호`)·저장(`*사용자저장`)과 이벤트 2종뿐. 실제 방·오브젝트 제작은 오프라인 `util/ed`(§4)에서 했다는 강한 증거.

5. **무게이트 명령 3종 + CARETAKER/INVINCIBLE 이상현상**. inner 게이트가 아예 없는 명령은 `*사용자저장`(`dm_save_all_ply` body가 `save_all_ply();` 한 줄)·`*떨어져라`·`*침공` **3종뿐**. 따라서 CARETAKER(10)는 outer를 통과하지만 나머지 모든 명령의 `< SUB_DM`/`< DM` 게이트에 막혀 **이 3종만 실행 가능**하다. INVINCIBLE(9)은 outer 게이트에서 완전 차단되어 **실행 가능한 `*` 명령이 0개**다. 둘 다 계급 값 배치의 부작용(레거시 불일치)으로 판단.

6. **`util/ed` = 서버 외부 오프라인 에디터**. `editor.c` `main()`은 "1.Edit Object / 2.Edit Creature / 3.Edit Room / 4.Edit Player / 5.Check Player / 6.Quit" 메뉴를 도는 **독립 실행 프로그램**(`clearscreen`/`posit`/`getnum` = 커서 제어). `editor3.c`/`editor4.c`에 서버 `files1.c`/`files3.c`와 **중복된 직렬화 루틴 사본**을 갖는다. `editor.exe`+`editor.mak`(Visual C++)로 PC에서 편집 후 서버로 파일 전송하는 워크플로우. 순수 형상 — 신규 스택에서는 빌더 UI가 통째로 대체하며, 이 에디터가 노출하던 **편집 필드 집합**이 UI 설계의 선례가 된다.

7. **모든 `*` 명령은 감사 로그된다**. `process_cmd`가 디스패치 직전 `if(str[0][0]=='*') log_dmcmd("%s : %s :", name, fullstr)`를 호출해 `LOGPATH/log_dmcmd`에 `누가 : 원문 :`을 append한다(`command1.c:630`). 실패한 명령도 시도 시점 기록. 신규 스택에서 admin action audit trail의 이식 요구사항.

8. **스크립트형 GM 이벤트 3종이 콘텐츠를 인코딩**. `*gcast`(`dm_gspells`)는 실제 마법 공식(SVIGOR/SRESTO 등)을 재사용하고, `*떨어져라`(`dm_moonstone`)는 오브젝트 #640을 랜덤 방에 스폰, `*침공`(`dm_monster`)은 몬스터 265~299를 방 3601~3630에 투입 + 하드코딩 방송 대사("드레니아 몹 침공", NPC "라작"). 메커니즘은 툴이지만 **시나리오 상수·대사는 콘텐츠**이므로 이벤트를 유지할 경우 데이터로 외부화한다.

9. **`*set`은 완전한 DM을 만들 수 없다(권한 상승 방지)**. `dm_set_crt`(`dm3:174`)가 플레이어 class를 `DM(12)`로 지정하면 강제로 `SUB_DM(11)`로 낮춘다. 게임 안 도구로 최상위 권한을 부여할 수 없게 한 안전장치. 신규 admin UI에서 역할 승격은 별도 경로로 계승할 가치가 있다.

> **스코프 정직성**: 본 분석은 **`*` 명령 게이트에 한정**한다. 클래스별 특권은 `*` 밖에도 걸쳐 있다 — 예: DM은 idle timeout 면제([A12](a12-session-auth.md) §1.4, `update_users`), `PDMINV`(DM 은신) 플래그로 하위 클래스에게 안 보임 등. 비-`*` 특권은 해당 시스템 노트가 각자 다룬다.

---

## 1. 권한 모델

### 1.1 클래스 계급 상수 (`mtype.h:93~105`)

```c
#define ZONEMAKER   0   /* 빌더: 값은 최저지만 outer 게이트 특례로 * 접근 */
#define ASSASSIN    1   /* ┐                                             */
#define BARBARIAN   2   /* │                                             */
#define CLERIC      3   /* │                                             */
#define FIGHTER     4   /* ├ 일반 플레이어 직업 (1~8) — * 명령 전면 차단  */
#define MAGE        5   /* │                                             */
#define PALADIN     6   /* │                                             */
#define RANGER      7   /* │                                             */
#define THIEF       8   /* ┘                                             */
#define INVINCIBLE  9   /* * 명령 0개 (outer 게이트 차단) — 레거시 불일치 */
#define CARETAKER   10  /* 무게이트 3종만 실행 가능                       */
#define SUB_DM      11  /* DM 전용 명령 제외 전부                         */
#define DM          12  /* 전부                                          */
```

`class`는 `creature` 구조체의 필드로, 크리처(플레이어 포함)의 직업이자 곧 권한 등급이다. 일반 직업(1~8)과 운영 등급(0, 9~12)이 **같은 필드를 공유**한다 — "계정 역할"이 없는 A12의 발견과 궤를 같이한다.

### 1.2 2계층 게이트

**Outer 게이트 (`process_cmd`, `command1.c:608`)**:

```c
if(match == 0 || (cmnd->str[0][0]=='*' &&
                  (Ply[fd].ply->class < CARETAKER &&
                   Ply[fd].ply->class != ZONEMAKER))) {
        print(fd, "\"%s\": 이런 명령어는 없네요.", cmnd->str[0]);
        RETURN(fd, command, 1);
}
```

`*` 명령은 `class < CARETAKER(10) && class != ZONEMAKER(0)`일 때 차단되고, 메시지가 "권한 없음"이 아니라 **"이런 명령어는 없네요"** — 존재를 은폐한다(보안상 의도적).

**Inner 게이트 (각 `dm_*` 함수 첫 줄)** — 세 유형:

```c
if(ply_ptr->class < DM)                                    /* DM(12) 전용 — 편집·운영 대다수 */
        return(PROMPT);
if(ply_ptr->class < SUB_DM)                                /* SUB_DM(11)+ — 스폰·조작·인스펙션 */
        return(PROMPT);
if(ply_ptr->class != ZONEMAKER && ply_ptr->class < SUB_DM) /* 빌더 특례 — ZONEMAKER 허용 */
        return(PROMPT);
/* (게이트 없음: 사용자저장·떨어져라·침공 3종) */
```

### 1.3 유효 capability 매트릭스 (게이트 실측 종합)

| class | 값 | outer 통과 | 실행 가능한 `*` 명령 |
|---|---|---|---|
| ZONEMAKER | 0 | ✅ (특례) | 무게이트 3종 + 빌더특례 3종 = `*순간이동`·`*status`·`*방번호`·`*사용자저장`·`*떨어져라`·`*침공` (**편집 명령 0개**) |
| 플레이어 | 1~8 | ❌ | 없음 |
| INVINCIBLE | 9 | ❌ | **없음** (outer 차단 — 레거시 불일치) |
| CARETAKER | 10 | ✅ | 무게이트 3종만 (`*사용자저장`·`*떨어져라`·`*침공`) |
| SUB_DM | 11 | ✅ | DM 전용 명령 제외 전부 (스폰·조작·인스펙션·gcast) |
| DM | 12 | ✅ | **전부** (편집·god·디스크·이벤트) |

**세 관찰**:
- **ZONEMAKER("빌더")는 인게임에서 편집을 못 한다**. 순간이동으로 순회하고 `*status`로 점검하고 `*사용자저장`으로 저장할 뿐, 방/오브젝트 생성·필드 설정(`*add`/`*set`/`*create`/`*name`)은 SUB_DM/DM 전용이라 접근 불가. 이는 실제 제작이 오프라인 `util/ed`에서 이뤄졌음을 방증한다(§4).
- **CARETAKER(10)는 무게이트 3종만**. outer는 통과하나 모든 명령의 `< SUB_DM`/`< DM` inner 게이트에 막힌다. "관리인" 이름과 달리 저장·이벤트만 트리거 가능한 사실상 무력 등급.
- **INVINCIBLE(9)의 명령 0개**: 값이 CARETAKER보다 낮아 outer에서 걸린다. 계급 값 배치의 부작용으로, 신규 스택에서 재현할 이유 없음.

### 1.4 감사 로그 (`log_dmcmd`, `command1.c:630`)

```c
if(cmnd->str[0][0]=='*')
    log_dmcmd("%s : %s :\n", Ply[fd].ply->name, cmnd->fullstr);
```

모든 `*` 명령이 실행 전에 `LOGPATH/log_dmcmd` 파일에 `이름 : 명령원문 :`으로 append된다(`files*.c:575`, `fopen(..,"a")`). 실패한 명령도 디스패치 시점 기록이므로 시도 자체가 남는다. **이식 요구사항** — admin action은 audit trail을 남긴다.

---

## 2. 운영자·god 명령 카탈로그

플레이어·세계 상태를 실시간 조작하거나 서버를 관리하는 명령. **판단 열**: 이(이식)/대(대체)/드(드롭).

| 명령(별칭) | cmdno | 구현 | 최소 class | 동작 | 판단 |
|---|---|---|---|---|---|
| `*invis`/`*바람처럼사라져`/`*i` | 107 | `dm1:639` | SUB_DM | DM 은신 토글(`PDMINV`) | 대 |
| `*send`/`*공지`/`*s` | 108 | `dm1:134` | SUB_DM | 특정 플레이어에게 시스템 메시지 | 대 |
| `*purge`/`*청소`/`*청` | 109 | `dm1:179` | SUB_DM | 현재 방의 아이템·몬스터 일괄 제거 | 대 |
| `*echo`/`*말` | 112 | `dm1:311` | SUB_DM | 현재 방에 임의 텍스트 방출 | 대 |
| `*force`/`*뭐든지다시켜`/`*f` | 115 | `dm1:704` | SUB_DM¹ | 대상 플레이어에게 임의 명령 강제 실행 | 대 |
| `*ac`/`*방어력` | 110 | `dm1:668` | SUB_DM | 대상 AC 표시·조정 | 대 |
| `*users`/`*누`/`*누구` | 111 | `dm1:234` | SUB_DM | 접속자 목록 + IP/호스트/idle | 대 |
| `*spy`/`*뭐든지다엿봐` | 122 | `dm2:632` | SUB_DM | 대상 플레이어 세션 엿보기 | 대 |
| `*finger`/`*핑거` | 124 | `dm3:751` | SUB_DM | 플레이어 상세(오프라인 포함) | 대 |
| `*list`/`*누구든지다봐` | 125 | `dm3:815` | SUB_DM | 플레이어/엔티티 목록 | 대 |
| `*info`/`*정보` | 126 | `dm3:852` | SUB_DM | 서버 상태·통계 | 대 |
| `*broad`/`*방송` | 129 | `dm4:127` | SUB_DM | 전서버 방송 | 대 |
| `*gcast`/`*전주문` | 134 | `dm4:176` | SUB_DM | 임의 주문 시전(→`dm_gspells`) | 대² |
| `*group`/`*그룹` | 135 | `dm4:419` | SUB_DM | 그룹 상태 조작·열람 | 대 |
| `*dust`/`*나도가끔화낸다` | 141 | `dm6:22` | SUB_DM | 크리처 즉시 소멸(강제 kill) | 대 |
| `*enemy`/`*적` | 145 | `dm6:218` | SUB_DM | 크리처 enemy 목록(`list_enm`) | 대 |
| `*charm`/`*최면` | 146 | `dm6:260` | SUB_DM | 크리처 charm 목록(`list_charm`) | 대 |
| `*attack`/`*공격` | 144 | `dm6:155` | **DM** | 몬스터가 대상을 공격하게 함 | 대 |
| `*cfollow`/`*따르기` | 142 | `dm6:78` | **DM** | 크리처 following 조작 | 대 |
| `*silence`/`*벙어리` | 128 | `dm4:72` | **DM** | 플레이어 발화 차단(mute) | 대 |
| `*parameter`/`*수치` | 127 | `dm4:19` | **DM** | 게임 전역 파라미터 실시간 튜닝 | 대³ |
| `*log`/`*접속` | 121 | `dm3:694` | **DM** | 접속 로그 열람 | 대 |
| `*lock`/`*제한` | 123 | `dm3:729` | **DM** | lockout(사이트 차단) 테이블 재로드 | 대⁴ |
| `*active`/`*활성` | 140 | `update.c:975` | **DM** | 활성 몬스터 목록(`list_act`) | 대 |
| `*perm`/`*영원` | 106 | `dm1:610` | **DM** | 오브젝트를 영구 방 비품(`OPERM2`)으로 지정 | 대⁵ |
| `*shutdown`/`*종료` | 114 | `dm1:381` | **DM** | 셧다운 카운트다운 설정(`now` 즉시) | 드⁶ |
| `*reload`/`*로드` | 103 | `dm1:445` | **DM** | 방을 디스크에서 재로드(캐시 갱신) | 드 |
| `*save`/`*세이브` | 104 | `dm1:466` | **DM** | 방을 디스크에 재저장(`dm_resave`) | 드 |
| `*flushrooms`/`*모든저장` | 113 | `dm1:353` | **DM** | 방 캐시 전체 디스크 flush | 드 |
| `*flushcrtobj`/`*재설정`/`*재` | 116 | `dm1:423` | **DM** | 크리처·오브젝트 템플릿 캐시 flush | 드 |
| `*사용자저장` | 147 | `dm1:13` | 무게이트⁷ | 접속 중 전 플레이어 저장(`save_all_ply`) | 드 |
| `*notepad`/`*메모` | 136 | (`notepad`) | — | DM 개인 메모장(범용 유틸) | 드⁸ |
| `*dmhelp`/`*도움말` | 143 | `dm5:660` | **DM** | 플래그·명령 레퍼런스 출력 | 드⁸ |

¹ `*force` 대상이 DM(12)이면 시전자도 DM이어야 함(`dm1:724`) — DM 간 권한 보호.
² `dm_gspells`(`dm4:315`)는 실제 마법 효과 공식(SVIGOR/SMENDW/SRESTO/SFHEAL/SBLESS/SPROTE…)을 재사용 — 공식 정본 [A6](a6-magic.md). GM 시전 패널로 대체하되 공식은 콘텐츠로 이미 이식됨.
³ 조정 대상 파라미터의 **값 자체**는 밸런스 콘텐츠([A5](a5-combat.md)/[A7](a7-player-progression.md))이나, 런타임 튜닝 UI는 형상.
⁴ lockout 데이터(차단 IP)는 운영 설정. 파일 재로드 메커니즘은 드롭, 차단 정책은 대체(admin 설정 UI).
⁵ 오브젝트를 방 영구 비품으로 만드는 빌더 기능(§3와 경계). `OPERM2`/`OTEMPP` 플래그 의미는 [A8](a8-items-economy.md) 참조.
⁶ 카운트다운 값을 `Shutdown` 전역에 세팅할 뿐. 신규 스택에서는 프로세스 매니저·배포 계층 관심사(§7).
⁷ `dm_save_all_ply` body가 `save_all_ply();` 한 줄 — inner 게이트 없음. outer만 통과하면(ZONE/CARE/SUB_DM/DM) 실행.
⁸ 게임 진행과 무관한 편의 기능. 신규 admin UI 기본 제공이거나 불필요.

---

## 3. 월드 빌더 명령 카탈로그

방·오브젝트·크리처를 게임 안에서 생성·배치·편집하는 명령. `util/ed`(§4)의 in-game 대응물이나, **대부분 DM 전용이라 실제 제작보다 순회·미세조정 용도**다. object/creature/room **필드를 편집 노출**할 뿐이며, 필드 의미론은 [A4 이동·방](a4-movement-rooms.md)·[A8 아이템·경제](a8-items-economy.md)·[A9 몬스터 AI](a9-monster-ai.md)가 정본이다.

| 명령(별칭) | cmdno | 구현 | 최소 class | 동작 | 판단 |
|---|---|---|---|---|---|
| `*teleport`/`*순간이동` | 101 | `dm1:28` | ZONEMAKER | 방/플레이어 간 순간이동(빌더 네비게이션) | 대 |
| `*status`/`*상태` | 118 | `dm2:24` | ZONEMAKER | 방/크리처/오브젝트 stat 덤프(`stat_rom`/`stat_crt`/`stat_obj`) | 대 |
| `*rm`/`*방번호`/`*방` | 102 | `dm1:404` | ZONEMAKER | 현재 방 상태 덤프(`dm_rmstat`) | 대 |
| `*create`/`*뭐든지다만들어`/`*c` | 105 | `dm1:488` | SUB_DM | 템플릿 인덱스로 아이템 생성 → DM 소지품(`load_obj(idx)`+`add_obj_crt`) | 대 |
| `*monster`/`*괴물`/`*괴` | 117 | `dm1:515` | SUB_DM | 템플릿으로 크리처 생성 → 현재 방(`n <count>` 다중) | 대 |
| `*oname`/`*뭐든지다바꿔` | 138 | `dm4:546` | SUB_DM | 오브젝트 이름 변경 | 대 |
| `*add`/`*방제작` | 119 | `dm2:580` | **DM** | 신규 방 파일 생성(`ROOMPATH/rNN/rNNNNN`, `write_rom`) | 대⁹ |
| `*뭐든지다해` (`*set`) | 120 | `dm3:20` | **DM** | 필드 세터 디스패처: `x`=출구 `r`=방 `c/p/m`=크리처 `i/o`=오브젝트 | 대 |
| `*name`/`*방이름` | 131 | `dm5:356` | **DM** | 방 이름 설정 | 대 |
| `*append`/`*추가` | 132 | `dm5:401` | **DM** | 방 설명 끝에 텍스트 추가 | 대 |
| `*prepend`/`*서언` | 133 | `dm5:512` | **DM** | 방 설명 앞에 텍스트 삽입 | 대 |
| `*replace`/`*교체` | 130 | `dm5:26` | **DM** | 설명 텍스트 패턴 치환(`txt_parse`) | 대 |
| `*delete`/`*지우기` | 137 | `dm5:104` | **DM** | 방 설명에서 라인/패턴 삭제(`desc_search`) | 대 |
| `*cname`/`*괴물이름` | 139 | `dm4:683` | **DM** | 크리처 이름 변경 | 대 |

⁹ `dm_add_rom`은 방 번호 경로 공식(`ROOMPATH/r%02d/r%05d`, `num/1000` 샤딩)을 그대로 쓴다 — [A4](a4-movement-rooms.md)·CLAUDE.md의 방 ID 규칙과 동일. 신규 스택에서는 MongoDB 문서 생성으로 대체.

### 3.1 필드 세터·출구 링킹 (`*set` 계열, 전부 DM 전용)

`dm_set`(`dm3:20`)이 첫 인자 문자로 서브 세터를 디스패치한다:

| 서브명령 | 구현 | 편집 대상 |
|---|---|---|
| `*set x …` | `dm_set_ext` (`dm3:314`) | 출구(`exit_`) 필드 |
| `*set r …` | `dm_set_rom` (`dm3:56`) | 방 필드·플래그 |
| `*set c/p/m …` | `dm_set_crt` (`dm3:126`) | 크리처 필드·플래그 |
| `*set i/o …` | `dm_set_obj` (`dm3:382`) | 오브젝트 필드·플래그 |
| `*set … xflg` | `dm_set_xflg` (`dm3:537`) | 확장 플래그 비트 |

출구 생성/삭제는 헬퍼 `link_rom`(`dm3:585`)·`del_exit`(`dm3:624`)이 담당한다. `link_rom`은 같은 방향 출구가 있으면 목적지만 갱신, 없으면 `exit_`+`xtag`를 `malloc`해 연결 리스트에 append한다. `expand_exit_name`(`dm3:652`)·`opposite_exit_name`(`dm3:671`)이 방향 약어(동/서/…)를 정규화·역방향 매핑한다 — 양방향 출구 자동 연결용.

**권한 상승 방지** (`dm_set_crt`, `dm3:174`): 플레이어의 class를 `*set`으로 바꿀 때 `val==DM(12)`을 지정하면 코드가 강제로 `SUB_DM(11)`로 낮춘다 — **`*set`으로는 완전한 DM을 만들 수 없다**. 최상위 권한 부여는 별도 경로(직접 세이브 편집/`util/ed`)로만 가능하다는 안전장치.

### 3.2 오브젝트 영구화 (`*perm`)

`dm_perm`(`dm1:610`, DM 전용)은 현재 방의 오브젝트에 `OPERM2`+`OTEMPP`를 세팅해 **방 리셋 시에도 남는 영구 비품**으로 만든다. 빌더가 방에 고정 오브젝트를 심는 워크플로우. 플래그 의미는 [A8](a8-items-economy.md) 참조.

---

## 4. `util/ed` 오프라인 에디터 — 실제 월드 제작 도구

인게임 편집이 DM 전용으로 제한된 이유의 답: **실제 방·오브젝트·크리처 제작은 이 서버 외부 독립 프로그램에서 했다.** `editor.c`의 `main()`(`util/ed/editor.c:15`)은 커서 제어(`clearscreen`/`posit`/`getnum`) 기반 텍스트 메뉴를 무한 반복한다:

```
1. Edit Object   → edit_object()   (editor.c:59)
2. Edit Creature → edit_monster()  (editor.c:276)
3. Edit Room     → edit_room()     (editor.c:606)  + edit_exits() (editor.c:846)
4. Edit Player   → edit_player()   (editor2.c:17)  + edit_items() (editor2.c:396)
5. Check Player  → check_player()  (editor2.c:497)   [#ifndef WIN32]
6. Quit
```

**특성과 함의**:

- **디스크 파일 직접 편집**: `load_obj_from_file`/`save_obj_to_file`(`editor.c:214/246`), `load_rom_from_file`/`save_rom_to_file`(`editor.c:1038/1065`) 등이 서버를 거치지 않고 objmon 템플릿·방 파일을 직접 연다. 서버 실행 중 쓰면 캐시 불일치가 나므로 **오프라인 빌딩 툴**이다(인게임 `*set`이 DM 전용인 것과 상보적).
- **직렬화 루틴 중복 사본**: `editor3.c`가 `read_obj`/`write_obj`/`read_crt`/`write_crt`/`read_rom`/`write_rom`을, `editor4.c`가 `*_to_mem`/`*_from_mem`을 갖는다 — 서버 `files1.c`/`files3.c`의 **복제본**이다. 두 곳을 따로 유지해야 했던 1993 구조의 흔적.
- **크로스플랫폼 빌드**: `editor.exe`(Windows)·`editor`(Unix)·`editor.mak`/`editor.mdp`(Visual C++ 프로젝트)가 함께 있다. 빌더가 PC에서 편집 → 서버로 파일 전송하는 워크플로우.
- **`compress.c`**: `util/ed`에도 LZW 압축 사본이 있으나, CLAUDE.md 확인대로 실제 세이브는 비압축이므로 **불필요**(형상이지 콘텐츠 아님).

**판단**: 프로그램 전체 **대체(드롭+재설계)**. 신규 스택에서는 웹 빌더 UI가 이 역할을 흡수한다. 다만 `edit_object`/`edit_monster`/`edit_room`/`edit_player`가 **노출하던 편집 필드 집합**은 빌더 UI가 제공해야 할 필드의 선례로 보존 가치가 있다(필드 의미론은 A4/A8/A9 정본, 편집 UX 명세는 이 에디터의 화면 구성 참조).

---

## 5. 스크립트형 GM 이벤트 (콘텐츠 성분)

메커니즘은 툴이지만 **시나리오 상수·대사가 콘텐츠**인 3종. 이벤트를 유지하기로 하면 아래 상수를 보존한다.

| 명령 | 구현 | 시나리오 (하드코딩 콘텐츠) |
|---|---|---|
| `*gcast`/`*전주문` | `dm_gspells` (`dm4:315`) | 마법 효과 공식 재사용(SVIGOR: `hpcur += 1d6+6`, SRESTO: full HP/MP, SBLESS: 3600초 지속 등) — 공식 정본 [A6](a6-magic.md) |
| `*떨어져라` | `dm_moonstone` (`dm5:607`) | 오브젝트 **#640**("초인의 돌")을 `RNOTEL` 아닌 랜덤 방에 스폰, `shotsmax += 1d20`, 방송 "%s에 초인의 돌이 떨어졌습니다" |
| `*침공` | `dm_monster` (`dm5:632`) | 몬스터 **265~299**를 방 **3601~3630**(무적존)에 10회 투입, 방송 "드레니아 몹이 침공했습니다"·NPC "라작" 대사 |

`*떨어져라`·`*침공`은 inner 게이트가 없어 CARETAKER 이상 누구나 트리거할 수 있다(§1.3). **판단**: 이벤트 트리거 자체는 **대체**(admin 이벤트 패널 버튼). 참조하는 오브젝트/몬스터 ID·방 범위·방송 대사는 **이식** 대상 콘텐츠 — 월드 데이터([data/world](../../../data/world))에 이미 존재하는 엔티티를 가리키므로, 이벤트 재현 시 이 상수 세트를 데이터로 외부화한다(하드코딩 금지).

---

## 6. 콘텐츠(이식) vs 형상(재설계) 분류

| 분류 | 대상 | 처리 |
|---|---|---|
| **콘텐츠(이식)** | `*gcast`가 재사용하는 마법 공식, `*떨어져라`/`*침공`의 오브젝트·몬스터 ID·방 범위·방송 대사, `*parameter`가 조정하는 밸런스 값, `*set` 권한 상승 방지 규칙 | 규칙·공식은 A5~A9로 이식됨. 이벤트 유지 시 시나리오 상수를 **데이터로 외부화**. |
| **형상 — 대체** | 운영 명령(invis/send/purge/echo/force/spy/silence/broad/users/finger 등), 빌더 명령(create/monster/set_*/add_rom/link/name/append/replace/oname/cname), stat/inspection, `util/ed` 전체, 감사 로그 | 웹 admin/builder UI + API로 재설계. capability 유지, 표면 교체. |
| **형상 — 드롭** | 디스크 캐시 명령(reload/save/flushrooms/flushcrtobj/사용자저장), `*shutdown` 타이머, `*notepad`/`*dmhelp` 편의, `util/ed`의 `compress.c`, 2계층 게이트의 CARETAKER/INVINCIBLE 이상현상 | 신규 아키텍처(MongoDB+메모리 그래프)에서 무의미하거나 RBAC로 흡수. |

---

## 7. 아키텍처 함의 & 이식/대체/드롭 권고

### 7.1 표면 전체는 post-MVP defer

DM/빌더 표면은 **게임 규칙이 서버에 살아난 뒤에 얹는 운영 계층**이다. 초기 개발·운영은 (a) 월드 편집 = `port/`로 변환한 JSON 직접 수정 후 재로드, (b) 운영 조치 = DB 직접 접근으로 충분하다. 이슈 비고 "후순위 가능성 큼"에 동의하며, **결정 게이트 이후 별도 토픽**으로 다룰 것을 권고한다.

### 7.2 메커니즘 드롭, capability 재설계

- **`*command` telnet 문법·함수 포인터 디스패치·DOS 오프라인 에디터는 이식하지 않는다.** 신규 스택은 WebSocket 구조화 메시지 + admin API + 웹 UI가 표면이다.
- **RBAC로 클래스 이상현상 정리**: ZONEMAKER/CARETAKER/SUB_DM/DM/INVINCIBLE의 뒤엉킨 계급을 역할 기반(예: `builder`·`moderator`·`admin`)으로 재설계한다. 1993 계급 값 배치의 부작용(INVINCIBLE 0개, CARETAKER 3종, ZONEMAKER 편집 불가)을 그대로 재현할 이유는 없다. 다만 **빌더/운영 권한 분리**(월드 편집 ≠ 플레이어 god 조작) 자체는 유지 가치가 있다.
- **감사 로그는 이식 요구사항**: 모든 admin action은 audit trail(`log_dmcmd` 대응)을 남긴다. 신규 스택에서는 구조화 로그/DB 테이블로.
- **`*set`의 DM 강등 안전장치 계승**: 게임 안 도구로 최고 권한을 만들 수 없게 한 설계(권한 상승 방지)는 유지한다 — admin UI에서 역할 승격은 별도 경로·이중 확인으로.

### 7.3 빌더 UI 필드 명세의 출처

빌더 UI를 설계할 때 편집 필드 집합은 (a) 필드 의미론 = A4/A8/A9 노트, (b) 편집 UX·그룹핑 = `util/ed`의 `edit_object`/`edit_monster`/`edit_room` 화면 구성이 선례다. 인게임 `*set` 계열이 노출하던 필드는 부분집합이므로, `util/ed`가 더 완전한 필드 명세를 제공한다. 두 출처를 결합하면 별도 요구사항 수집 없이 빌더 스펙을 도출할 수 있다.

---

## 부록: 앵커 요약

- **명령 테이블**: `global.c:452~556` (`cmdlist[]`, `*` 명령 cmdno 101~148).
- **권한 게이트**: outer `command1.c:608`, inner 각 `dm_*` 첫 줄, 클래스 상수 `mtype.h:93~105`.
- **감사 로그**: `command1.c:630` 호출, `files*.c:575` 정의.
- **게이트 분포**: DM 전용 22종 + SUB_DM+ 20종 + ZONE특례 3종(`*순간이동`·`*status`·`*방번호`) + 무게이트 3종(`*사용자저장`·`*떨어져라`·`*침공`) = 48종, + 범용 `*notepad` 1종 = 49종.
- **구현 분포**: `dm1.c`(생성·god·디스크 18종), `dm2.c`(stat·add_rom·spy), `dm3.c`(set·출구·log/lock/finger/list/info), `dm4.c`(param/silence/broad/cast/group/oname/cname), `dm5.c`(텍스트편집 DM전용·이벤트 무게이트), `dm6.c`(dust/follow/attack/enemy/charm), `update.c`(list_act).
- **오프라인 에디터**: `util/ed/editor.c`(메뉴·room), `editor2.c`(player), `editor3.c`/`editor4.c`(직렬화 사본).
