# A10 소셜·세계 시스템

> 무한의 플레이어가 서로 어떻게 연결되는지 — 어떤 채널로 말하고(전역/공간/개인/그룹/배우자/패거리), 편지와 게시판으로 무엇을 남기며, 패거리(길드)와 결혼으로 어떤 사회 구조를 만드는지, 그리고 이 모든 것에 걸린 가시성·권한 규칙을 규명한다. 채널의 대상 필터·비용(HP·레벨·일일한도)·패거리 가입/탈퇴 경제·결혼 나이·성별 게이트·게시판 삭제 권한은 게임 규칙이므로 충실히 이식하고, `broadcast_*` 6종 fd 순회·`system()`으로 파일 이동·`daily[]` 필드 재용도·`key[2]` 배우자 저장·평면 텍스트 파일 I/O·outbound `finger(1)` 실행은 형상이므로 자유롭게 재설계한다. 이슈 #10. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)의 `io.c`·`command4.c`·`command6.c`·`command9.c`·`command11.c`·`command12.c`·`board.c`·`post.c`·`finger.c`·`global.c`·`player.c`·`dm3.c`. 코드 이식이 아니라 동작 추출.
>
> **oracle 읽기 주의**: 하네스 `grep` 래퍼가 `-I`(binary skip)로 EUC-KR 파일을 스킵한다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`으로 우회한다([[muhan-oracle-toolchain]]).
>
> **as-shipped 기준은 컴파일 플래그다**: `src/Makefile` CFLAGS = `-m32 -g -O2 -fcommon -DFINGERACCT -DCHECKDOUBLE -DSUICIDE -DOBJLEVEL -DDEBUG`. **`-DCHECKFAMILY`는 없다.** 패거리 코드의 상당수가 `#ifdef CHECKFAMILY`로 감싸여 있어 as-compiled 동작이 소스 표면과 다르다(§6.5). 이 비대칭을 데드 스캐폴드([[a9-monster-ai]]의 MFLEER/MSAYTLK)와 같은 장르의 **결정 게이트 항목**으로 다룬다 — 추측으로 해소하지 않는다.
>
> **명령 어휘·한글 동사는 a2 소관**: 각 기능의 한글 명령어(잡담·외쳐·얘기 등)는 본 노트가 `global.c` 디스패치 표에서 확인해 기록하되, 전체 명령 카탈로그·별칭·품사 규칙은 [[a2-command-catalog]]에 확정돼 있다. 방 플래그(RPOSTO·RMARRI·RONMAR) 의미와 방 입장 규칙은 [[a4-movement-rooms]], gold 경제 수치는 [[a8-items-economy]] 소관이다.

## 개요

무한의 소셜 계층은 **하나의 방송 원시연산(broadcast primitive)** 위에 쌓인다. `io.c`가 대상 필터가 다른 방송 함수 6종(`broadcast`/`broadcast2`/`broadcast_all`/`broadcast_wiz`/`broadcast_eaves`/`broadcast_rom`)을 제공하고, 모든 채널·이벤트 알림이 이 위를 흐른다. 각 함수는 전체 소켓 테이블(`Ply[0..Tablesize]`)을 순회하며 플래그(PNOBRD·PNOBR2·class 등)로 수신자를 걸러 `print`한다 — 채널은 곧 "누구를 포함/제외하는 fd 순회"다.

**채널은 도달 범위로 5층**이다: ① **전역**(잡담=`broadsend`/환호=`broadsend2`) — 접속자 전원, HP·레벨·일일한도 비용. ② **공간**(외쳐=`yell`) — 현재 방 + 인접 로드된 방으로 전파. ③ **개인**(얘기/이야기=`sendman`) — 지목한 1인, ignore·PSILNC 게이트. ④ **관계**(사랑말=`m_send` 배우자 / 패거리말=`family_talk`) — 결혼·패거리 소속 기반. ⑤ **그룹**(그룹말=`gtalk`) — 파티 단위([[a2-command-catalog]] 참조). 여기에 **비동기 메시지**(우편 `post.c`, 게시판 `board.c`)가 오프라인 소통을 담당한다.

**지속 사회 구조는 둘**이다. **패거리(family)** — 최대 15개 길드, 각각 두목(boss)·가입축하금·전용 게시판·공지·멤버 명부를 가진다. 소속은 플레이어의 `daily[DL_EXPND].max` 필드에 번호로 저장되고, 두목 여부(PFMBOS)·가입(PFAMIL)·신청중(PRDFML) 플래그로 상태가 표현된다. **결혼(marriage)** — 나이(플레이 7일)·이성 게이트를 통과한 두 플레이어가 신청/수락 2단계로 맺어지고, 배우자 이름은 `key[2]`에 `"m"+이름`으로 저장된다. 결혼하면 배우자 전용 대화(사랑말)와 집 초대(초대=`invite`, RONMAR 방)가 열린다.

핵심 분리: **채널 도달 범위·비용 규칙(잡담 HP·레벨20·일일한도)·ignore/PSILNC 게이트·패거리 가입 경제(축하금=boss→member, 탈퇴비 20000×gold)·결혼 나이/이성 규칙·게시판 소프트삭제·삭제 권한(작성자|DM)·finger 가시성(DM 정보 차단)은 콘텐츠**(충실히 이식), **broadcast_* fd 순회·`daily[]`/`key[2]` 필드 재용도·평면 텍스트 파일 I/O·`system("mv …%s")` 셸 호출·마리지 파일 주석처리 잔재·outbound finger(1) execl·CHECKFAMILY degraded 상태는 형상**(재설계).

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **broadcast 원시연산 6종.** `broadcast`(PNOBRD 제외)·`broadcast2`(PNOBR2 제외)·`broadcast_all`(무필터)·`broadcast_wiz`(class≥CARETAKER)·`broadcast_eaves`(PEAVES+class>CARETAKER)·`broadcast_rom`(방 한정). 전 소켓 순회 + 플래그 필터 | 형상(전송) / 콘텐츠(필터 규칙) |
| 2 | **전역 채널 = HP 지불.** 잡담(`broadsend`)·환호(`broadsend2`)는 `dc_table[31]` 스팸 억제(직전 방송 후 경과 초→ 60~2 HP 차감), level≥20, PSILNC 차단, HP≤비용이면 거부. 초인+는 레벨 비례 추가 차감 | 콘텐츠(비용 공식) |
| 3 | **전역 채널 일일한도.** PBRSND 플래그 보유 & 직전 전역 방송 후 10초↑면 `dec_daily(DL_BROAD)`. 한도 max = `25 + ((level+3)/4)/2`(로그인 시 설정) | 콘텐츠(한도) |
| 4 | **공간 채널 = 인접 방 전파.** 외쳐(`yell`)는 현재 방(`broadcast_rom`) + 모든 출구의 로드된 인접 방에 "누군가가 …라고 외쳤습니다" 전파. PHIDDN 해제(자기 노출) | 콘텐츠(전파 규칙) |
| 5 | **개인 채널 이중 차단.** 얘기/이야기(`sendman`): 수신자 PIGNOR(전면 거부) + `first_ignore` 개인 리스트(듣기거부=`ignore`) + 발신 PSILNC + PINVIS/PDMINV 가시성. DM 도청(`broadcast_eaves`), 둘 다 CARETAKER+면 도청 제외 | 콘텐츠(권한) |
| 6 | **우편 = 대상 파일 append.** 우체국 방(RPOSTO)에서 편지보내기(`postsend`)→`postedit`가 **입력 줄마다 대상 파일에 즉시 append**(소스 주석 "major flaw"). 받기=파일 통째 뷰, 삭제=`unlink`. 읽음판정 atime>ctime | 콘텐츠(기능) / 형상(파일 I/O) |
| 7 | **게시판 = 방-오브젝트 + 인덱스 파일.** 게시판 오브젝트 `type`→`board_dir[]`(정보 100 / 패거리1~15 101~115 / 유저 120). 256B 고정 `BOARD_INDEX` 레코드 + `board.N` 텍스트. **소프트삭제=readnum 부호반전**(음수=삭제, DM만 열람), 삭제권=작성자\|DM | 콘텐츠(규칙) / 형상(파일 포맷) |
| 8 | **게시판 쓰기가 셸 호출.** 등록 확정 시 `sprintf(name,"mv -f %s/%s …") ; system(name)`에 **플레이어 이름 보간** + `creat(dir/name)`. 셸 인젝션·경로 조작 벡터 | 형상(보안 재설계 필수) |
| 9 | **패거리 소속 = 필드 재용도.** 소속 번호는 `daily[DL_EXPND].max`, 초대 그룹은 `daily[DL_MARRI].max`에 저장. 플래그 PFAMIL(가입)·PRDFML(신청중)·PFMBOS(두목). 명부는 `family_member_<n>` 텍스트 | 형상(데이터 모델) |
| 10 | **패거리 경제 = 축하금 + 탈퇴비.** 가입 승인(`boss_family`) 시 **두목이 `gold×10000` 축하금을 신입에게 지급**(boss→member 이체). 자진탈퇴(`exit_family`)는 `gold×20000` 소각. 추방(`fm_out`)은 무료 | 콘텐츠(경제) |
| 11 | **패거리 CHECKFAMILY degraded.** `load_family()`(로스터 로딩)·PFMBOS 자동판정이 `#ifdef CHECKFAMILY` 안. as-compiled에서 **로스터 배열이 비어 두목 인식·가입 목록이 order-dependent**. `list_family`만 무조건 로딩 | 형상(as-compiled 비대칭) / 결정 게이트 |
| 12 | **결혼 게이트 = 나이·이성.** RMARRI 방, `(18 + LT_HOURS.interval/86400) ≥ 25`(플레이 7일↑) 양측, PMALES 이성만. 신청(PRDMAR)/수락 2단계, 배우자=`key[2]`에 `"m"+이름` | 콘텐츠(규칙) |
| 13 | **마리지 파일은 잔재.** `player/marriage/<name>` 파일 쓰기 코드가 **전부 주석처리**됨 → 실제 상태는 in-memory `key[2]`. `marriage/` 디렉터리 vestigial | 형상(데드 잔재) |
| 14 | **배우자 채널·집 초대.** 사랑말(`m_send`)=배우자 1:1(color 34), 이혼(`divorce`)=2단계 PRDDIV, 초대(`invite`)=RONMAR(부부 집)에 손님 명부(`invite_<n>`) 등록 | 콘텐츠(기능) |
| 15 | **finger 2종 분리.** 인게임 `사용자정보`(`pfinger`)=종족·클래스·마지막접속·편지 유무, DM 정보 차단. `finger.c`=독립 outbound `finger(1)` 클라이언트, `dm3.c`가 `vfork`+`execl`로 플레이어 접속 IP에 finger. 서로 무관 | 콘텐츠(pfinger) / 형상(finger.c) |
| 16 | **가시성 축이 곳곳에 산재.** PDMINV(DM투명)·PINVIS(투명)·PDINVI(투명감지)·PBLIND(실명)·PSILNC(침묵)·PIGNOR(전면거부)·PNOBRD/PNOBR2(채널거부)·PEAVES(도청)·class 티어(CARETAKER/SUB_DM/DM). §9 통합표 | 콘텐츠(권한 규칙) |

---

## 1. broadcast 원시연산: 채널의 공통 기반 (형상 전송 / 콘텐츠 필터)

모든 채널·이벤트 알림은 `io.c`의 방송 함수 위에 있다. 각 함수는 **전 소켓 테이블을 순회**(`for i in 0..Tablesize`)하며 `FD_ISSET(i,&Sockets) && Ply[i].ply`인 접속자에 대해 플래그로 걸러 `print`한다. 차이는 **수신자 필터**뿐이다:

| 함수 | 위치 | 수신자 필터 | 용도 |
|------|------|-------------|------|
| `broadcast` | io.c:895 | `!PNOBRD` (잡담 거부 아님) | 잡담·입퇴장·전역 이벤트 |
| `broadcast2` | io.c:911 | `!PNOBR2` (환호 거부 아님) | 환호 |
| `broadcast_all` | io.c:926 | 무필터 (전원) | 강제 공지(패거리 가입/탈퇴, 결혼) |
| `broadcast_wiz` | io.c:949 | `class ≥ CARETAKER` (황색) | DM 알림 |
| `broadcast_eaves` | io.c:975 | `class > CARETAKER && PEAVES` | DM 도청(개인 대화 감시) |
| `broadcast_rom`(2) | io.c:1002/1027 | `rom_num == rm` (+ ignore fd) | 방 한정 방송 |

**필터 규칙은 콘텐츠**(누가 무엇을 안 받는지 = 게임 정책), **순회·`print` 가변인자·`fmt2[1024]` 복사는 형상**이다. 신규 스택에서는 방송을 **EventEmitter 채널 + 구독자 필터**로 재설계한다 — 채널별(global/room/family/marriage/wiz) 토픽에 소켓을 구독시키고, 수신자 플래그(PNOBRD 등)는 구독 필터 술어로 옮긴다. `broadcast_rom`은 방 엔티티에 붙은 room-scoped 이벤트가 된다([[a9-monster-ai]]도 몬스터 행동 방송에 이를 씀).

`%C…%D`, `%M`, `%j` 등 포맷 토큰은 색상(ANSI)·이름·조사 처리로, [[a3-hangul-io]]의 `print` 계층 소관이다.

## 2. 전역·공간 채널 (콘텐츠: 비용·전파 규칙)

### 2.1 잡담·환호: HP를 지불하는 전역 채널 (broadsend/broadsend2, command4.c:493·556)

전역 채널 둘은 코드가 거의 동일하고 **바탕 방송 함수와 거부 플래그만** 다르다: 잡담=`broadcast`(PNOBRD), 환호=`broadcast2`(PNOBR2). 발동 순서:

1. **일일한도** (command4.c:504): `t = now − all_broad_time`. `t>10 && PBRSND && class<SUB_DM`이면 `dec_daily(&daily[DL_BROAD])` — 한도 소진 시 "오늘 잡담의 한계를 넘겼습니다". `all_broad_time`은 **전역 최근 방송 타임스탬프**로, 로그인(player.c:89)·각종 전역 방송 시 `time(0)`으로 갱신된다. 즉 일일한도는 PBRSND 보유자에게, 직전 전역 방송으로부터 10초 이상 지났을 때만 차감된다.
2. **PSILNC**: 침묵 상태면 거부(class<SUB_DM 한정).
3. **레벨 게이트**: `level < 20 && class < CARETAKER`이면 거부 — **20레벨 미만은 전역 채널 불가**.
4. **HP 비용** (command4.c:516, `dc_table[31]`): `t = now − broad_time[fd]`(내 직전 방송 후 경과). `t<0 || t>30 → discount=2`, 아니면 `dc_table[t]`(0초=60 → 29초=2). **직전 방송 직후일수록 비쌈**(스팸 억제). 초인+(`INVINCIBLE ≤ class < SUB_DM`)는 `discount += discount×level/60`. `hpcur ≤ discount`면 "목숨이 위태로워" 거부. 통과 시 `hpcur -= discount`.
5. `broad_time[fd] = now`, `broadcast("\n%C%s> %s%D", "32", name, msg, "37")`(초록).

**비용 공식·레벨20·일일한도·PSILNC는 콘텐츠**(밸런스), `dc_table`·`broad_time[PMAX]` 배열·전역 `all_broad_time`은 형상. 신규 스택은 "채널 발화에 HP 비용 + 스팸 억제 쿨다운 곡선 + 레벨·일일 게이트"를 그대로 이식하되, 타임스탬프 배열은 플레이어 상태에 붙인다.

### 2.2 외쳐: 인접 방 전파 공간 채널 (yell, command6.c:21)

외쳐는 **공간적으로 국소**인 채널이다:
1. PSILNC면 거부, `PHIDDN` 해제(외치면 숨은 상태가 풀림 — 자기 노출 비용).
2. 현재 방에 `broadcast_rom(fd, rom_num, "%M이 \"%s!\"라고 외칩니다", …)`.
3. **현재 방의 모든 출구**(`first_ext`)를 순회, `is_rom_loaded(xp->ext->room)`인 인접 방에 익명 "누군가가 \"%s!\"라고 외쳤습니다" 전파.

즉 외침은 한 홉 반경으로 퍼지며, 인접 방에서는 발화자가 익명이다. **전파 규칙(현재 방 실명 + 인접 로드된 방 익명 1홉)은 콘텐츠**, 출구 리스트 순회·`is_rom_loaded` 검사는 형상. 신규 스택은 방 그래프의 인접 노드로 이벤트를 1홉 팬아웃한다.

## 3. 개인 채널과 ignore (콘텐츠: 권한)

### 3.1 얘기/이야기: 개인 대화 (sendman, command4.c:393)

지목한 1인에게 보내는 tell. 대상 탐색은 **접두 매칭**(부분 이름 허용, 완전 일치 우선). 차단 계층:
- **가시성**: 대상 PDMINV(비-DM에게), PINVIS(PDINVI 없으면) → "누구에게 말을…"(대상 은닉).
- **PIGNOR**(전면 거부): 대상이 전면 거부 상태면 "%s님은 이야기 듣기 거부 상태입니다"(비-DM 발신 한정).
- **개인 ignore 리스트**: 대상의 `first_ignore`(§3.2)에 발신자 이름이 있으면 "%s is ignoring you".
- **발신 PSILNC**: "당신은 말을 할 수 없습니다".
- **PLECHO**: 에코 플래그면 발신자에게도 자기 말 표시.
- 수신자에 `%C…31…%D`(적색) 표시, `talksend`에 발신자 이름 저장(대답=`resend`의 회신 대상, [[a2-command-catalog]]).
- **DM 도청**: 양측 모두 class ≤ CARETAKER면 `broadcast_eaves`로 DM에게 대화 노출(class>CARETAKER 참여 시 제외).

### 3.2 듣기거부: 개인 ignore 리스트 (ignore, command9.c:566)

`Ply[fd].extr->first_ignore`(`etag` 리스트)로 **플레이어별 개인 무시 목록**을 관리한다:
- 인자 없음: 현재 거부 목록 나열.
- 이름 인자: **토글** — 목록에 있으면 제거, 없으면(대상이 접속중일 때만) 추가.

**PIGNOR**(전면 거부, 모든 tell 차단)와 **first_ignore**(특정인만 차단)는 **다른 축**이다 — 전자는 플래그 하나, 후자는 이름 리스트. 둘 다 콘텐츠(권한 규칙). `etag` malloc 리스트는 형상 — 신규 스택은 플레이어 문서의 `ignoreList: string[]`로 이식한다.

## 4. 우편: 비동기 개인 메시지 (post.c)

우체국 방(`RPOSTO`, [[a4-movement-rooms]])에서만 동작한다. `POSTPATH/<수신자이름>` 단일 파일에 편지가 누적된다.

- **편지보내기** (`postsend`, post.c:28): 대상 존재를 플레이어 파일 `open`으로 확인 → `postedit` 진입. **`postedit`가 입력 줄을 받을 때마다 대상 파일에 즉시 append**(첫 줄에 "%s님에게서의 편지:" 헤더 + `ctime` 날짜). 소스 주석이 명시한 결함: **두 사람이 동시에 같은 대상에게 쓰면 줄이 뒤섞인다**(줄 단위 즉시 기록이라 원자성 없음). `.`으로 종료.
- **편지받기** (`postread`, post.c:131): 자기 파일(`POSTPATH/<내이름>`)을 `view_file`로 통째 표시. 없으면 "받은 편지가 없습니다".
- **편지삭제** (`postdelete`, post.c:171): 자기 파일 `unlink` — **개별 편지가 아니라 우편함 전체 삭제**.
- **DM 메모장** (`notepad`, post.c:198): CARETAKER+ 전용. `POSTPATH/DM_pad`에 append(`a` 옵션)/삭제(`d`)/열람. 관리자 공용 메모.
- **패거리 공지** (`family_news`, post.c:287): PFAMIL 필요. `PLAYERPATH/family/family_news_<번호>`에 두목(PFMBOS)만 append/삭제, 멤버는 열람. `#ifdef CHECKFAMILY` 하에 두목 재판정(§6.5).

**우편의 기능 의미(우체국 방 한정, 대상별 우편함, 헤더+날짜, DM 메모, 패거리 공지)는 콘텐츠**, **평면 파일 append·wholesale 삭제·atime>ctime 읽음판정·비원자적 동시쓰기 결함은 형상**. 신규 스택은 **메시지 단위 문서**(sender·recipient·body·sentAt·readAt)로 승격해 동시성 결함을 제거하고, "우체국 방에서만 열람" 제약은 유지한다. pfinger의 편지 도착 알림(§8.1)도 readAt 필드로 매핑된다.

## 5. 게시판: 방-오브젝트 부착 게시판 (board.c)

게시판은 **방에 놓인 오브젝트**(`find_obj "게시판"`, `special == SP_BOARD`)이며, 오브젝트의 `type` 필드가 어느 게시판인지 결정한다. `board_dir[]` 매핑(board.c:33):

| type | 디렉터리 | 용도 |
|------|----------|------|
| 100 | `board/info` | 공지 게시판 |
| 101~115 | `board/family1`~`family15` | **패거리별 전용 게시판**(§6과 연동) |
| 116 | `board/family` | 패거리 공용 |
| 120 | `board/user` | 유저 자유 게시판 |

각 디렉터리는 **256바이트 고정 `BOARD_INDEX` 레코드 배열**(`board_index`) + 게시물별 `board.N` 텍스트 파일로 구성된다. `BOARD_INDEX` = {num, upload(작성자 16B), 날짜(y/m/d/h/m/s), line(줄수), readnum(조회수), title(40B), extra[41]}.

- **게시판**(`look_board`→`list_board`, board.c:66): 인덱스를 뒤(최신)에서 20개씩 페이지네이션. `readnum<0`(삭제됨)은 DM만 표시. `[Enter]` 계속 / `[.]` 중단.
- **써**(`writeboard`→`write_board`, board.c:176): 제목 입력 → 본문 줄 입력(`.`=등록, `!!`=취소). 등록 시 임시 파일을 `board.N`으로 이동, 인덱스 레코드 추가.
- **게시판 읽기**(`read_board`, board.c:323): 번호로 `board.N` 표시. **조회수 증가**(단, 작성자 본인은 카운트 안 함).
- **글삭제**(`del_board`, board.c:390): **소프트삭제 = `readnum` 부호 반전**(음수=삭제 상태, 재실행 시 복구). 권한: **작성자 본인 또는 class≥DM**.

**게시판 기능(방 부착, 패거리별 분리, 페이지네이션, 소프트삭제, 조회수, 작성자/DM 삭제권)은 콘텐츠**, **256B 레코드 포맷·`lseek` 오프셋·부호반전 삭제·별도 텍스트 파일은 형상**. 신규 스택은 board 컬렉션(boardId·author·title·body·postedAt·views·deleted) + 방 오브젝트에 boardId 참조로 이식한다.

**보안 형상(§8 아키텍처 함의로 승격)**: `write_board` case 2가 등록 확정 시 `sprintf(name, "mv -f %s/%s %s/board.%ld", dir, ply->name, …); system(name)` — **플레이어 이름을 셸 명령에 보간**한다. 또한 `creat("%s/%s", dir, ply->name)`로 이름을 경로에 직접 사용한다. 플레이어 이름은 한글이라 즉각적 인젝션 표면은 좁으나, **이식 시 절대 재현 금지** — 서버측 파일 I/O(또는 DB write)로 대체한다([[muhan-oracle-toolchain]] 및 프로젝트 `security.md` shell injection 방어).

## 6. 패거리(family): 길드 시스템 (콘텐츠 규칙 / 형상 데이터·CHECKFAMILY)

### 6.1 데이터 모델 (형상)

- **로스터**: `PLAYERPATH/family/family_list` — 줄당 `번호 이름 두목 가입금`(가입금은 ×10000이 실제 냥). `load_family()`(command11.c:474)가 `family_num[]`/`family_str[]`/`fmboss_str[]`/`family_gold[]` 전역 배열에 로드, `번호==16`(MAXFAMILY 센티넬)에서 종료. 실제 데이터에 "사악파 타이 100"(두목 타이, 가입금 100만냥) 등이 채워져 있어 **의도는 동작하는 패거리**다.
- **소속 저장**: 플레이어의 **`daily[DL_EXPND].max` 필드에 패거리 번호**를 재용도로 저장. 초대 그룹은 `daily[DL_MARRI].max`.
- **상태 플래그**: `PFAMIL`(가입 완료)·`PRDFML`(가입 신청중)·`PFMBOS`(두목).
- **멤버 명부**: `family/family_member_<번호>` — 줄당 `class 이름`, `edit_member()`(command12.c:237)가 param 1(가입 추가)/2(탈퇴·추방 제거)/3(수정)으로 재작성.

### 6.2 가입 흐름 (콘텐츠 경제)

1. **패거리가입**(`family`→`add_family`, command11.c:494): 이미 PFAMIL/PRDFML이면 거부. 패거리 목록 표시 → 이름 선택 → **두목이 접속중이어야 함**(`find_who(fmboss_str[])`). `daily[DL_EXPND].max=번호` 세팅, "예" 확인 시 `PRDFML` 세팅 + 두목에게 신청 알림.
2. **가입허가**(`boss_family`, command11.c:585): **PFMBOS 두목만**. 신청자가 PRDFML·같은 패거리 번호·미가입이어야 함. **두목 gold ≥ `family_gold×10000`** 확인 → `PRDFML` 해제·`PFAMIL` 세팅·`edit_member(…,1)` → **두목이 신입에게 `gold×10000` 축하금 이체**(`crt→gold +=`, `boss→gold −=`) → `broadcast_all` 가입 공지.

**경제 규칙**: 가입은 두목이 신입에게 **축하금을 지급**한다(recruitment subsidy, gold 순환). 이는 두목 자금이 gate이자 비용이다.

### 6.3 탈퇴·추방 (콘텐츠 경제)

- **패거리탈퇴**(`out_family`→`exit_family`, command11.c:650): **두목은 탈퇴 불가**. PRDFML(신청중)이면 신청 취소. 가입 상태면 **`family_gold×20000` 소각**(자진탈퇴비 — 축하금의 2배, gold sink) → `edit_member(…,2)`·PFAMIL 해제·번호 0. `broadcast_all` 공지.
- **패거리추방**(`fm_out`, command12.c:151): **PFMBOS 두목만**. 같은 패거리원을 강퇴 — PFAMIL 해제·번호 0·`edit_member(…,2)`. **추방은 무료**(자진탈퇴비와 대비). 온라인(`find_who`)·오프라인(`load_ply`+`save_ply`) 대상 모두 처리, 자기 추방 불가.

### 6.4 패거리 채널·조회 (콘텐츠)

- **패거리말**(`family_talk` / `]`, command11.c:729): PFAMIL·非PSILNC. 전 소켓 순회 → **같은 `daily[DL_EXPND].max`인 PFAMIL 멤버**에게 `%C33…`(황색) 전송. `broadcast_eaves`로 DM 도청.
- **패거리누구**(`family_who`, command11.c:773): 접속중 같은 패거리원 나열(신청중은 `(-)` 표시), 또는 특정인의 소속 조회(가시성 게이트).
- **패거리원**(`family_member`, command12.c:301): 명부 파일에서 전 멤버(class+이름) 나열.
- **모든패거리**(`list_family`, command11.c:847): 전 패거리·두목 목록. **`load_family()`를 무조건 호출**(ifdef 밖).
- **경험치전수**(`trans_exp`, command11.c:875): CARETAKER+·패거리원 한정 경험치 이체. 소스 주석 "루틴만 있고 사용은 하지 않는데" — 명령 표에 미등록에 가까운 **반-데드**(1~100000 범위).

### 6.5 CHECKFAMILY: as-compiled degraded 상태 (형상 / 결정 게이트)

**결정적 as-shipped 사실**: CFLAGS에 `-DCHECKFAMILY`가 **없다**(서두 참조). `#ifdef CHECKFAMILY` footprint = `command11.c`(family/add_family/boss_family/exit_family/family_talk/family_who/fm_out), `command12.c`, `post.c`(family_news), `player.c:70`(로그인 훅). 이 블록들은 **컴파일 제외**된다.

무엇이 빠지나: 대부분의 블록이 감싸는 것은 **`load_family()` 호출 + 두목 자동판정**(`if(name==fmboss_str[num]) F_SET(PFMBOS)`)이다. CHECKFAMILY-off이면:
- 가입/두목/탈퇴/채널 경로에서 **로스터 배열(`family_str`/`fmboss_str`)이 로드되지 않는다**. `add_family` case 0의 목록·이름 매칭이 빈 배열(BSS)을 참조 → 가입 목록이 비고 매칭 실패.
- **`boss_family`(가입허가)는 PFMBOS를 요구**하는데, 그 플래그를 세팅하는 자동판정이 전부 ifdef 안 → **두목이 인식되지 않아 가입 승인 경로가 사실상 막힌다**.
- **단, `list_family`(모든패거리)는 무조건 `load_family()` 호출**하고, `family_str`/`fmboss_str`은 **프로세스 전역**이라 누군가 `모든패거리`를 한 번 실행하면 세션 내내 배열이 채워진 상태로 유지된다.

따라서 as-compiled 동작은 **"패거리 비활성"이 아니라 "로스터 로딩·두목 판정이 order-dependent한 degraded 상태"**다. 로그인 훅(player.c:70)도 `load_family()`만 ifdef 안이고 PFMBOS 판정 자체는 ifdef **밖**이라, 로스터가 안 채워진 상태로 로그인하면 두목이 빈 문자열과 비교돼 항상 PFMBOS가 꺼진다.

**PFMBOS를 애초에 누가 어떻게 얻는지는 오라클상 불명(open ambiguity)**. 처리 방침은 [[a9-monster-ai]]의 MFLEER/MSAYTLK 데드 스캐폴드와 동일하게 **결정 게이트 항목**으로 남긴다: (a) as-compiled(degraded) 재현 = 대부분 무력화, 또는 (b) **as-intended(CHECKFAMILY-on)** 재현 = `family_list` 데이터가 채워져 있으니 정상 패거리로 이식. 포팅 원칙([[muhan-port-principle]])상 "동작은 충실히 재현"이 기준이나, 여기서는 **as-intended가 데이터 의도와 부합**하므로 정본 채택이 유력 — 명시 결정으로 확정한다. 추측으로 해소하지 않는다.

## 7. 결혼(marriage): 부부 관계 시스템 (콘텐츠 규칙 / 형상 저장)

### 7.1 결혼 게이트·2단계 성사 (marriage, command11.c:1112)

결혼식장 방(`RMARRI`, [[a4-movement-rooms]])에서만:
1. **나이**: `(18 + LT_HOURS.interval/86400) < 25`이면 "결혼할 나이가 아닙니다". 즉 나이 = **18 + 누적 플레이 일수**(LT_HOURS=총 접속 초). ≥25 → **플레이 7일 이상** 필요. **양측 모두** 검사.
2. **성별**: `PMALES` 플래그. 남남(둘 다 PMALES)·여여(둘 다 非PMALES) 거부 — **이성만**.
3. 대상 미혼(非PMARRI)·가시성(PDMINV/PINVIS/PBLIND) 검사.
4. **신청/수락 2단계**: 대상이 아직 PRDMAR가 아니면 → 신청자 `PRDMAR` 세팅 + `key[2] = "m"+대상이름` + 대상에게 알림. 대상이 이미 (나를 향해) PRDMAR면 → **`key[2][1:]`가 나를 가리키는지 확인** → 양측 `PMARRI` 세팅, `broadcast_all` 결혼 공지.

### 7.2 배우자 저장은 key[2] (형상)

배우자 정보는 **파일이 아니라 creature `key[2]` 필드에 `"m"+배우자이름`**으로 저장된다. 원래 `player/marriage/<name>` 파일에 쓰던 코드(command11.c:1182·1195·1211 등)가 **전부 주석처리**되어 있다 → `player/marriage/` 디렉터리는 **vestigial**(list 파일만 남은 껍데기). 신규 스택은 플레이어 문서의 `spouse: string` 필드로 이식한다.

### 7.3 배우자 채널·이혼·초대 (콘텐츠)

- **사랑말**(`m_send`, command11.c:1235): PMARRI 필요, `key[2]`로 배우자 탐색(접속중이어야 함), `%C34…`(청색) 1:1 전송. PLECHO 에코.
- **이혼**(`divorce`, command11.c:1279): 결혼과 대칭인 2단계(`PRDDIV`). 배우자가 존재하지 않으면(`load_ply` 실패) PMARRI 자동 해제·`key[2]` 클리어. 상호 수락 시 양측 PMARRI/PRDMAR/PRDDIV 해제, `broadcast`(PNOBRD 존중) 공지.
- **초대**(`invite`, command12.c:301+): `daily[DL_MARRI].max`(초대 그룹 번호)·`RONMAR`(부부 집) 방 필요. `invite/invite_<번호>` 파일에 손님 이름(한글만) 등록/조회/삭제. 부부가 자기 집에 손님을 들이는 접근 제어 명부.

**결혼 규칙(나이=플레이7일·이성·2단계 신청수락·이혼 대칭·집 초대)은 콘텐츠**, **`key[2]` 저장·마리지 파일 주석 잔재·`daily` 필드 재용도는 형상**.

## 8. finger 2종: 인게임 조회 vs outbound 클라이언트

이슈가 명시한 `finger.c`는 **인게임 플레이어 조회와 무관한 별개 바이너리**다. 둘을 갈라야 한다.

### 8.1 사용자정보 = 인게임 finger (pfinger, command11.c:394) — 콘텐츠

플레이어 정보 조회. 온라인(`find_who`)·오프라인(`load_ply`) 대상 모두 처리:
- 표시: 이름·종족(`race_str`)·클래스(`class_str`)·마지막 접속시각(파일 ctime)·현재 접속 여부·SUICD(자살신청) 여부.
- **편지 알림**: `POSTPATH/<대상>` stat으로 편지 유무 + atime>ctime로 "읽지 않은/새 편지 도착 날짜".
- **가시성 권한**: 비-DM은 DM 정보 조회 불가, PDMINV(DM투명) 대상 차단, SUB_DM/DM 티어별 세분.

이식 대상 — 플레이어 프로필 조회 API(공개 필드만, 권한 티어 존중).

### 8.2 finger.c = outbound 인터넷 finger 클라이언트 (형상, drop 후보)

`finger.c`는 `main()`을 가진 **독립 실행 바이너리**로, 외부 호스트의 **finger 프로토콜(TCP 79)에 접속**해 결과를 플레이어 fd로 중계한다. `dm3.c:788`이 `vfork()` + `execl(BINPATH/finger, "finger", fdstr, addr, name, 0)`로 스폰하며, `addr`은 **접속중 플레이어의 연결 IP**(`Ply[fd].io->address`)다 — 즉 DM이 접속자의 원격 호스트를 finger하는 관리 도구다(소스 주석 "no idea why this is in here"가 보여주듯 애드혹). 컴파일 플래그 `-DFINGERACCT`(계정 finger)와도 별개 축이다.

이것은 **순수 인프라/vestigial**이다 — 1990년대 인터넷 finger 문화의 잔재로, 게임 콘텐츠가 아니다. 신규 스택에서는 **이식하지 않는다**(drop). 관리자 진단이 필요하면 접속 메타데이터(IP·접속시각)를 서버 로그·admin 대시보드로 대체한다.

## 9. 가시성·권한 통합표 (이슈 명시 산출)

소셜 기능 전반에 걸린 가시성·권한 축을 한자리에 모은다. (플래그 정의는 `mtype.h`, class 티어는 [[a7-player-progression]].)

| 축 | 플래그/조건 | 효과 | 적용 채널·기능 |
|----|-------------|------|----------------|
| **채널 거부(수신)** | PNOBRD / PNOBR2 | 잡담 / 환호 미수신 | broadcast / broadcast2 |
| **전면 대화 거부** | PIGNOR | 모든 개인 tell 차단(비-DM) | sendman |
| **개인 무시** | first_ignore 리스트 | 특정인 tell만 차단 | ignore / sendman |
| **침묵(발신)** | PSILNC | 잡담·환호·외침·개인·패거리말 불가 | 전 채널 |
| **투명** | PINVIS (+PDINVI 감지) | 대상 은닉(tell·결혼·finger) | sendman/marriage/pfinger |
| **DM 투명** | PDMINV | 비-DM에게 완전 은닉 | 전역·조회 전반 |
| **실명** | PBLIND | 조회·패거리누구 불가 | family_who/marriage |
| **도청** | PEAVES (class>CARETAKER) | 개인·패거리 대화 감시 | broadcast_eaves |
| **DM 전용 방송** | class ≥ CARETAKER | wiz 채널 수신 | broadcast_wiz |
| **레벨 게이트** | level ≥ 20 | 전역 채널 발화 | broadsend/broadsend2 |
| **일일한도** | PBRSND + DL_BROAD | 잡담 횟수 제한 | broadsend/broadsend2 |
| **게시판 삭제권** | 작성자 \| class≥DM | 글 소프트삭제 | del_board |
| **삭제글 열람** | class ≥ DM | readnum<0 게시물 표시 | list_board/read_board |
| **패거리 두목권** | PFMBOS | 가입허가·추방·공지삭제 | boss_family/fm_out/family_news |
| **finger 정보 차단** | class 티어 + PDMINV | DM 정보 비-DM 차단 | pfinger |

## 콘텐츠(이식) vs 형상(재설계) 분류

| 항목 | 콘텐츠 (충실히 이식) | 형상 (자유롭게 재설계) |
|------|---------------------|----------------------|
| 방송 기반 | 수신자 필터 정책(PNOBRD/PNOBR2/class/PEAVES/방한정) | broadcast_* 6종 전 소켓 순회, fmt2[1024] |
| 전역 채널 | HP 비용 곡선(dc_table), level≥20, 일일한도, 초인 가중 | broad_time[PMAX]·all_broad_time 전역, dc_table 리터럴 |
| 공간 채널 | 외침 1홉 전파(현재 방 실명 + 인접 익명), PHIDDN 해제 | first_ext 순회, is_rom_loaded |
| 개인 채널 | tell + PIGNOR/first_ignore/PSILNC/가시성, DM 도청, 대답 대상 | etag ignore 리스트, talksend, 접두 매칭 |
| 우편 | 우체국 방 한정, 대상별 우편함, 헤더+날짜, DM 메모, 패거리 공지 | 평면 파일 즉시 append(비원자적), wholesale unlink, atime>ctime |
| 게시판 | 방 부착, 패거리별 분리, 페이지네이션, 소프트삭제, 조회수, 작성자/DM 삭제권 | 256B BOARD_INDEX·lseek, board.N 텍스트, **system()·creat() 셸/경로** |
| 패거리 소속 | 길드 소속·두목·명부·전용 게시판/공지 | **daily[DL_EXPND].max 필드 재용도**, family_member 텍스트 |
| 패거리 경제 | 가입 축하금(boss→member gold×10000), 탈퇴비(×20000 소각), 추방 무료 | gold 직접 증감 |
| 패거리 채널 | 같은 소속 대상 전송(황색), 두목 전용 명령 | Tablesize 순회, **CHECKFAMILY degraded(§6.5)** |
| 결혼 | 나이(플레이7일)·이성 게이트, 2단계 신청수락, 이혼 대칭, 집 초대 | **key[2] "m"+이름 저장, 마리지 파일 주석 잔재** |
| 배우자/그룹 채널 | 배우자 1:1(청색), 그룹말([[a2-command-catalog]]) | find_who 재탐색 |
| finger | 인게임 pfinger(프로필·편지·권한 티어) | **outbound finger.c(vfork/execl 79포트) = drop** |
| 가시성·권한 | §9 통합표 전체 | 플래그 비트 인덱스 |

## 아키텍처 함의

1. **채널 = EventEmitter 토픽 + 구독 필터.** broadcast_* 6종을 채널 토픽(global-chat/global-cheer/room/family/marriage/wiz/eaves)으로 재설계하고, 수신자 플래그(PNOBRD·PNOBR2·PEAVES·class)를 **구독 술어**로 옮긴다. `broadcast_rom`은 방 엔티티의 room-scoped 이벤트, 패거리말은 패거리 채널 구독으로 자연스럽게 매핑된다. 전 소켓 O(n) 순회는 토픽별 구독자 집합으로 대체한다.

2. **채널 비용·게이트는 밸런스이므로 수치까지 이식.** 잡담 HP 곡선(`dc_table` 0초=60 → 29초=2), 초인 레벨 가중(`discount×level/60`), 레벨20 게이트, 일일한도(`25+((level+3)/4)/2`), 외침 1홉 전파는 소셜 스팸 억제·경제의 일부다. `broad_time`/`all_broad_time` 전역 타임스탬프는 플레이어·서버 상태로 옮기되 곡선은 보존한다.

3. **보안 형상은 그대로 이식 금지.** `board.c`의 `system("mv -f …%s…")` + `creat(dir/name)`은 **플레이어 이름을 셸·경로에 보간**하는 인젝션/경로 조작 벡터다(프로젝트 `security.md` shell injection 방어 직결). 우편·게시판·명부의 모든 파일 I/O를 서버측 안전 I/O 또는 DB write로 대체하고, 사용자 입력(이름·제목·본문)은 경로·명령에 절대 직접 사용하지 않는다.

4. **필드 재용도를 명시 스키마로 정규화.** 패거리 번호(`daily[DL_EXPND].max`)·초대 그룹(`daily[DL_MARRI].max`)·배우자(`key[2]`)는 원본이 여유 필드를 재활용한 것이다. MongoDB 스키마에서는 `family: {id, role}`, `spouse: string`, `houseGuests: string[]`, `ignoreList: string[]` 같은 **1급 필드**로 승격한다 — 재용도의 의미(어느 daily 슬롯이 무엇을 뜻하는지)를 코드에 숨기지 않는다.

5. **비동기 메시지는 문서 단위로.** 우편의 "대상 파일에 줄 단위 즉시 append"는 동시 발신 시 뒤섞이는 결함(소스 주석 인정)이다. **메시지 단위 문서**(sender·recipient·body·sentAt·readAt)로 이식해 원자성을 확보하고, 읽음 상태(atime>ctime)를 `readAt`로 정규화한다. 게시판도 board 문서(views·deleted 플래그·author)로, 소프트삭제(readnum 부호반전)는 `deleted: bool`로 옮긴다. "우체국 방·게시판 오브젝트가 있어야 접근" 제약은 유지한다.

6. **패거리 CHECKFAMILY는 결정 게이트.** as-compiled는 로스터 로딩·두목 판정이 order-dependent한 degraded 상태(§6.5)이나 `family_list` 데이터는 정상 패거리를 담고 있다. **as-intended(정상 패거리) 이식을 정본으로 채택**하되, PFMBOS 획득 경로가 오라클상 불명(open ambiguity)이므로 두목 임명 규칙(최초 생성자? DM 지정?)을 신규 설계로 확정한다 — [[a9-monster-ai]]의 데드 스캐폴드와 동일한 "재현 vs 되살림" 결정 게이트다.

7. **finger.c는 이식 대상 아님.** outbound 인터넷 finger(1) 클라이언트는 게임 콘텐츠가 아닌 1990년대 인프라 잔재다(drop). 인게임 pfinger(프로필·편지 알림·권한 티어)만 플레이어 조회 API로 이식한다. 관리 진단(접속 IP·시각)은 서버 로그·admin 도구로 대체한다.
