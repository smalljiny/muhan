# A12 세션·인증·세이브 라이프사이클

**이슈**: [#12](https://github.com/smalljiny/muhan/issues/12) · **분석 대상 oracle**: `io.c`(`accept_connect`/`init_connect`/`disconnect`/`handle_commands`), `command1.c`(`login`/`create_ply`/`command`/`first_han`/`checkdouble`), `files2.c`(`save_ply`/`load_ply`/`save_all_ply`), `command8.c`(`savegame`/`savegame_nomsg`), `command5.c`(`suicide`), `update.c`(`update_game`/`update_users`/`update_shutdown`), `player.c`(`init_ply`/`uninit_ply`/`update_ply`), `auth.c`(identd 클라이언트), `global.c`(명령 테이블), 플레이어 세이브 실측(`player/타/타이`).

## 개요

접속·인증·캐릭터 생성·세이브·삭제의 전 라이프사이클을 규명한다. 결론부터: **무한에는 "계정"이라는 1급 객체가 없다.** 로그인 단위는 캐릭터 그 자체이며, **캐릭터 이름이 곧 크리덴셜의 키**다. 인증은 캐릭터 세이브 파일 안에 든 **평문 비밀번호를 `strcmp`로 비교**하는 방식이고(실측 확인), 세션은 telnet 소켓 위의 **함수 포인터 상태머신**(`io->fn`)으로 돌아간다. 세이브는 **주기적 자동세이브가 없고**(검증 완료), 로그아웃·셧다운·이벤트(은행·거래·레벨업 등) 시점에만 디스크에 기록된다.

`auth.c`는 이슈가 인증 oracle로 지목했지만 실제로는 **계정 인증과 무관한 identd(RFC 1413) 클라이언트**다 — 접속자의 호스트명·userid를 조회하는 별도 fork 바이너리이며, 게임 로그인 로직은 전부 `command1.c`의 `login`/`create_ply` 상태머신에 있다. 이 오독을 바로잡는 것이 A12의 첫 발견이다.

## 핵심 발견 요약

1. **`auth.c` ≠ 계정 인증**. `auth.c`는 identd(포트 113) 클라이언트로, `accept_connect`가 `vfork`+`execl`로 띄우는 **접속자 호스트/userid 조회용 헬퍼 프로세스**다(`io.c:295`). 결과는 `LOGPATH/auth/lookup.<pid>` 파일로 남고 `reap_children`이 회수한다(`io.c:1216`). 비밀번호 검증과 무관하며, 실패해도 `userid="unknown"`으로 게임은 정상 진행한다.

2. **계정 개념 부재 — 이름=크리덴셜**. 로그인은 `이름 → load_ply(이름) → 평문 password strcmp`. 별도 account 객체·이메일·계정 ID가 없다. 한 사람이 캐릭터 N개를 쓰면 N개의 독립 크리덴셜이며, 이들을 묶는 상위 엔티티는 코드에 존재하지 않는다.

3. **평문 비밀번호(실측 확인)**. `creature.password`(offset 240, 20B)에 평문 저장. 실측: `player/타/타이`(1188B) → `name@0="타이"`(EUC-KR), `password@240="1234"`(ASCII 평문·미해시). 검증도 `strcmp(str, ply->password)`(`command1.c:159`) 단순 비교. **재설계 필수 1순위**.

4. **세션 = 함수 포인터 상태머신**. 각 소켓 fd의 다음 입력 처리 함수를 `Ply[fd].io->fn`이 가리키고, `RETURN(a,b,c)` 매크로(`mtype.h:564`)가 `fn=b; fnparam=c`로 전이시킨다. 상태 흐름: `waiting`(대기열) → `login`(인증) → `create_ply`(생성) → `command`(플레이). 스레드·세션 객체 없이 이벤트 루프가 fd별 콜백을 디스패치한다.

5. **주기적 자동세이브 없음(검증 완료)**. 유일한 per-player 주기 훅 `update_ply`(`player.c:348`, 20초 틱)에 save 호출이 **없다**. `save_all_ply`는 `update_shutdown`(종료)에서만 호출(`update.c:837`). 상시 세이브는 **이벤트 기반 `savegame_nomsg`**(은행·거래·레벨 등 30+ 호출처)와 **로그아웃 세이브**(`disconnect`→`save_ply`, `io.c:866`)뿐.

6. **Idle timeout 300초 → disconnect(=세이브)**. `update_users`(`update.c:94`)가 `time-io->ltime > 300`이고 대기열이 아니면 강제 종료. DM(class==DM) 면제. disconnect가 save_ply를 호출하므로 **idle 종료가 사실상 최후의 세이브 안전망** 역할을 한다.

7. **세이브 전 장비 un-equip 처리**. `savegame`/`savegame_nomsg`는 원본을 복제한 뒤 착용 슬롯(`ready[MAXWEAR]`)을 인벤토리로 되돌려 저장하고 원본은 그대로 둔다(`command8.c:706`). 디스크 포맷이 착용 상태를 인벤토리 참조로만 표현하기 때문. 이식 시 **직렬화 시점 정규화** 규칙으로 재현한다.

8. **삭제 = soft-delete(파일 이동)**. `suicide`(`command5.c:668`)는 password + "찐짜로" 이중 확인 후 disconnect(→세이브)하고 즉시 `system("mv")`로 캐릭터·alias·bank 파일을 `player/suic/`로 이동한다. 물리 삭제가 아니라 graveyard 이동이며, `SUICD` 플래그로 재로그인을 차단한다.

9. **계정-대체 병렬 파일 집합**. "계정"은 없지만, 이름을 키로 한 보조 파일들(`alias/`, `bank/`, `simul/`)과 그룹 파일(`family/`, `marriage/`)이 계정 역할을 **분산 수행**한다. 초성 샤딩(`player/<초성>/<이름>`)은 디렉터리 엔트리 수 억제용.

---

## 1. 접속 라이프사이클

메인 루프 `sock_loop`(`io.c:199`)은 4단계를 무한 반복한다:

```c
while(1) {
    if(Deadchildren) reap_children();   /* identd 자식 회수 */
    io_check();                         /* 신규 접속 수락 + 입력 읽기 */
    output_buf();                       /* 출력 버퍼 flush */
    handle_commands();                  /* 완성된 줄을 fn 콜백에 디스패치 */
    update_game();                      /* 시간 기반 갱신(틱) */
}
```

`io_check`(`io.c:220`)는 `select`(75ms 타임아웃)로 준비된 fd를 훑어, `Waitsock`이면 `accept_connect`, 그 외 fd면 `accept_input`을 호출한다.

### 1.1 신규 접속: `accept_connect` (`io.c:253`)

1. `accept()`로 소켓 확보, non-blocking(`FIONBIO`) + `SO_LINGER 0` 설정.
2. `iobuf`(입출력 링버퍼)·`extra`(무시 목록 등) 구조체를 `malloc`+`zero`하고 `Ply[fd]`에 연결. `io->ltime=time(0)`.
3. **identd 조회 fork**: `vfork()` 후 자식이 `execl("<BINPATH>/auth", io->address, <상대포트>, <서버포트>)`. 부모는 `io->userid="unknown"`, `io->lookup_pid=pid` 저장(`io.c:295`).
4. **정원 게이트**:
   - `Numplayers > Tablesize-2` → "Game full." 후 disconnect.
   - `Numplayers >= MAXPLAYERS`(256)이고 loopback(127.x)이 아니면 → `add_wait`로 **대기열** 투입, `fn=waiting`.
   - 그 외 → `init_connect(fd)`.

### 1.2 세션 초기화: `init_connect` (`io.c:339`)

- 저작권 배너 출력(원작 Mordor 2.5 크레딧 — 주석에 "must be left intact as part of the copyright agreement").
- `io->intrpt |= 2`(플레이어 슬롯 점유 표시), `Numplayers++`.
- `locked_out(fd)`(`io.c:384`)로 사이트 차단 검사:
  - 반환 2(사이트 비밀번호 필요) → 비밀번호 입력 요구, `RETURN(fd, login, 0)`.
  - 반환 1(완전 차단) → disconnect.
  - 반환 0(정상) → `[엔터]를 누르세요` 후 `RETURN(fd, login, -1)`.
- `locked_out`은 `Lockout[]` 테이블을 와일드카드 IP 매칭(`addr_equal`, `*`=옥텟 와일드)으로 검사한다. 사이트 비밀번호는 `extr->tempstr[0]`에 실려 login 상태머신으로 넘어간다.

### 1.3 입력 처리: `accept_input` (`io.c:442`) / `handle_commands` (`io.c:754`)

- `accept_input`은 소켓에서 raw 바이트를 읽어 fd별 입력 링버퍼(`io->input`, `IBUFSIZE`)에 축적한다. `\r`→`\n` 정규화, `\b`/DEL(127) 백스페이스 처리, EUC-KR high-byte(0x80~, CSI 155 제외) 통과, 개행 시 `io->commands++`.
- `n<=0`(연결 끊김)이면 `io->commands=-1` 표시.
- `handle_commands`는 완성된 한 줄을 뽑아 **현재 fn 콜백**을 호출한다:
  ```c
  (*Ply[i].io->fn)(i, Ply[i].io->fnparam, <telnet IAC 프리픽스 제거된 buf>);
  ```
  줄 앞에 telnet IAC(255) + DO/DONT(253/254) 프리픽스가 있으면 2바이트 건너뛴다(`io.c:811`). 줄임말(alias) 큐가 있으면 우선 소비한다(`io.c:771`).

### 1.4 종료: `disconnect` (`io.c:825`)

순서가 중요하다:
1. `close_alias(fd)`, 소켓 `close`, `FD_CLR`, `Spy[fd]=-1`.
2. `io->intrpt & 2`이면 `Numplayers--`, `iobuf` free.
3. `extra`(무시 목록 linked list) free.
4. **플레이어가 인게임(`ply->fd > -1`)이면** `uninit_ply(ply)` 후 **`save_ply(ply->name, ply)`** — 로그아웃 세이브의 정본 경로.
5. `free_crt(ply)`.
6. 대기열이 있고 정원 여유가 생기면 `remove_wait(1)` → `init_connect`로 다음 대기자 입장.

**함의**: 정상 종료·연결 끊김·idle timeout·강퇴가 모두 `disconnect`를 거치므로 세이브 지점이 하나로 수렴한다. 단 서버 크래시(`kill -9`, 세그폴트)는 이 경로를 타지 못해 **마지막 이벤트 세이브 이후 변경분이 소실**된다.

---

## 2. 인증: `login` 상태머신 (`command1.c:40`)

`login(fd, param, str)`은 `param`(=`fnparam`)으로 단계를 구분하는 상태머신이다. `param` 값과 전이:

| param | 진입 조건 | 동작 | 다음 상태 |
|-------|----------|------|-----------|
| **-1** | `init_connect` 정상 | `str[0]=0`(입력 클리어) 후 **case 0으로 fall-through** | (아래 0) |
| **0** | 사이트 비번 필요/엔터 | `pass_num=0`; `tempstr[0]`(사이트 비번)과 `str` 비교, 불일치면 재요구; 일치면 이름 질문 | `login,1` |
| **1** | 이름 입력 | 이름 검증 → `load_ply` | `login,2`(신규) / `login,3`(기존) |
| **2** | 신규 생성 y/n | "예"/"y" → 생성 진입, 아니면 이름 재질문 | `create_ply,1` / `login,1` |
| **3** | 비밀번호 입력 | `strcmp` 검증 | `command,1`(성공) / disconnect(3회 실패) |

> **주의**: `case -1`은 `break`가 없어 `case 0`으로 **fall-through**한다(`str` 클리어 후 사이트 비번 검사 경로 공유). `-1`과 `0`은 별개 상태가 아니라 "입력 클리어 여부"만 다른 같은 관문이다.

### 2.1 이름 검증(case 1)

- 길이 1~12자, `ishan(str)`로 **한글 전용** 강제("이름은 한글로 적으셔야 합니다").
- `lowercize(str, 1)` 정규화.
- `stat(PLAYERPATH/<초성>/<이름>)`으로 파일 ctime을 읽어 `last_login[fd]`에 보관(마지막 접속시간 표시용).
- `load_ply(str, &ply_ptr) < 0`(파일 없음) → 신규로 간주, `tempstr[0]`에 이름 저장 후 생성 확인(`login,2`).
- 로드 성공 시 3중 게이트:
  1. `strcmp(str, ply->name)` 불일치 → "데이타가 손상되었습니다" disconnect.
  2. `F_ISSET(ply, SUICD)`(자살 신청 플래그) → "자살 신청한 아이디입니다" disconnect.
  3. `checkdouble(ply->name)`(동시접속 그룹 검사) → disconnect.
- 통과하면 비밀번호를 요구하고 **telnet echo off**(`255 251 1` = IAC WILL ECHO)로 입력을 가린다.

### 2.2 비밀번호 검증(case 3)

```c
if(strcmp(str, Ply[fd].ply->password)) {      /* 평문 비교 */
    pass_num[fd]++;
    if(str[0]==0 || pass_num[fd] >= 3) { log_fl(...); disconnect(fd); }
    else RETURN(fd, login, 3);                 /* 재시도 */
}
```

- **3회 실패 또는 빈 입력 → disconnect**, 실패 로그 기록.
- 성공 시: `255 252 1`(IAC WONT ECHO)로 echo 복원 → **동일 이름의 다른 fd 세션을 모두 disconnect**(중복 로그인 강제 종료, `command1.c:165`) → `free_crt` 후 `load_ply` 재로드 → `init_ply`+`init_alias` → 마지막 접속시간 출력 → `RETURN(fd, command, 1)`.

### 2.3 중복/동시접속 방어 2계층

- **동일 이름 세션**: case 3 성공 시 같은 이름의 기존 fd를 끊어 한 캐릭터당 1세션 보장.
- **`checkdouble`**(`command1.c:639`): `player/simul/<name>` 파일에 나열된 이름들 중 하나라도 접속 중(`find_who`)이면 로그인 차단. **동일 인물의 캐릭터 그룹 동시 플레이 금지**(멀티박싱 방지). "계정"이 없는 대신 이 파일이 그룹 소유권을 흉내 낸다.

---

## 3. 캐릭터 생성: `create_ply` 상태머신 (`command1.c:202`)

`param` 1~8의 순차 인터뷰:

| param | 질문 | 저장 | 검증 |
|-------|------|------|------|
| 1 | (엔터) | `creature` malloc+zero, `rom_num=1` | — |
| 2 | 성별(남자/여자) | 남자면 `PMALES` 플래그 | 접두 2바이트 매칭 |
| 3 | 직업(1~8) | `class` | 미매칭 재질문 |
| 4 | 능력치 5개 | str/dex/con/int/piety | **합 ≤ 54, 각 3~18** |
| 5 | 주무기(1~5) | `proficiency[슬롯]=1024` | 미매칭 재질문 |
| 6 | 성향(선함/악함) | 악하면 `PCHAOS` | 접두 2바이트 매칭 |
| 7 | 종족(1~8) | `race` + **종족별 능력치 보정** | 0이면 재질문 |
| 8 | 새 비밀번호 | `password`(strncpy 14B) | 3~14자 |

### 3.1 직업/종족 로컬라이제이션 매핑

직업 표시명 → Mordor enum(A7 교차참조):

| # | 표시명 | enum |
|---|--------|------|
| 1 | 자객 | ASSASSIN |
| 2 | 권법가 | BARBARIAN |
| 3 | 불제자 | CLERIC |
| 4 | 검사 | FIGHTER |
| 5 | 도술사 | MAGE |
| 6 | 무사 | PALADIN |
| 7 | 포졸 | RANGER |
| 8 | 도둑 | THIEF |

종족 표시명 → enum + 생성 시 능력치 보정:

| # | 표시명 | enum | 보정 |
|---|--------|------|------|
| 1 | 난장이족 | DWARF | str+1, piety-1 |
| 2 | 용신족 | ELF | int+2, con-1, str-1 |
| 3 | 땅귀신족 | GNOME | piety+1, str-1 |
| 4 | 요괴족 | HALFELF | int+1, con-1 |
| 5 | 거인족 | HALFGIANT | str+2, int-1, piety-1 |
| 6 | 토신족 | HOBBIT | dex+1, str-1 |
| 7 | 인간족 | HUMAN | con+1 |
| 8 | 도깨비족 | ORC | str+1, con+1, dex-1, int-1 |

### 3.2 생성 마무리(case 8)

```c
strncpy(ply->password, str, 14);              /* 평문 저장 */
strcpy(ply->name, extr->tempstr[0]);          /* case1에서 확정한 이름 */
up_level(ply);                                 /* 레벨 1 스탯 확정 */
init_ply(ply); init_alias(ply);
F_SET(ply, PLECHO); F_SET(ply, PPROMP);        /* 로컬 에코·프롬프트 기본 ON */
ply->gold = 500;                               /* 시작 골드 */
save_ply(ply->name, ply);                      /* 즉시 첫 세이브 */
```

시작 방은 `rom_num=1`(case 1에서 설정). "레벨 5 미달 시 삭제될 수 있음" 안내가 출력되지만(§6), **자동 퍼지 루틴은 세션 코드에 없다** — DM 수동 `*delete` 또는 외부 운영 작업으로 처리되는 정책성 문구다.

---

## 4. 세이브 모델

### 4.1 세이브 시점(전수)

| 시점 | 호출 경로 | 메시지 |
|------|-----------|--------|
| 로그아웃/연결끊김/idle/강퇴 | `disconnect` → `save_ply`(`io.c:866`) | 없음 |
| 이벤트(은행·거래·습득·레벨·결혼 등) | `savegame_nomsg`(30+ 호출처) | 없음 |
| 수동 `저장` 명령 | `savegame`(`global.c:323`) | "저장하였습니다." |
| 서버 종료 | `update_shutdown` → `save_all_ply`(`update.c:837`) | 종료 방송 |

**주기적(시간 기반) 자동세이브는 없다** — 검증: 20초 틱의 `update_ply`(`player.c:348`) 본문에 save 호출 부재 확인. 상태 지속의 실질 안전망은 (a) 이벤트 세이브 + (b) 5분 idle disconnect 세이브(§1.4·§6)다.

### 4.2 `save_ply` 경로 공식·원자성 (`files2.c:538`)

```c
sprintf(file, "%s/%s/%s", PLAYERPATH, first_han(str), str);   /* player/<초성>/<이름> */
sprintf(filebak, "%s~", file);
rename(file, filebak);                    /* 기존본 → 백업 */
fd = open(file, O_RDWR|O_CREAT|O_BINARY, ACC);
n = write_crt(fd, ply_ptr, 0);            /* 실패 시 백업 롤백 */
close(fd); unlink(filebak);               /* 성공 시 백업 제거 */
```

**백업-쓰기-교체** 패턴으로 쓰기 중 크래시에도 `<이름>~`가 남아 최소 복구 가능. `#ifdef COMPRESS`(LZW) 분기가 있으나 실제 빌드는 비압축(`write_crt`) — CLAUDE.md의 "LZW 복호기 불필요" 판단과 일치.

### 4.3 세이브 전 장비 정규화 (`command8.c:706`)

```c
*dum_ptr = *ply_ptr;                       /* 얕은 복제 */
for(i=0; i<MAXWEAR; i++)
    if(dum_ptr->ready[i]) {                /* 착용 슬롯 → 인벤토리로 회수 */
        obj[n++] = dum_ptr->ready[i];
        add_obj_crt(dum_ptr->ready[i], dum_ptr);
        dum_ptr->ready[i] = 0;
    }
save_ply(dum_ptr->name, dum_ptr);          /* 정규화된 복제본 저장 */
for(i=0; i<n; i++) del_obj_crt(obj[i], dum_ptr);   /* (복제본 정리) */
free(dum_ptr);
```

착용 상태를 디스크에 담지 않고 **인벤토리 참조로 flatten**해 저장한다(원본 `ply_ptr`는 착용 유지). 로드 시 `init_ply`가 재착용을 복원한다. 이식 시 "직렬화 직전 파생 상태 정규화"로 재현한다.

### 4.4 `load_ply` (`files2.c:593`)

동일 경로 공식으로 열어 `read_crt`로 역직렬화. 파일 없으면 `-1`(→ 신규 생성 트리거). `init_ply`가 로드 후 파생 상태(장비 착용·별칭·전투 캐시)를 재구성한다.

---

## 5. 계정 ↔ 캐릭터 데이터 모델

"계정"이라는 1급 객체는 **없다**. 대신 **캐릭터 이름을 키로 한 병렬 파일 집합 + 그룹 파일**이 계정 기능을 분산 수행한다:

| 경로 | 역할 | 소비처 | 교차참조 |
|------|------|--------|---------|
| `player/<초성>/<이름>` | 캐릭터 세이브(creature, password@240 평문) | `save_ply`/`load_ply` | — |
| `player/alias/<이름>` | 사용자 정의 별칭 | `init_alias`/`close_alias` | A2 |
| `player/bank/<이름>` | 은행 잔고 | `savegame_nomsg`(은행 거래) | A8 |
| `player/simul/<이름>` | 동시접속 금지 그룹 목록 | `checkdouble` | — |
| `player/family/family_member_*`, `family_list` | 가문 소속·구성원 | `edit_member` | A10 |
| `player/marriage/list` | 결혼 관계 | 결혼 시스템 | A10 |
| `player/suic/<이름>[.alias|.bank]` | 자살 graveyard(soft-delete 목적지) | `suicide` | §6 |

**초성 샤딩**: `first_han`(`command1.c:732`)이 이름 첫 음절을 KS→Johab 변환(`KStbl`)으로 **초성(ㄱ/ㄴ/…/ㅎ)** 추출 → `exam[]`으로 디렉터리명 매핑. 실제 `player/` 하위: `가 나 다 라 마 바 사 아 자 차 타 파 하` + 특수 디렉터리(`alias`/`bank`/`simul`/`family`/`marriage`/`suic`/`temp`). 한 디렉터리 엔트리 수를 줄이는 1990년대 파일시스템 최적화이며, **재설계 시 완전히 소거**(DB 인덱스로 대체) 대상이다.

**정리**: 관계는 "1 계정 : N 캐릭터"가 아니라 **"이름 = 크리덴셜 = 파일 키"의 flat namespace**이고, family/marriage/simul이 캐릭터 간 그룹 관계를 옆에서 표현한다. 재설계에서는 이를 `account`(1급) → `character`(N) 정규 모델로 승격하고 병렬 파일을 서브도큐먼트/컬렉션으로 흡수하는 것이 자연스럽다(§9).

---

## 6. 삭제·자살·저레벨 정책

### 6.1 자살(캐릭터 삭제): `suicide` (`command5.c:668`)

명령 `목매달기`(`global.c:361`) → `ply_suicide` → `suicide` 상태머신:

| param | 동작 |
|-------|------|
| 1 | 경고(적색) + 현재 비밀번호 요구, `PREADI` 세트 |
| 2 | `strcmp(password)` 일치 시 "찐짜로? (찐짜로/뻥으로)" 재확인; 불일치 시 취소 |
| 3 | "찐짜로" 정확 일치 시 삭제 실행; 아니면 취소 |

삭제 실행(case 3):
1. 가문 소속(`PFAMIL`)이면 `edit_member(..., 2)`로 가문에서 제명.
2. 전체 방송("자살신청") 후 **`disconnect(fd)`** — 이때 `save_ply`가 원 경로에 파일을 다시 쓴다.
3. `system("mv <파일> player/suic/<이름>")` ×3(캐릭터·alias·bank) — **셸 이동으로 graveyard 격리**.

물리 삭제가 아니라 이동이므로 login의 `load_ply`가 파일을 못 찾아 재로그인이 차단된다(+ `SUICD` 플래그 보조). **형상 위험**: `system()` 셸 호출 + 이름 보간은 인젝션 표면(§8·`security.md` Shell Injection Defense).

### 6.2 저레벨 삭제

생성 시 "레벨 5가 되지 않으면 아이디가 삭제될 수도 있습니다" 안내가 출력되나, **자동 퍼지 코드는 세션 계층에 없다**. DM 수동 `*delete`(`global.c:532` → `dm_delete`) 또는 외부 배치가 집행하는 운영 정책이다. 이식 시 명시적 만료 잡(cron/워커)으로 재현할지 결정 게이트에서 판단한다.

---

## 7. 텔넷 협상 / identd (형상 계층)

### 7.1 텔넷 in-band 협상

무한은 telnet IAC 시퀀스를 **비밀번호 에코 억제**에만 사용한다:

- 비밀번호 요구 직전 `255 251 1`(IAC WILL ECHO) → 클라이언트가 로컬 에코를 끔.
- 검증 직후 `255 252 1`(IAC WONT ECHO) → 에코 복원.
- 입력 경로에서 IAC(255)+DO/DONT(253/254) 프리픽스 2바이트를 폐기(`io.c:811`), CSI(155)·EUC-KR high-byte는 통과(`io.c:462`).

### 7.2 identd(`auth.c`)

- 접속마다 `vfork`+`execl`로 `auth` 바이너리 실행 → 상대 호스트의 포트 113(identd)에 `<oport> , <iport>` 질의 → `USERID` 응답 파싱(`auth.c:parse`) → `LOGPATH/auth/lookup.<pid>` 저장.
- 게임 프로세스는 `SIGCHLD`→`reap_children`(`io.c:1216`)로 파일을 읽어 `io->userid`/`io->address`를 채운다.
- **순수 텔레메트리**(접속 로깅용). 인증 결정에 관여하지 않음.

**재설계**: telnet 에코 협상·identd 조회는 전부 **형상**이다. WebSocket 핸드셰이크 + TLS + 서버측 입력 마스킹(클라이언트 `<input type=password>`)로 대체하고, identd는 폐기(현대엔 무의미)하거나 IP/UA 로깅으로 대체한다.

---

## 8. 콘텐츠(이식) vs 형상(재설계) 분류

| 항목 | 분류 | 근거·재설계 방향 |
|------|------|-----------------|
| 캐릭터 생성 인터뷰 순서·질문·검증(성별→직업→능력치54pt→무기→성향→종족→비번) | **콘텐츠** | 게임 규칙. 스텝·제약(합≤54, 3~18, 한글이름 1~12)·종족 보정 그대로 이식 |
| 직업/종족 로컬라이제이션 매핑 | **콘텐츠** | 표시명↔enum 표(§3.1) 정본 이식, A7과 정합 |
| 시작 골드 500·시작 방 1·레벨1 up_level | **콘텐츠** | 초기 상태 규칙 |
| 세이브 시점 규칙(로그아웃·이벤트·종료, 주기 없음) | **콘텐츠(의미)** | *언제* 저장하는가는 게임 의미. *어떻게*(파일 rename)는 형상 |
| 세이브 전 장비 flatten 정규화 | **콘텐츠(의미)** | 파생 상태 비직렬화 규칙은 재현, 구현은 자유 |
| Idle 300초 → 종료 | **콘텐츠** | 세션 정책. 값·동작 이식, 타이머는 JS 스케줄러 |
| 중복 로그인 강제 종료·`checkdouble` 그룹 | **콘텐츠(의미)** | 1캐릭터 1세션·멀티박싱 금지 규칙 이식 |
| 자살 이중 확인·가문 제명·재로그인 차단 | **콘텐츠** | 삭제 UX·부수효과 이식 |
| **평문 비밀번호 저장·strcmp 검증** | **형상(교체 필수)** | bcrypt/argon2 해시 + 상수시간 비교 |
| **함수 포인터 상태머신(`io->fn`)** | **형상** | 명시적 세션 FSM(상태 enum) + async 핸들러 |
| **초성 디렉터리 샤딩·병렬 파일 집합** | **형상** | MongoDB `account`/`character` 도큐먼트로 통합 |
| **telnet 에코 협상·identd** | **형상** | WebSocket+TLS 핸드셰이크, 클라이언트측 마스킹 |
| **`system("mv")` soft-delete** | **형상(보안 위험)** | DB soft-delete 플래그/TTL, 셸 호출 제거 |
| 대기열(`add_wait`/256 정원) | **형상(재검토)** | 프로세스당 fd 한계 산물. 현대엔 커넥션 풀·수평 확장으로 대체 |
| 백업-쓰기-교체 원자성 | **형상** | DB 트랜잭션/원자적 upsert |

---

## 9. 아키텍처 함의

1. **`account`를 1급 객체로 승격**. 원본의 flat "이름=크리덴셜"을 `account(_id, email?, passwordHash, createdAt)` → `character(accountId, name, class, race, stats, …)` 1:N으로 정규화한다. family/marriage/simul/alias/bank 병렬 파일은 각각 캐릭터 서브도큐먼트 또는 참조 컬렉션으로 흡수. 초성 샤딩은 소거(인덱스로 대체).

2. **인증 재설계는 최우선 보안 항목**. 평문 password(실측 "1234") → argon2id 해시 + 상수시간 비교. 무한의 "이름=한글, 비번=평문 14자" 규칙 중 **이름 규칙(한글 1~12)은 콘텐츠로 유지 가능**하나 비번 저장·전송은 전면 교체. 로그인 실패 3회 잠금은 rate-limit로 승격.

3. **세션 FSM을 명시화**. `io->fn` 함수 포인터 전이(waiting→login→create_ply→command)를 상태 enum + 핸들러 맵으로 재작성한다. `RETURN(fn, param)` 관례는 `{ state, step }` 전이로 1:1 대응되므로 이식이 기계적이다. fall-through(case -1→0) 같은 암묵 흐름은 명시 상태로 풀어 문서화한다.

4. **세이브 정책은 의미 보존 + 안전망 강화**. "주기 자동세이브 없음 + 이벤트/로그아웃 세이브"는 크래시 시 데이터 손실 위험(§1.4)이 있다. 의미(이벤트 시점 저장)는 유지하되, 이벤트 소싱/write-ahead 또는 짧은 주기 flush를 **추가**해 크래시 내성을 보강한다. 장비 flatten 정규화는 직렬화 훅으로 재현한다.

5. **`system()` 제거**. 자살 삭제의 셸 `mv`는 인젝션 표면이자 이식 불가 형상. DB `deletedAt`/`status=suicided` 플래그 + TTL 인덱스로 graveyard 의미를 재현하고, 셸 호출을 코드에서 제거한다(`security.md` Shell Injection Defense와 정합).

6. **identd·telnet 협상 폐기, WebSocket 핸드셰이크 신설**. 접속 텔레메트리는 IP/UA/타임스탬프 로깅으로 대체. 정원·대기열은 커넥션 관리 미들웨어로 재설계하되, 초기엔 단순 상한만 두고 수평 확장은 후순위.

---

## 부록: 실측 앵커

- `player/타/타이` — 1188B = `creature`(1184) + `int invcnt`(4). `name@0`="타이"(EUC-KR), `password@240`="1234"(ASCII 평문). 테스트 캐릭터 2개(`타이`, `테스토스`)만 존재.
- 초성 디렉터리 실측: `가 나 다 라 마 바 사 아 자 차 타 파 하` + `alias`·`bank`·`family`·`marriage`·`temp`(+런타임 생성 `suic`·`simul`).
- 상수: 정원 `MAXPLAYERS=256`, idle timeout `300s`, 이름 1~12자·한글, 능력치 5개 합≤54/각3~18, 비번 3~14자, 시작 골드 500, 시작 방 1, 실패 3회 잠금.
