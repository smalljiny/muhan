# A10 소셜·세계 시스템

> 무한의 플레이어들이 서로 어떻게 연결되는지 정리한다. 다루는 내용은 다음과 같다.
>
> - 어떤 채널로 말하는가(전역/공간/개인/그룹/배우자/패거리)
> - 편지와 게시판으로 무엇을 남기는가
> - 패거리(길드)와 결혼으로 어떤 사회 구조를 만드는가
> - 이 모든 기능에 걸린 가시성과 권한 규칙
>
> 다음은 게임 규칙이므로 충실히 이식한다: 채널의 대상 필터와 비용(HP, 레벨, 일일한도), 패거리 가입/탈퇴 경제, 결혼의 나이와 성별 게이트, 게시판 삭제 권한. 다음은 원작의 구현 방식이므로 자유롭게 재설계한다: `broadcast_*` 6종의 fd 순회, `system()`을 이용한 파일 이동, `daily[]` 필드를 다른 용도로 재사용하는 방식, `key[2]`에 배우자를 저장하는 방식, 평면 텍스트 파일 I/O, outbound `finger(1)` 실행.
>
> 이슈 #10. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)의 `io.c`, `command4.c`, `command6.c`, `command9.c`, `command11.c`, `command12.c`, `board.c`, `post.c`, `finger.c`, `global.c`, `player.c`, `dm3.c`다. 코드를 이식하지 않고 동작만 추출한다.
>
> **오라클 읽기 주의**: 하네스의 `grep` 래퍼는 `-I`(binary skip)를 붙이므로 EUC-KR 파일을 건너뛴다. `command grep -a`를 쓰거나 `iconv -f EUC-KR -t UTF-8 -c … | grep`으로 우회한다([[muhan-oracle-toolchain]]).
>
> **as-shipped의 기준은 컴파일 플래그다**: `src/Makefile` CFLAGS = `-m32 -g -O2 -fcommon -DFINGERACCT -DCHECKDOUBLE -DSUICIDE -DOBJLEVEL -DDEBUG`. **`-DCHECKFAMILY`는 없다.** 패거리 코드의 상당 부분이 `#ifdef CHECKFAMILY`로 감싸여 있어서, 컴파일된 동작이 소스에 보이는 동작과 다르다(§6.5). 이 비대칭은 데드 스캐폴드([[a9-monster-ai]]의 MFLEER/MSAYTLK)와 같은 종류의 결정 게이트 항목으로 다룬다. 추측으로 결론 내리지 않는다.
>
> **명령 어휘와 한글 동사는 a2 담당**: 각 기능의 한글 명령어(잡담, 외쳐, 얘기 등)는 이 노트에서 `global.c` 디스패치 표로 확인해 기록한다. 하지만 전체 명령 카탈로그, 별칭, 품사 규칙은 [[a2-command-catalog]]에서 확정했다. 방 플래그(RPOSTO·RMARRI·RONMAR)의 의미와 방 입장 규칙은 [[a4-movement-rooms]], gold 경제 수치는 [[a8-items-economy]]가 담당한다.

## 개요

무한의 소셜 계층은 **방송 원시연산(broadcast primitive) 하나**를 기반으로 만들어져 있다. `io.c`는 대상 필터가 서로 다른 방송 함수 6종(`broadcast`/`broadcast2`/`broadcast_all`/`broadcast_wiz`/`broadcast_eaves`/`broadcast_rom`)을 제공하고, 모든 채널과 이벤트 알림이 이 함수들을 거친다. 각 함수는 전체 소켓 테이블(`Ply[0..Tablesize]`)을 순회하면서 플래그(PNOBRD, PNOBR2, class 등)로 수신자를 걸러 `print`한다. 즉 채널은 "누구를 포함하고 누구를 뺄지 정해서 fd를 순회하는 것"이다.

**채널은 도달 범위에 따라 다섯 층**으로 나뉜다.

1. **전역**(잡담=`broadsend`, 환호=`broadsend2`): 접속자 전원에게 간다. HP, 레벨, 일일한도의 비용이 든다.
2. **공간**(외쳐=`yell`): 현재 방과, 로드된 인접 방으로 퍼진다.
3. **개인**(얘기/이야기=`sendman`): 지목한 1인에게 간다. ignore와 PSILNC로 막힐 수 있다.
4. **관계**(사랑말=`m_send`는 배우자, 패거리말=`family_talk`는 패거리): 결혼과 패거리 소속에 따라 정해진다.
5. **그룹**(그룹말=`gtalk`): 파티 단위다([[a2-command-catalog]] 참조).

여기에 더해 **비동기 메시지**(우편 `post.c`, 게시판 `board.c`)가 오프라인 소통을 맡는다.

**계속 유지되는 사회 구조는 두 가지**다.

- **패거리(family)**: 최대 15개의 길드다. 패거리마다 두목(boss), 가입축하금, 전용 게시판, 공지, 멤버 명부가 있다. 소속은 플레이어의 `daily[DL_EXPND].max` 필드에 번호로 저장한다. 상태는 플래그로 나타낸다: 두목 여부(PFMBOS), 가입(PFAMIL), 신청 중(PRDFML).
- **결혼(marriage)**: 나이(플레이 7일)와 이성 게이트를 통과한 두 플레이어가 신청과 수락의 2단계를 거쳐 맺어진다. 배우자 이름은 `key[2]`에 `"m"+이름`으로 저장한다. 결혼하면 배우자 전용 대화(사랑말)와 집 초대(초대=`invite`, RONMAR 방)를 쓸 수 있다.

핵심 분리는 다음과 같다.

- **콘텐츠**(충실히 이식):
  - 채널 도달 범위
  - 비용 규칙(잡담의 HP, 레벨20, 일일한도)
  - ignore/PSILNC 게이트
  - 패거리 가입 경제(축하금은 boss→member, 탈퇴비 20000×gold)
  - 결혼의 나이/이성 규칙
  - 게시판 소프트삭제와 삭제 권한(작성자|DM)
  - finger 가시성(DM 정보 차단)
- **구현 방식**(재설계):
  - broadcast_* fd 순회
  - `daily[]`/`key[2]` 필드를 다른 용도로 재사용하는 방식
  - 평면 텍스트 파일 I/O
  - `system("mv …%s")` 셸 호출
  - 주석 처리된 마리지 파일 코드의 잔재
  - outbound finger(1) execl
  - CHECKFAMILY가 꺼져 기능이 절반만 동작하는(degraded) 상태

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **broadcast 원시연산 6종.** `broadcast`(PNOBRD 제외), `broadcast2`(PNOBR2 제외), `broadcast_all`(필터 없음), `broadcast_wiz`(class≥CARETAKER), `broadcast_eaves`(PEAVES+class>CARETAKER), `broadcast_rom`(방 한정). 모두 전체 소켓을 순회하며 플래그로 거른다 | 재설계(전송) / 이식(필터 규칙) |
| 2 | **전역 채널 = HP를 지불.** 잡담(`broadsend`)과 환호(`broadsend2`)는 `dc_table[31]`로 스팸을 억제한다(직전 방송 후 지난 초에 따라 60~2 HP 차감). level≥20이어야 하고, PSILNC면 막히고, HP≤비용이면 거부한다. 초인 이상은 레벨에 비례해 더 차감한다 | 콘텐츠(비용 공식) |
| 3 | **전역 채널 일일한도.** PBRSND 플래그가 있고 직전 전역 방송 후 10초 이상 지났으면 `dec_daily(DL_BROAD)`. 한도 max는 `25 + ((level+3)/4)/2`(로그인 시 설정) | 콘텐츠(한도) |
| 4 | **공간 채널 = 인접 방 전파.** 외쳐(`yell`)는 현재 방(`broadcast_rom`)과, 모든 출구 너머의 로드된 인접 방에 "누군가가 …라고 외쳤습니다"를 전한다. PHIDDN이 풀린다(자기 노출) | 콘텐츠(전파 규칙) |
| 5 | **개인 채널 이중 차단.** 얘기/이야기(`sendman`)는 수신자의 PIGNOR(전면 거부)와 `first_ignore` 개인 리스트(듣기거부=`ignore`), 발신자의 PSILNC, PINVIS/PDMINV 가시성으로 막힌다. DM이 도청할 수 있고(`broadcast_eaves`), 양쪽 다 CARETAKER 이상이면 도청에서 빠진다 | 콘텐츠(권한) |
| 6 | **우편 = 대상 파일에 append.** 우체국 방(RPOSTO)에서 편지보내기(`postsend`)→`postedit`가 **입력 줄마다 대상 파일에 즉시 append**한다(소스 주석 "major flaw"). 받기는 파일 전체를 보여 주고, 삭제는 `unlink`. 읽음 판정은 atime>ctime | 이식(기능) / 재설계(파일 I/O) |
| 7 | **게시판 = 방 객체 + 인덱스 파일.** 게시판 객체의 `type`으로 `board_dir[]`을 고른다(정보 100 / 패거리1~15는 101~115 / 플레이어 120). 256B 고정 `BOARD_INDEX` 레코드와 `board.N` 텍스트로 구성된다. **소프트삭제는 readnum의 부호를 뒤집는다**(음수=삭제, DM만 열람). 삭제권은 작성자\|DM | 이식(규칙) / 재설계(파일 포맷) |
| 8 | **게시판 쓰기가 셸을 호출.** 등록을 확정하면 `sprintf(name,"mv -f %s/%s …") ; system(name)`에 **플레이어 이름을 끼워 넣고** `creat(dir/name)`한다. 셸 인젝션과 경로 조작의 통로가 된다 | 재설계(보안상 필수) |
| 9 | **패거리 소속 = 필드를 다른 용도로 재사용.** 소속 번호는 `daily[DL_EXPND].max`, 초대 그룹은 `daily[DL_MARRI].max`에 저장한다. 플래그는 PFAMIL(가입), PRDFML(신청 중), PFMBOS(두목). 명부는 `family_member_<n>` 텍스트 | 재설계(데이터 모델) |
| 10 | **패거리 경제 = 축하금 + 탈퇴비.** 가입을 승인하면(`boss_family`) **두목이 신입에게 `gold×10000` 축하금을 준다**(boss→member 이체). 스스로 탈퇴하면(`exit_family`) `gold×20000`이 소각된다. 추방(`fm_out`)은 무료 | 콘텐츠(경제) |
| 11 | **패거리 CHECKFAMILY degraded.** `load_family()`(로스터 로딩)와 PFMBOS 자동 판정이 `#ifdef CHECKFAMILY` 안에 있다. 컴파일된 상태에서는 **로스터 배열이 비어 있어서, 두목 인식과 가입 목록이 실행 순서에 따라 달라진다(order-dependent)**. `list_family`만 조건 없이 로딩한다 | 재설계(as-compiled 비대칭) / 결정 게이트 |
| 12 | **결혼 게이트 = 나이·이성.** RMARRI 방에서, 양쪽 모두 `(18 + LT_HOURS.interval/86400) ≥ 25`(플레이 7일 이상)여야 하고, PMALES 기준 이성끼리만 가능하다. 신청(PRDMAR)과 수락의 2단계이며, 배우자는 `key[2]`에 `"m"+이름`으로 저장한다 | 콘텐츠(규칙) |
| 13 | **마리지 파일은 잔재.** `player/marriage/<name>` 파일에 쓰는 코드가 **모두 주석 처리**돼 있다. 실제 상태는 메모리의 `key[2]`에 있다. `marriage/` 디렉터리는 흔적만 남았다(vestigial) | 재설계(데드 잔재) |
| 14 | **배우자 채널·집 초대.** 사랑말(`m_send`)은 배우자와 1:1(color 34), 이혼(`divorce`)은 PRDDIV를 쓰는 2단계, 초대(`invite`)는 RONMAR(부부 집)의 손님 명부(`invite_<n>`)에 등록한다 | 콘텐츠(기능) |
| 15 | **finger는 서로 다른 두 가지.** 인게임 `사용자정보`(`pfinger`)는 종족, 클래스, 마지막 접속, 편지 유무를 보여 주고 DM 정보는 막는다. `finger.c`는 독립된 outbound `finger(1)` 클라이언트로, `dm3.c`가 `vfork`+`execl`로 플레이어의 접속 IP에 finger한다. 둘은 서로 관계가 없다 | 이식(pfinger) / 재설계(finger.c) |
| 16 | **가시성 규칙이 여러 곳에 흩어져 있음.** PDMINV(DM투명), PINVIS(투명), PDINVI(투명감지), PBLIND(실명), PSILNC(침묵), PIGNOR(전면거부), PNOBRD/PNOBR2(채널거부), PEAVES(도청), class 티어(CARETAKER/SUB_DM/DM). §9에 통합표가 있다 | 콘텐츠(권한 규칙) |

---

## 1. broadcast 원시연산: 채널의 공통 기반 (전송은 재설계 / 필터는 이식)

모든 채널과 이벤트 알림은 `io.c`의 방송 함수를 거친다. 각 함수는 **전체 소켓 테이블을 순회**하면서(`for i in 0..Tablesize`) `FD_ISSET(i,&Sockets) && Ply[i].ply`인 접속자를 플래그로 걸러 `print`한다. 함수끼리 다른 점은 **수신자 필터**뿐이다.

| 함수 | 위치 | 수신자 필터 | 용도 |
|------|------|-------------|------|
| `broadcast` | io.c:895 | `!PNOBRD` (잡담 거부 아님) | 잡담, 입퇴장, 전역 이벤트 |
| `broadcast2` | io.c:911 | `!PNOBR2` (환호 거부 아님) | 환호 |
| `broadcast_all` | io.c:926 | 필터 없음 (전원) | 강제 공지(패거리 가입/탈퇴, 결혼) |
| `broadcast_wiz` | io.c:949 | `class ≥ CARETAKER` (황색) | DM 알림 |
| `broadcast_eaves` | io.c:975 | `class > CARETAKER && PEAVES` | DM 도청(개인 대화 감시) |
| `broadcast_rom`(2) | io.c:1002/1027 | `rom_num == rm` (+ ignore fd) | 방 한정 방송 |

**필터 규칙은 콘텐츠**다. 누가 무엇을 받지 않는지는 게임 정책이기 때문이다. 순회, `print` 가변인자, `fmt2[1024]` 복사는 구현 방식이다. 신규 스택에서는 방송을 **EventEmitter 채널 + 구독자 필터**로 재설계한다. 채널별(global/room/family/marriage/wiz) 토픽에 소켓을 구독시키고, 수신자 플래그(PNOBRD 등)는 구독 필터 조건으로 옮긴다. `broadcast_rom`은 방 엔티티에 붙은 room-scoped 이벤트가 된다([[a9-monster-ai]]도 몬스터 행동을 방송할 때 이를 쓴다).

`%C…%D`, `%M`, `%j` 같은 포맷 토큰은 색상(ANSI), 이름, 조사를 처리하며 [[a3-hangul-io]]의 `print` 계층이 담당한다.

## 2. 전역·공간 채널 (콘텐츠: 비용·전파 규칙)

### 2.1 잡담·환호: HP를 지불하는 전역 채널 (broadsend/broadsend2, command4.c:493·556)

두 전역 채널은 코드가 거의 같고, **바탕이 되는 방송 함수와 거부 플래그만** 다르다. 잡담은 `broadcast`(PNOBRD), 환호는 `broadcast2`(PNOBR2)를 쓴다. 처리 순서는 다음과 같다.

1. **일일한도** (command4.c:504): `t = now − all_broad_time`. `t>10 && PBRSND && class<SUB_DM`이면 `dec_daily(&daily[DL_BROAD])`한다. 한도를 다 쓰면 "오늘 잡담의 한계를 넘겼습니다"가 나온다. `all_broad_time`은 **서버 전체에서 가장 최근에 전역 방송한 시각**이다. 로그인할 때(player.c:89)와 각종 전역 방송을 할 때 `time(0)`으로 갱신된다. 즉 일일한도는 PBRSND가 있는 플레이어에게만, 직전 전역 방송에서 10초 이상 지났을 때만 줄어든다.
2. **PSILNC**: 침묵 상태면 거부한다(class<SUB_DM에만 적용).
3. **레벨 게이트**: `level < 20 && class < CARETAKER`이면 거부한다. **20레벨 미만은 전역 채널을 쓸 수 없다.**
4. **HP 비용** (command4.c:516, `dc_table[31]`):
   - `t = now − broad_time[fd]`(내가 직전에 방송한 뒤 지난 시간). `t<0 || t>30 → discount=2`, 아니면 `dc_table[t]`(0초=60 → 29초=2)다.
   - 직전 방송 직후일수록 비싸다. 스팸을 억제하기 위해서다.
   - 초인 이상(`INVINCIBLE ≤ class < SUB_DM`)은 `discount += discount×level/60`.
   - `hpcur ≤ discount`이면 "목숨이 위태로워"와 함께 거부한다. 통과하면 `hpcur -= discount`.
5. `broad_time[fd] = now`로 기록하고 `broadcast("\n%C%s> %s%D", "32", name, msg, "37")`(초록)로 보낸다.

**비용 공식, 레벨20, 일일한도, PSILNC는 콘텐츠**(밸런스)다. `dc_table`과 `broad_time[PMAX]` 배열, 전역 `all_broad_time`은 구현 방식이다. 신규 스택은 "채널 발화에 드는 HP 비용, 스팸 억제용 쿨다운 곡선, 레벨과 일일 게이트"를 그대로 이식하고, 타임스탬프 배열은 플레이어 상태로 옮긴다.

### 2.2 외쳐: 인접 방 전파 공간 채널 (yell, command6.c:21)

외쳐는 **공간적으로 가까운 곳에만** 닿는 채널이다.
1. PSILNC면 거부한다. `PHIDDN`을 해제한다(외치면 숨은 상태가 풀린다. 자신을 드러내는 비용이다).
2. 현재 방에 `broadcast_rom(fd, rom_num, "%M이 \"%s!\"라고 외칩니다", …)`.
3. **현재 방의 모든 출구**(`first_ext`)를 순회하며, `is_rom_loaded(xp->ext->room)`인 인접 방에 익명으로 "누군가가 \"%s!\"라고 외쳤습니다"를 전한다.

즉 외침은 한 홉 거리까지 퍼지고, 인접 방에서는 누가 외쳤는지 알 수 없다. **전파 규칙(현재 방에는 실명, 로드된 인접 방에는 익명으로 1홉)은 콘텐츠**이고, 출구 리스트 순회와 `is_rom_loaded` 검사는 구현 방식이다. 신규 스택은 방 그래프의 인접 노드로 이벤트를 1홉만큼 팬아웃한다.

## 3. 개인 채널과 ignore (콘텐츠: 권한)

### 3.1 얘기/이야기: 개인 대화 (sendman, command4.c:393)

지목한 1인에게 보내는 tell이다. 대상은 **접두 매칭**으로 찾는다(이름 일부만 써도 되고, 완전히 일치하는 이름이 우선). 차단 단계는 다음과 같다.
- **가시성**: 대상이 PDMINV(비-DM에게)이거나 PINVIS(발신자에게 PDINVI가 없을 때)이면 "누구에게 말을…"이 나온다(대상을 숨긴다).
- **PIGNOR**(전면 거부): 대상이 전면 거부 상태면 "%s님은 이야기 듣기 거부 상태입니다"(비-DM이 보낼 때만).
- **개인 ignore 리스트**: 대상의 `first_ignore`(§3.2)에 발신자 이름이 있으면 "%s is ignoring you".
- **발신 PSILNC**: "당신은 말을 할 수 없습니다".
- **PLECHO**: 에코 플래그가 있으면 발신자에게도 자기 말을 보여 준다.
- 수신자에게는 `%C…31…%D`(적색)로 표시하고, `talksend`에 발신자 이름을 저장한다. 이 이름이 대답(`resend`)의 회신 대상이 된다([[a2-command-catalog]]).
- **DM 도청**: 양쪽 모두 class ≤ CARETAKER이면 `broadcast_eaves`로 DM에게 대화가 보인다(class>CARETAKER가 끼어 있으면 제외).

### 3.2 듣기거부: 개인 ignore 리스트 (ignore, command9.c:566)

`Ply[fd].extr->first_ignore`(`etag` 리스트)로 **플레이어마다 개인 무시 목록**을 관리한다.
- 인자가 없으면 현재 거부 목록을 보여 준다.
- 이름을 주면 **토글**한다. 목록에 있으면 빼고, 없으면 추가한다(대상이 접속 중일 때만).

**PIGNOR**(전면 거부, 모든 tell 차단)와 **first_ignore**(특정인만 차단)는 서로 다른 규칙이다. 앞의 것은 플래그 하나이고, 뒤의 것은 이름 리스트다. 둘 다 콘텐츠(권한 규칙)다. `etag` malloc 리스트는 구현 방식이며, 신규 스택은 플레이어 문서의 `ignoreList: string[]`로 이식한다.

## 4. 우편: 비동기 개인 메시지 (post.c)

우체국 방(`RPOSTO`, [[a4-movement-rooms]])에서만 동작한다. 편지는 `POSTPATH/<수신자이름>` 파일 하나에 계속 쌓인다.

- **편지보내기** (`postsend`, post.c:28): 플레이어 파일을 `open`해 대상이 있는지 확인한 뒤 `postedit`로 들어간다.
  - **`postedit`는 입력 줄을 받을 때마다 대상 파일에 바로 append한다.** 첫 줄에는 "%s님에게서의 편지:" 헤더와 `ctime` 날짜를 쓴다.
  - 소스 주석이 직접 밝힌 결함이 있다. **두 사람이 같은 대상에게 동시에 쓰면 줄이 뒤섞인다.** 줄 단위로 바로 기록하므로 원자성이 없기 때문이다.
  - `.`으로 끝낸다.
- **편지받기** (`postread`, post.c:131): 자기 파일(`POSTPATH/<내이름>`)을 `view_file`로 통째로 보여 준다. 없으면 "받은 편지가 없습니다".
- **편지삭제** (`postdelete`, post.c:171): 자기 파일을 `unlink`한다. **편지 하나가 아니라 우편함 전체를 지운다.**
- **DM 메모장** (`notepad`, post.c:198): CARETAKER 이상 전용이다. `POSTPATH/DM_pad`에 append(`a` 옵션), 삭제(`d`), 열람을 한다. 관리자들이 함께 쓰는 메모다.
- **패거리 공지** (`family_news`, post.c:287): PFAMIL이 필요하다. `PLAYERPATH/family/family_news_<번호>`에 두목(PFMBOS)만 append하거나 지울 수 있고, 멤버는 읽기만 한다. `#ifdef CHECKFAMILY` 안에서 두목 여부를 다시 판정한다(§6.5).

**우편의 기능(우체국 방 한정, 대상별 우편함, 헤더+날짜, DM 메모, 패거리 공지)은 콘텐츠**다. 평면 파일 append, 우편함 통째 삭제, atime>ctime 읽음 판정, 원자적이지 않은 동시 쓰기 결함은 구현 방식이다. 신규 스택은 편지를 **메시지 단위 문서**(sender·recipient·body·sentAt·readAt)로 분리해 동시성 결함을 없애고, "우체국 방에서만 열람"하는 제약은 유지한다. pfinger의 편지 도착 알림(§8.1)도 readAt 필드로 대응시킨다.

## 5. 게시판: 방-객체 부착 게시판 (board.c)

게시판은 **방에 놓인 객체**(`find_obj "게시판"`, `special == SP_BOARD`)이고, 객체의 `type` 필드가 어느 게시판인지 정한다. `board_dir[]` 매핑(board.c:33)은 다음과 같다.

| type | 디렉터리 | 용도 |
|------|----------|------|
| 100 | `board/info` | 공지 게시판 |
| 101~115 | `board/family1`~`family15` | **패거리별 전용 게시판**(§6과 연동) |
| 116 | `board/family` | 패거리 공용 |
| 120 | `board/user` | 플레이어 자유 게시판 |

디렉터리마다 **256바이트 고정 `BOARD_INDEX` 레코드 배열**(`board_index`)과 게시물별 `board.N` 텍스트 파일이 있다. `BOARD_INDEX`는 {num, upload(작성자 16B), 날짜(y/m/d/h/m/s), line(줄수), readnum(조회수), title(40B), extra[41]}이다.

- **게시판**(`look_board`→`list_board`, board.c:66): 인덱스를 뒤(최신)부터 20개씩 페이지로 나눠 보여 준다. `readnum<0`(삭제됨)인 글은 DM에게만 보인다. `[Enter]`로 계속, `[.]`로 중단한다.
- **써**(`writeboard`→`write_board`, board.c:176): 제목을 입력하고 본문을 줄 단위로 입력한다(`.`=등록, `!!`=취소). 등록하면 임시 파일을 `board.N`으로 옮기고 인덱스 레코드를 추가한다.
- **게시판 읽기**(`read_board`, board.c:323): 번호로 `board.N`을 보여 주고 **조회수를 올린다**(작성자 본인이 읽으면 세지 않는다).
- **글삭제**(`del_board`, board.c:390): **소프트삭제는 `readnum`의 부호를 뒤집는 방식**이다(음수=삭제 상태, 다시 실행하면 복구). 권한은 **작성자 본인 또는 class≥DM**에게 있다.

**게시판 기능(방 부착, 패거리별 분리, 페이지네이션, 소프트삭제, 조회수, 작성자/DM 삭제권)은 콘텐츠**다. 256B 레코드 포맷, `lseek` 오프셋, 부호 반전 삭제, 별도 텍스트 파일은 구현 방식이다. 신규 스택은 board 컬렉션(boardId·author·title·body·postedAt·views·deleted)을 만들고, 방 객체가 boardId를 참조하도록 이식한다.

**보안 관련 구현 방식(§8 아키텍처 시사점으로 올림)**: `write_board` case 2는 등록을 확정할 때 `sprintf(name, "mv -f %s/%s %s/board.%ld", dir, ply->name, …); system(name)`을 실행한다. 즉 **플레이어 이름을 셸 명령에 끼워 넣는다.** 또 `creat("%s/%s", dir, ply->name)`로 이름을 경로에 그대로 쓴다. 플레이어 이름이 한글이라 당장 인젝션할 수 있는 범위는 좁다. 그래도 **이식할 때 절대 재현하지 않는다.** 서버 측 파일 I/O(또는 DB write)로 대체한다([[muhan-oracle-toolchain]] 및 프로젝트 `security.md`의 shell injection 방어).

## 6. 패거리(family): 길드 시스템 (규칙은 이식 / 데이터·CHECKFAMILY는 재설계)

### 6.1 데이터 모델 (원작 구현 방식)

- **로스터**: `PLAYERPATH/family/family_list` 파일이다. 한 줄에 `번호 이름 두목 가입금`이 들어 있다(가입금에 ×10000을 해야 실제 냥이다).
  - `load_family()`(command11.c:474)가 이 파일을 전역 배열 `family_num[]`/`family_str[]`/`fmboss_str[]`/`family_gold[]`에 읽어 들이고, `번호==16`(MAXFAMILY 센티넬)에서 멈춘다.
  - 실제 데이터에 "사악파 타이 100"(두목 타이, 가입금 100만냥) 같은 항목이 채워져 있다. 따라서 **원래 의도는 동작하는 패거리**다.
- **소속 저장**: 플레이어의 **`daily[DL_EXPND].max` 필드를 다른 용도로 재사용해 패거리 번호**를 저장한다. 초대 그룹은 `daily[DL_MARRI].max`에 저장한다.
- **상태 플래그**: `PFAMIL`(가입 완료), `PRDFML`(가입 신청 중), `PFMBOS`(두목).
- **멤버 명부**: `family/family_member_<번호>` 파일이다. 한 줄에 `class 이름`이 들어 있다. `edit_member()`(command12.c:237)가 param 1(가입 추가), 2(탈퇴·추방 제거), 3(수정)으로 다시 쓴다.

### 6.2 가입 흐름 (콘텐츠 경제)

1. **패거리가입**(`family`→`add_family`, command11.c:494):
   - 이미 PFAMIL이나 PRDFML이면 거부한다.
   - 패거리 목록을 보여 주고 이름을 고르게 한다. **두목이 접속 중이어야 한다**(`find_who(fmboss_str[])`).
   - `daily[DL_EXPND].max=번호`로 설정하고, "예"로 확인하면 `PRDFML`을 설정하고 두목에게 신청을 알린다.
2. **가입허가**(`boss_family`, command11.c:585):
   - **PFMBOS 두목만** 쓸 수 있다.
   - 신청자는 PRDFML 상태이고, 패거리 번호가 같고, 아직 가입하지 않은 상태여야 한다.
   - **두목의 gold가 `family_gold×10000` 이상인지** 확인한다.
   - `PRDFML`을 해제하고 `PFAMIL`을 설정한 뒤 `edit_member(…,1)`를 호출한다.
   - **두목이 신입에게 `gold×10000` 축하금을 이체한다**(`crt→gold +=`, `boss→gold −=`).
   - `broadcast_all`로 가입을 공지한다.

**경제 규칙**: 가입할 때 두목이 신입에게 **축하금을 준다**(recruitment subsidy, gold 순환). 두목의 자금이 가입의 조건이자 비용이 된다.

### 6.3 탈퇴·추방 (콘텐츠 경제)

- **패거리탈퇴**(`out_family`→`exit_family`, command11.c:650): **두목은 탈퇴할 수 없다.** PRDFML(신청 중)이면 신청을 취소한다. 가입한 상태면 **`family_gold×20000`이 소각된다**(자진 탈퇴비로, 축하금의 2배이며 gold sink 역할을 한다). 이어서 `edit_member(…,2)`를 호출하고, PFAMIL을 해제하고, 번호를 0으로 만든다. `broadcast_all`로 공지한다.
- **패거리추방**(`fm_out`, command12.c:151): **PFMBOS 두목만** 쓸 수 있다. 같은 패거리원을 강제로 내보낸다. PFAMIL을 해제하고, 번호를 0으로 만들고, `edit_member(…,2)`를 호출한다. 자진 탈퇴비와 달리 **추방은 무료**다. 온라인 대상(`find_who`)과 오프라인 대상(`load_ply`+`save_ply`)을 모두 처리하며, 자기 자신은 추방할 수 없다.

### 6.4 패거리 채널·조회 (콘텐츠)

- **패거리말**(`family_talk` / `]`, command11.c:729): PFAMIL이 필요하고 PSILNC가 아니어야 한다. 전체 소켓을 순회하며 **`daily[DL_EXPND].max`가 같은 PFAMIL 멤버**에게 `%C33…`(황색)로 보낸다. DM은 `broadcast_eaves`로 도청한다.
- **패거리누구**(`family_who`, command11.c:773): 접속 중인 같은 패거리원을 나열한다(신청 중인 사람은 `(-)`로 표시). 또는 특정인이 어느 패거리인지 조회한다(가시성 게이트 적용).
- **패거리원**(`family_member`, command12.c:301): 명부 파일에서 전체 멤버(class+이름)를 나열한다.
- **모든패거리**(`list_family`, command11.c:847): 모든 패거리와 두목 목록을 보여 준다. **`load_family()`를 조건 없이 호출한다**(ifdef 밖).
- **경험치전수**(`trans_exp`, command11.c:875): CARETAKER 이상이면서 패거리원인 경우에만 경험치를 이체한다(1~100000 범위). 소스 주석에 "루틴만 있고 사용은 하지 않는데"라고 적혀 있다. 명령 표에 거의 등록되지 않은 **반쯤 데드인 코드**다.

### 6.5 CHECKFAMILY: as-compiled degraded 상태 (원작 구현 방식 / 결정 게이트)

**as-shipped의 핵심 사실**: CFLAGS에 `-DCHECKFAMILY`가 **없다**(서두 참조). `#ifdef CHECKFAMILY`가 쓰인 곳은 `command11.c`(family/add_family/boss_family/exit_family/family_talk/family_who/fm_out), `command12.c`, `post.c`(family_news), `player.c:70`(로그인 훅)이다. 이 블록들은 **컴파일에서 빠진다.**

빠지는 내용은 대부분 **`load_family()` 호출과 두목 자동 판정**(`if(name==fmboss_str[num]) F_SET(PFMBOS)`)이다. CHECKFAMILY가 꺼져 있으면 다음과 같이 된다.
- 가입, 두목, 탈퇴, 채널 경로에서 **로스터 배열(`family_str`/`fmboss_str`)이 로드되지 않는다.** `add_family` case 0의 목록과 이름 매칭이 빈 배열(BSS)을 참조하므로, 가입 목록이 비고 매칭이 실패한다.
- **`boss_family`(가입허가)는 PFMBOS를 요구**하는데, 그 플래그를 설정하는 자동 판정이 모두 ifdef 안에 있다. 그래서 **두목이 인식되지 않아 가입 승인이 사실상 불가능하다.**
- **단, `list_family`(모든패거리)는 조건 없이 `load_family()`를 호출한다.** 게다가 `family_str`/`fmboss_str`은 **프로세스 전역 변수**다. 따라서 누군가 `모든패거리`를 한 번 실행하면 그 세션 동안 배열이 채워진 상태로 남는다.

정리하면 컴파일된 동작은 **"패거리가 꺼진 상태"가 아니라 "로스터 로딩과 두목 판정이 실행 순서에 따라 달라지는 degraded 상태"**다. 로그인 훅(player.c:70)에서도 `load_family()`만 ifdef 안에 있고, PFMBOS 판정 자체는 ifdef **밖**에 있다. 그래서 로스터가 채워지지 않은 상태로 로그인하면 두목 이름이 빈 문자열과 비교돼 PFMBOS가 항상 꺼진다.

**처음에 누가 어떻게 PFMBOS를 얻는지는 오라클만으로는 알 수 없다(open ambiguity).** 처리 방침은 [[a9-monster-ai]]의 MFLEER/MSAYTLK 데드 스캐폴드와 같다. 다음 둘 중 하나를 **결정 게이트 항목**으로 남긴다.
- (a) as-compiled(degraded)를 재현한다. 패거리 기능 대부분이 무력해진다.
- (b) **as-intended(CHECKFAMILY-on)**를 재현한다. `family_list` 데이터가 채워져 있으므로 정상적인 패거리로 이식한다.

포팅 원칙([[muhan-port-principle]])은 "동작을 충실히 재현"하는 것이 기준이다. 하지만 여기서는 **as-intended가 데이터의 의도와 맞으므로** 기준으로 채택될 가능성이 높다. 명시적인 결정으로 확정하고, 추측으로 결론 내리지 않는다.

## 7. 결혼(marriage): 부부 관계 시스템 (규칙은 이식 / 저장은 재설계)

### 7.1 결혼 게이트·2단계 성사 (marriage, command11.c:1112)

결혼식장 방(`RMARRI`, [[a4-movement-rooms]])에서만 할 수 있다.
1. **나이**: `(18 + LT_HOURS.interval/86400) < 25`이면 "결혼할 나이가 아닙니다". 나이는 **18 + 누적 플레이 일수**다(LT_HOURS=총 접속 초). ≥25가 되려면 **플레이 7일 이상**이 필요하다. **양쪽 모두** 검사한다.
2. **성별**: `PMALES` 플래그로 판단한다. 남남(둘 다 PMALES)과 여여(둘 다 PMALES 아님)는 거부한다. **이성끼리만** 가능하다.
3. 대상이 미혼(PMARRI 아님)인지, 가시성(PDMINV/PINVIS/PBLIND)은 어떤지 검사한다.
4. **신청/수락 2단계**:
   - 대상이 아직 PRDMAR가 아니면, 신청자에게 `PRDMAR`을 설정하고 `key[2] = "m"+대상이름`으로 저장한 뒤 대상에게 알린다.
   - 대상이 이미 (나를 향해) PRDMAR이면, **`key[2][1:]`가 나를 가리키는지 확인**한 뒤 양쪽에 `PMARRI`를 설정하고 `broadcast_all`로 결혼을 공지한다.

### 7.2 배우자 저장은 key[2] (원작 구현 방식)

배우자 정보는 **파일이 아니라 creature의 `key[2]` 필드에 `"m"+배우자이름`**으로 저장한다. 원래 `player/marriage/<name>` 파일에 쓰던 코드(command11.c:1182·1195·1211 등)는 **모두 주석 처리**돼 있다. 따라서 `player/marriage/` 디렉터리는 흔적만 남았다(vestigial, list 파일만 남은 빈 껍데기). 신규 스택은 플레이어 문서의 `spouse: string` 필드로 이식한다.

### 7.3 배우자 채널·이혼·초대 (콘텐츠)

- **사랑말**(`m_send`, command11.c:1235): PMARRI가 필요하다. `key[2]`로 배우자를 찾고(접속 중이어야 함) `%C34…`(청색)로 1:1 전송한다. PLECHO면 에코한다.
- **이혼**(`divorce`, command11.c:1279): 결혼과 대칭인 2단계(`PRDDIV`)다. 배우자가 존재하지 않으면(`load_ply` 실패) PMARRI를 자동으로 해제하고 `key[2]`를 비운다. 서로 수락하면 양쪽의 PMARRI/PRDMAR/PRDDIV를 해제하고 `broadcast`(PNOBRD 존중)로 공지한다.
- **초대**(`invite`, command12.c:301+): `daily[DL_MARRI].max`(초대 그룹 번호)와 `RONMAR`(부부 집) 방이 필요하다. `invite/invite_<번호>` 파일에 손님 이름(한글만)을 등록, 조회, 삭제한다. 부부가 자기 집에 들일 손님을 정하는 접근 제어 명부다.

**결혼 규칙(나이=플레이 7일, 이성, 2단계 신청과 수락, 이혼의 대칭성, 집 초대)은 콘텐츠**다. `key[2]` 저장, 주석 처리된 마리지 파일 잔재, `daily` 필드를 다른 용도로 재사용하는 방식은 구현 방식이다.

## 8. finger 2종: 인게임 조회 vs outbound 클라이언트

이슈가 지목한 `finger.c`는 **인게임 플레이어 조회와 관계없는 별개의 바이너리**다. 두 가지를 나눠서 봐야 한다.

### 8.1 사용자정보 = 인게임 finger (pfinger, command11.c:394) — 콘텐츠

플레이어 정보를 조회한다. 온라인 대상(`find_who`)과 오프라인 대상(`load_ply`)을 모두 처리한다.
- 표시 항목: 이름, 종족(`race_str`), 클래스(`class_str`), 마지막 접속 시각(파일 ctime), 현재 접속 여부, SUICD(자살 신청) 여부.
- **편지 알림**: `POSTPATH/<대상>`을 stat해 편지가 있는지 보고, atime>ctime으로 "읽지 않은 새 편지가 도착한 날짜"를 알려 준다.
- **가시성 권한**: 비-DM은 DM의 정보를 조회할 수 없고, PDMINV(DM투명) 대상은 차단되며, SUB_DM/DM 티어별로 더 세분된다.

이식 대상이다. 플레이어 프로필 조회 API로 옮긴다(공개 필드만, 권한 티어 존중).

### 8.2 finger.c = outbound 인터넷 finger 클라이언트 (원작 구현 방식, drop 후보)

`finger.c`는 `main()`이 있는 **독립 실행 바이너리**다. 외부 호스트의 **finger 프로토콜(TCP 79)에 접속**해 결과를 플레이어 fd로 전달한다. `dm3.c:788`이 `vfork()` + `execl(BINPATH/finger, "finger", fdstr, addr, name, 0)`로 실행하며, `addr`은 **접속 중인 플레이어의 연결 IP**(`Ply[fd].io->address`)다. 즉 DM이 접속자의 원격 호스트를 finger하는 관리 도구다. 소스 주석 "no idea why this is in here"에서 보듯 임시방편으로 넣은 코드다. 컴파일 플래그 `-DFINGERACCT`(계정 finger)와도 관계가 없다.

이것은 **순수한 인프라이자 흔적만 남은 코드**다. 1990년대 인터넷 finger 문화의 잔재일 뿐 게임 콘텐츠가 아니다. 신규 스택에서는 **이식하지 않는다**(drop). 관리자 진단이 필요하면 접속 메타데이터(IP, 접속 시각)를 서버 로그나 admin 대시보드로 제공한다.

## 9. 가시성·권한 통합표 (이슈 명시 산출)

소셜 기능 전반에 걸린 가시성과 권한 규칙을 한곳에 모은다. (플래그 정의는 `mtype.h`, class 티어는 [[a7-player-progression]]에 있다.)

| 축 | 플래그/조건 | 효과 | 적용 채널·기능 |
|----|-------------|------|----------------|
| **채널 거부(수신)** | PNOBRD / PNOBR2 | 잡담 / 환호를 받지 않음 | broadcast / broadcast2 |
| **전면 대화 거부** | PIGNOR | 모든 개인 tell 차단(비-DM) | sendman |
| **개인 무시** | first_ignore 리스트 | 특정인의 tell만 차단 | ignore / sendman |
| **침묵(발신)** | PSILNC | 잡담·환호·외침·개인·패거리말 불가 | 전 채널 |
| **투명** | PINVIS (+PDINVI 감지) | 대상을 숨김(tell·결혼·finger) | sendman/marriage/pfinger |
| **DM 투명** | PDMINV | 비-DM에게 완전히 숨김 | 전역·조회 전반 |
| **실명** | PBLIND | 조회·패거리누구 불가 | family_who/marriage |
| **도청** | PEAVES (class>CARETAKER) | 개인·패거리 대화 감시 | broadcast_eaves |
| **DM 전용 방송** | class ≥ CARETAKER | wiz 채널 수신 | broadcast_wiz |
| **레벨 게이트** | level ≥ 20 | 전역 채널 발화 | broadsend/broadsend2 |
| **일일한도** | PBRSND + DL_BROAD | 잡담 횟수 제한 | broadsend/broadsend2 |
| **게시판 삭제권** | 작성자 \| class≥DM | 글 소프트삭제 | del_board |
| **삭제글 열람** | class ≥ DM | readnum<0 게시물 표시 | list_board/read_board |
| **패거리 두목권** | PFMBOS | 가입허가·추방·공지삭제 | boss_family/fm_out/family_news |
| **finger 정보 차단** | class 티어 + PDMINV | 비-DM에게 DM 정보 차단 | pfinger |

## 콘텐츠(이식) vs 구현 방식(재설계) 분류

| 항목 | 콘텐츠 (충실히 이식) | 구현 방식 (자유롭게 재설계) |
|------|---------------------|----------------------|
| 방송 기반 | 수신자 필터 정책(PNOBRD/PNOBR2/class/PEAVES/방한정) | broadcast_* 6종의 전체 소켓 순회, fmt2[1024] |
| 전역 채널 | HP 비용 곡선(dc_table), level≥20, 일일한도, 초인 가중 | broad_time[PMAX]·all_broad_time 전역 변수, dc_table 리터럴 |
| 공간 채널 | 외침 1홉 전파(현재 방은 실명, 인접 방은 익명), PHIDDN 해제 | first_ext 순회, is_rom_loaded |
| 개인 채널 | tell + PIGNOR/first_ignore/PSILNC/가시성, DM 도청, 대답 대상 | etag ignore 리스트, talksend, 접두 매칭 |
| 우편 | 우체국 방 한정, 대상별 우편함, 헤더+날짜, DM 메모, 패거리 공지 | 평면 파일에 즉시 append(비원자적), 우편함 통째 unlink, atime>ctime |
| 게시판 | 방 부착, 패거리별 분리, 페이지네이션, 소프트삭제, 조회수, 작성자/DM 삭제권 | 256B BOARD_INDEX·lseek, board.N 텍스트, **system()·creat() 셸/경로** |
| 패거리 소속 | 길드 소속·두목·명부·전용 게시판/공지 | **daily[DL_EXPND].max 필드를 다른 용도로 재사용**, family_member 텍스트 |
| 패거리 경제 | 가입 축하금(boss→member gold×10000), 탈퇴비(×20000 소각), 추방 무료 | gold 직접 증감 |
| 패거리 채널 | 같은 소속에게 전송(황색), 두목 전용 명령 | Tablesize 순회, **CHECKFAMILY degraded(§6.5)** |
| 결혼 | 나이(플레이 7일)·이성 게이트, 2단계 신청과 수락, 이혼 대칭, 집 초대 | **key[2] "m"+이름 저장, 마리지 파일 주석 잔재** |
| 배우자/그룹 채널 | 배우자 1:1(청색), 그룹말([[a2-command-catalog]]) | find_who 재탐색 |
| finger | 인게임 pfinger(프로필·편지·권한 티어) | **outbound finger.c(vfork/execl 79포트) = drop** |
| 가시성·권한 | §9 통합표 전체 | 플래그 비트 인덱스 |

## 아키텍처 시사점

1. **채널은 EventEmitter 토픽과 구독 필터로 만든다.** broadcast_* 6종을 채널 토픽(global-chat/global-cheer/room/family/marriage/wiz/eaves)으로 재설계하고, 수신자 플래그(PNOBRD, PNOBR2, PEAVES, class)를 **구독 조건**으로 옮긴다. `broadcast_rom`은 방 엔티티의 room-scoped 이벤트가 되고, 패거리말은 패거리 채널 구독으로 자연스럽게 대응된다. 전체 소켓을 O(n)으로 순회하던 방식은 토픽별 구독자 집합으로 바꾼다.

2. **채널 비용과 게이트는 밸런스이므로 수치까지 이식한다.** 다음은 소셜 스팸 억제와 경제의 일부다.
   - 잡담 HP 곡선(`dc_table` 0초=60 → 29초=2)
   - 초인 레벨 가중(`discount×level/60`)
   - 레벨20 게이트
   - 일일한도(`25+((level+3)/4)/2`)
   - 외침 1홉 전파

   `broad_time`/`all_broad_time` 전역 타임스탬프는 플레이어 상태와 서버 상태로 옮기되 곡선은 그대로 둔다.

3. **보안 관련 구현 방식은 그대로 이식하지 않는다.** `board.c`의 `system("mv -f …%s…")` + `creat(dir/name)`은 **플레이어 이름을 셸 명령과 경로에 끼워 넣으므로** 인젝션과 경로 조작의 통로가 된다(프로젝트 `security.md`의 shell injection 방어와 직결된다). 우편, 게시판, 명부의 모든 파일 I/O를 서버 측의 안전한 I/O 또는 DB write로 대체한다. 사용자 입력(이름, 제목, 본문)은 절대 경로나 명령에 직접 쓰지 않는다.

4. **다른 용도로 재사용한 필드는 명시적인 스키마로 정리한다.** 패거리 번호(`daily[DL_EXPND].max`), 초대 그룹(`daily[DL_MARRI].max`), 배우자(`key[2]`)는 원본이 남는 필드를 재활용한 것이다. MongoDB 스키마에서는 `family: {id, role}`, `spouse: string`, `houseGuests: string[]`, `ignoreList: string[]` 같은 **독립 필드**로 옮긴다. 어느 daily 슬롯이 무엇을 뜻하는지 같은 재사용 의미를 코드 속에 숨겨 두지 않는다.

5. **비동기 메시지는 문서 단위로 저장한다.** 우편이 "대상 파일에 줄 단위로 바로 append"하는 방식은 동시에 보내면 내용이 뒤섞이는 결함이 있다(소스 주석도 인정한다). **메시지 단위 문서**(sender·recipient·body·sentAt·readAt)로 이식해 원자성을 확보하고, 읽음 상태(atime>ctime)는 `readAt`으로 정리한다. 게시판도 board 문서(views, deleted 플래그, author)로 옮기고, 소프트삭제(readnum 부호 반전)는 `deleted: bool`로 바꾼다. "우체국 방이나 게시판 객체가 있어야 접근"하는 제약은 유지한다.

6. **패거리 CHECKFAMILY는 결정 게이트로 다룬다.** 컴파일된 상태는 로스터 로딩과 두목 판정이 실행 순서에 따라 달라지는 degraded 상태(§6.5)다. 하지만 `family_list` 데이터에는 정상적인 패거리가 들어 있다. 그래서 **as-intended(정상 패거리) 이식을 기준으로 채택**한다. 다만 PFMBOS를 얻는 경로는 오라클만으로 알 수 없으므로(open ambiguity), 두목 임명 규칙(최초 생성자? DM 지정?)은 신규 설계로 확정한다. [[a9-monster-ai]]의 데드 스캐폴드와 같은 "재현 vs 되살림" 결정 게이트다.

7. **finger.c는 이식하지 않는다.** outbound 인터넷 finger(1) 클라이언트는 게임 콘텐츠가 아니라 1990년대 인프라의 잔재다(drop). 인게임 pfinger(프로필, 편지 알림, 권한 티어)만 플레이어 조회 API로 이식한다. 관리 진단(접속 IP, 시각)은 서버 로그와 admin 도구로 대체한다.
