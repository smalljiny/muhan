# A11 특수 오브젝트·스크립트 훅

**이슈**: [#11](https://github.com/smalljiny/muhan/issues/11) · **분석 대상 oracle**: `special1.c`, `sp.c`, `board.c`, `command1.c`·`command2.c`·`command9.c`, `magic1.c`, `creature.c`, `global.c`(명령 테이블), `mtype.h`(SP_/RON 상수), objmon 텍스트 자산.

## 개요

"특수 오브젝트·스크립트 훅"의 실체를 규명한다. 결론부터: **무한에는 범용 스크립팅 엔진이 없다.** 원본 Mordor의 "special routine"은 (1) 오브젝트에 붙는 4종 enum이 하드코딩 C 함수로 디스패치되고, (2) 방·몬스터에 붙는 `special`은 코드 훅이 아니라 **플래그·조건에 따라 의미가 달라지는 오버로드된 숫자 파라미터**다. 이 세 계층을 데이터(709 오브젝트·2341 방·674 몬스터 템플릿 실측)와 함께 정리한다.

## 핵심 발견 요약

1. **`special` 필드는 3개 구조체에 동명이인으로 존재한다** — `object.special`(`mstruct.h:130`), `room.special`(`:193` 계열), `creature.special`(`:193` 계열). 이름만 같고 **의미·값공간·소비처가 전부 다르다**. 하나의 "special routine 테이블"로 통합돼 있지 않다.
2. **`object.special` = 4종 enum → 하드코딩 C 루틴** (`mtype.h:553-556`): `SP_MAPSC`(1) 정적 텍스트 뷰어, `SP_COMBO`(2) 조합 자물쇠, `SP_WAR`(3), `SP_BOARD`(4) 게시판. 디스패치는 (a) 명령 테이블의 **음수 cmdno**(`command1.c:626`)와 (b) 명령 함수 내 직접 분기 두 경로.
3. **`room.special` = 게이트 파라미터** — `RONFML`(가문 전용, 값=가문 ID) 또는 `RONMAR`(부부 전용, 값=결혼 ID) 플래그가 켜졌을 때만 읽힌다. 실측 172방 중 RONFML 31·RONMAR 105가 실제로 소비, 나머지 36은 소비 플래그가 없어 **값이 inert**.
4. **`creature.special` = 소환 대상 몬스터 번호** — `MSUMMO`(61) 플래그 몬스터가 **죽을 때**(`die_perm_crt`) `summon_crt(…, special)` → `load_crt(special)`로 지정 몬스터를 소환. 674 몬스터 중 12개만 설정.
5. **텍스트 자산 연결**: `SP_MAPSC`는 오브젝트 이름(공백→`_`)으로 `../objmon/<name>` 파일을 `view_file`로 스트리밍(18줄 페이지네이션). `SP_BOARD`는 오브젝트 `type`(100~120)으로 `board_dir[]`를 인덱싱해 `MUDHOME/board/<카테고리>` 디렉터리와 연결(게시글 저장은 A10 §5).
6. **데이터 이상 2건**: `special=7` "은영단 게시판"(정의 없는 값 → examine 경로 실패, 이름 매칭 명령만 도달), `SP_WAR` 전쟁나팔(`special_obj` switch에 case 없음 → 사용 시 inert).
7. **`special1.c`가 정본, `sp.c`는 죽은 백업** — `Makefile`이 `special1.o`만 빌드(`sp.o` 미포함). 두 파일 모두 헤더가 "SPECIAL1.C"인 near-duplicate이나 `special1.c`가 최신(제우스 해킹템 탐지·실삭제 포함).

---

## 1. 세 개의 `special` 필드: 하나의 이름, 세 도메인

`special`은 `short`로 `object`·`room`·`creature` 세 구조체에 각각 존재한다(`mstruct.h:130`, room·creature struct 내 동일 이름). **공유 디스패처가 없고**, 각 도메인이 독립적으로 값을 해석한다.

| 도메인 | 값공간(실측) | 의미 | 소비처 | 트리거 |
|--------|-------------|------|--------|--------|
| `object.special` | 1~4 enum + 이상값 7 | 오브젝트 특수 동작 종류 | `special_obj`/`special_cmd`(`special1.c`), `command2.c`, `board.c` | 특정 명령(읽어·눌러·사용·게시판…) |
| `room.special` | 1~127 | 가문 ID(RONFML) 또는 결혼 ID(RONMAR) | `command2.c:530`·`command6.c:274`·`command10.c:205`, `player.c:115`, `magic5.c:204` | 방 진입·초대장 검사 |
| `creature.special` | 1~609 | 소환할 몬스터 번호 | `summon_crt`(`creature.c:821`) | 몬스터 사망(`die_perm_crt`, MSUMMO) |

실측 분포:
- 오브젝트 709종 중 special≠0: **SP_MAPSC 27 / SP_COMBO 30 / SP_WAR 1 / SP_BOARD 17 / (이상값 7) 1 = 76종**.
- 방 2341종 중 special≠0: **172방**.
- 몬스터 674종 중 special≠0: **12마리**.

**결론**: "special routine"이라는 이름이 코드 훅을 연상시키지만, 실제로는 하드코딩 동작(오브젝트)과 데이터 파라미터(방·몬스터)의 혼재다. 이식 시 세 도메인을 **별개 개념**으로 분리해야 한다.

---

## 2. `object.special`: 4종 enum → 하드코딩 C 루틴

```c
/* mtype.h:553-556 */
#define SP_MAPSC  1   /* Map or scroll  — 정적 텍스트 */
#define SP_COMBO  2   /* Combination lock — 조합 자물쇠 */
#define SP_WAR    3   /* 전쟁 아이템 */
#define SP_BOARD  4   /* 게시판 */
```

### 2.1 디스패치 두 경로

**경로 A — 음수 cmdno(`special_cmd`)**: 명령 테이블(`global.c`) 엔트리의 `cmdno`가 음수면 special 명령이다. `command1.c:626`이 이를 감지:

```c
if(cmdlist[cmdno].cmdno < 0)
    return(special_cmd(Ply[fd].ply, 0-cmdlist[cmdno].cmdno, cmnd));
```

즉 `cmdno = -N` → `special_cmd(ply, N, cmnd)`. 실측 매핑:

| 명령어 | cmdno | → special | 동작 |
|--------|-------|-----------|------|
| `눌러` / `밀어` | -2 | SP_COMBO | 조합 자물쇠 누르기 |
| `@` | -1 | SP_MAPSC | 지도·두루마기 열람 |

`special_cmd`(`special1.c:91`)는 `SP_MAPSC`·`SP_COMBO`만 처리하고, 인자(`cmnd->num≥2`)를 확인한 뒤 `special_obj`(`special1.c:24`)로 위임한다.

**경로 B — 명령 함수 내 직접 분기**: 일반 명령 함수가 대상 오브젝트의 `special`을 직접 검사해 `special_obj`를 호출한다.

| 호출처 | 조건 | 처리 |
|--------|------|------|
| `command2.c:110`(살펴/읽기) | `special==SP_BOARD` | `list_board` (게시판) |
| `command2.c:117` | `special≠0` | `special_obj(…, SP_MAPSC)` |
| `magic1.c:405`(`읽어`→`readscroll`) | `special≠0` | `special_obj(…, SP_MAPSC)` 후 주문 학습 |
| `command9.c:517`(`사용`) | `special==SP_WAR` | `special_obj(…, SP_WAR)` |

`special_obj`는 인벤토리→장비→방 순으로 오브젝트를 찾고(`SP_INVENTORY/EQUIPMENT/ROOM`), `obj->special != 요청 special`이면 `-2`(불일치)를 반환한다. 이 `-2` 관례로 호출자는 "이 오브젝트는 내 special이 아님"을 구분해 다음 처리로 넘어간다.

### 2.2 SP_MAPSC: 정적 텍스트 뷰어

```c
/* special1.c:70 */
case SP_MAPSC:
    strcpy(str, obj_ptr->name);
    for(i=0; i<strlen(str); i++)
        if(str[i] == ' ') str[i] = '_';       /* 공백 → 밑줄 */
    sprintf(str2, "%s/%s", OBJPATH, str);      /* OBJPATH="../objmon" (mtype.h:44) */
    view_file(fd, 1, str2);
    return(DOPROMPT);
```

오브젝트 이름을 파일명으로 변환(공백→`_`)해 `../objmon/<name>` 파일을 연다. `view_file`(`misc.c:332`)은 파일을 열어 **18줄 단위로 페이지네이션**하며 스트리밍한다. 한글 이름도 그대로 적용 — `중간계 지도`→`중간계_지도`, `보물지도`, `표지판` 등 실제 objmon 파일과 일치. 이것이 **표지판·지도·두루마기·안내서**의 본문 연결 방식이다(콘텐츠는 파일, 메커니즘은 파일 뷰어).

### 2.3 SP_COMBO: 조합 자물쇠 → 출구 개방/피해

```c
/* special1.c:124 combo_box */
str[0] = obj_ptr->sdice + '0';                 /* 이 단추가 입력하는 숫자 = sdice */
/* ndice==1 이면 시퀀스 리셋, 아니면 누적(tempstr[3]) */
...
if(len(입력) >= len(obj->use_output)) {
    if(입력 != use_output) { dmg=mrand(20,40); hpcur-=dmg; ... }   /* 오답: 20~40 피해 */
    else {
        /* 정답: pdice번째 출구의 XLOCKD·XCLOSD 해제 */
        for(i=1, xp=rom->first_ext; xp && i<obj->pdice; i++, xp=xp->next_tag);
        F_CLR(xp->ext, XLOCKD); F_CLR(xp->ext, XCLOSD);
    }
}
```

**필드 재사용(오버로드)**이 핵심이다 — 단추 오브젝트는 전투 스탯 필드를 조합 자물쇠 파라미터로 전용한다:

| object 필드 | 조합 자물쇠에서의 의미 |
|-------------|------------------------|
| `sdice` | 이 단추가 입력하는 **숫자**(한 자리) |
| `ndice` | 1이면 시퀀스 **리셋**(첫 단추), 그 외 누적 |
| `use_output` | **정답 조합** 문자열 (예 `"357"`) |
| `pdice` | 정답 시 여는 **방 출구 인덱스**(1-기준) |

플레이어별 입력 시퀀스는 `Ply[fd].extr->tempstr[3]`(휘발성 세션 버퍼)에 누적. 오답이면 20~40 피해(HP 0 이하 시 사망), 정답이면 방의 N번째 출구 잠금·닫힘 해제. 실측 SP_COMBO 오브젝트 30개 = 색깔·보석 단추(회색·붉은·루비·다이아몬드 단추 등) — 한 방에 여러 단추를 배치해 코드 잠금 퍼즐을 구성.

### 2.4 SP_BOARD: 게시판 오브젝트

```c
/* command2.c:110 (살펴/읽기 명령) */
if(obj_ptr->special==SP_BOARD) {
    board_obj[fd]=obj_ptr;      /* 세션에 현재 게시판 오브젝트 저장 */
    list_board(fd,0,"");
    return(DOPROMPT);
}
```

`board.c`의 `board_dir[]`(`board.c:36`)가 오브젝트 `type` 필드로 인덱싱된다:

```c
/* board.c:110 */
if(board_dir[i].num == board_obj[fd]->type) …   /* obj->type == board_dir.num */
```

| obj `type` | 디렉터리 | 용도 |
|-----------|----------|------|
| 100 | `board/info` | 공지 |
| 101~115 | `board/family1`~`family15` | 가문별 |
| 116 | `board/family` | 가문 일반 |
| 120 | `board/user` | 유저 |

즉 **SP_BOARD 오브젝트 = 게시판 카테고리 선택자**이며, 실제 게시글은 objmon이 아니라 `MUDHOME/board/<카테고리>/`의 `board_index`(`struct BOARD_INDEX` 배열, `board.c:32`)와 `board.<N>` 파일에 저장된다. 게시·읽기·삭제 흐름과 소셜 권한은 **A10 §5**에서 상세히 다뤘으므로 여기서는 오브젝트 부착 메커니즘만 기록한다. 실측 SP_BOARD 오브젝트 17종(무한대전·관리용·가문별 게시판 등).

또 다른 진입점 `게시판` 명령(`global.c:383`→`look_board`, `board.c:66`)은 방에서 이름 `"게시판"`으로 오브젝트를 찾아 동일하게 `board_obj[fd]` 설정 후 `list_board`. **이름 매칭 경로이므로 `special` 값을 검사하지 않는다** — 아래 2.6의 이상값 보드가 여기로는 도달한다.

### 2.5 SP_WAR: `special_obj` 상 inert

`command9.c:517`이 `사용` 명령에서 `special==SP_WAR` 오브젝트를 `special_obj(…, SP_WAR)`로 넘기지만, `special_obj`의 switch(`special1.c:69`)에는 **SP_WAR case가 없다** → `default`("아무것도 없습니다."). 즉 **전쟁나팔(SP_WAR, 1종)을 사용해도 실질 효과가 없다.** 

실제 패거리 전쟁 메커니즘은 별개다 — `선전포고` 명령(`global.c:353`→`call_war`, `special1.c:181`)이 담당하며, **아이템과 무관**하게 `PFMBOS`(패거리 두목) 플래그와 `daily[DL_EXPND].max`(소속 가문)를 게이트로 쓴다. `call_war`는 전역 상태 `AT_WAR`/`CALLWAR1`/`CALLWAR2`로 선전포고→수락 2단계 핸드셰이크를 구현(`broadcast_all`로 전 서버 공지). SP_WAR 아이템은 두목 지위의 상징적 소품일 뿐 코드 경로에 관여하지 않는다.

### 2.6 데이터 이상: `special=7` 은영단 게시판

실측 오브젝트 중 `special=7`(정의 없는 값) 1종 = "은영단 게시판"(`type=107`). 정의된 SP_ enum(1~4)이 아니므로:
- **examine/읽기 경로 실패**: `command2.c` — `special==SP_BOARD(4)`? 아니오 → `special≠0`? 예 → `special_obj(…,SP_MAPSC)` → `obj->special(7)≠SP_MAPSC(1)` → `-2` 반환 → 게시판으로 인식 안 됨, 일반 설명만 출력.
- **이름 기반 명령은 도달**: `게시판` 명령(`look_board`)은 이름 `"게시판"`으로 찾고 `special`을 검사하지 않으므로 정상 작동. 단 삭제(`del_board`, `board.c:411`)는 `special!=SP_BOARD` 거부.

정리: "완전히 깨진 보드"가 아니라 **examine 디스패치는 실패, 이름 기반 게시판 명령은 도달**하는 부분 손상. 데이터 입력 오류(4→7)로 판단. 이식 시 정정 대상.

---

## 3. 트리거 카탈로그 (명령 → special)

`object.special` 동작을 유발하는 명령 전체(oracle 명령 테이블 `global.c` 기준):

| 명령어 | oracle | 대상 special | 동작 |
|--------|--------|-------------|------|
| `살펴`/`읽기`(오브젝트) | `command2.c:110`,`:117` | SP_BOARD → 게시판, 그 외 → SP_MAPSC 텍스트 | 열람 |
| `읽어` | `global.c:310`→`readscroll`(`magic1.c:405`) | SP_MAPSC 텍스트 후 주문 학습 | 두루마기 |
| `@` | `global.c:634`(-1) | SP_MAPSC | 지도·문서 |
| `눌러`/`밀어` | `global.c:555-556`(-2) | SP_COMBO | 조합 자물쇠 |
| `사용` | `command9.c:517` | SP_WAR(inert) | — |
| `게시판` | `global.c:383`→`look_board` | (이름 매칭, special 미검사) | 게시판 |
| `선전포고` | `global.c:353`→`call_war` | (아이템 무관) | 패거리 전쟁 |

**주문 학습 연계**(`readscroll`, `magic1.c`): SCROLL 타입 오브젝트를 `읽어`로 읽으면 SP_MAPSC 텍스트를 먼저 보여주고, 이어 주문서 학습 로직 실행 — `ndice`(요구 레벨) 검사, 정렬 불일치 시 두루마기 소멸(`OGOODO`/`OEVILO` + alignment), 직업 금서(`OCLSEL`), `RNOMAG` 방 차단, `LT_READS` 쿨다운(3초) 후 `magicpower-1` 인덱스 주문 습득. 이 부분은 A6(마법)와 경계 — 여기서는 SP_MAPSC 훅이 주문서 열람의 진입점이라는 사실만 기록.

---

## 4. `room.special`: 플래그 종속 게이트 파라미터

`room.special`은 **코드 훅이 아니라 접근 제어 파라미터**다. 특정 방 플래그가 켜졌을 때만 읽히고, 플래그에 따라 의미가 달라진다.

```c
/* command2.c:530 — 가문 전용 방 */
else if(ply_ptr->class < DM && F_ISSET(rom_ptr, RONFML)     /* RONFML=38 */
        && (ply_ptr->daily[DL_EXPND].max != rom_ptr->special)) {
    /* 소속 가문(DL_EXPND) ≠ 방의 special(가문 ID) → 진입 거부/초대장 검사 */
    sprintf(file, "%s/invite/invite_%d", PLAYERPATH, rom_ptr->special);
    …
}
/* player.c:115 — 부부 전용 방: RONMAR(40) + special(결혼 ID) 대조 */
```

실측 172 special 방을 소비 플래그로 분류(`F_ISSET` 비트 해석, `mtype.h:566`):

| 소비 플래그 | 방 수 | `special` 의미 | 값 범위(실측) |
|-------------|-------|----------------|---------------|
| `RONFML`(38, 가문 전용) | 31 | 가문 ID | 1~15 (15개 가문과 정합) |
| `RONMAR`(40, 부부 전용) | 105 | 결혼(부부) ID | 1~127 (63개 distinct) |
| 없음 (inert) | 36 | — | 값이 소비되지 않음 |

- **RONFML 31방**: 가문 아지트. 소속 가문 번호(`daily[DL_EXPND].max`)가 방 `special`과 같아야 진입, 아니면 `player/invite/invite_<special>` 초대 목록을 검사(`command6.c:280`, `command10.c:205`도 동일 패턴 — 각각 다른 진입 명령/텔레포트 경로).
- **RONMAR 105방**: 부부 개인 방. 플레이어의 결혼 ID가 방 `special`과 같아야 진입(`player.c:115`, `magic5.c:434`).
- **inert 36방**: `special`이 설정됐으나 RONFML·RONMAR **어느 것도 없다** → 값이 어떤 코드에서도 읽히지 않는 죽은 데이터(예: `거실`·`낭인 회의실`·`암흑성`). 일부는 `RFAMIL`(37, 패거리존 표식)만 있으나 `RFAMIL`은 `special`을 소비하지 않는다.

**범위 주의**: 방의 함정은 `room.special`이 아니라 별도 필드 `room.trap`/`room.trapexit`(`mstruct.h`)에 있으며 **A4(이동·방) 범위**다 — 본 분석 누락이 아니라 도메인 분리.

**결론**: `room.special`은 단일 의미가 아니라 **"어떤 플래그와 함께 있느냐"로 의미가 정해지는 오버로드 필드**다. 실측상 3분의 2(136/172)만 실제로 소비된다.

---

## 5. `creature.special`: 죽음 트리거 소환 대상

`creature.special`은 오직 한 곳에서 소비된다 — **소환할 몬스터의 템플릿 번호**.

```c
/* creature.c:611 — die_perm_crt(몬스터 사망 핸들러) 내부 */
if(F_ISSET(crt_ptr, MSUMMO)) {            /* MSUMMO=61 (mtype.h:472) */
    summon_crt(ply_ptr, crt_ptr, crt_ptr->special);
}
/* creature.c:821 summon_crt(ply_ptr, sum_ptr, num) */
load_crt(num, &crt_ptr);                  /* num == special == 소환할 몬스터 번호 */
/* … 소환된 몬스터를 방에 배치, carry 아이템·골드 랜덤 부여 */
```

- **트리거**: `die_perm_crt`(`creature.c:553`)는 permanent/퀘스트 몬스터가 **죽을 때** 호출(`creature.c:319`·`:648`, `command2.c:616`, `room.c:922`). 같은 핸들러가 퀘스트 완료 크레딧도 부여.
- **게이트**: `MSUMMO` 플래그.
- **파라미터**: `special` = `load_crt`에 넘길 몬스터 템플릿 번호. 실측 12마리(값 1·2·97·99·100·101·102·264·601·603·604·609) — "죽으면 다른 몬스터를 불러내는" 보스류 연출.

`creature.special`도 방과 마찬가지로 **코드 훅이 아니라 숫자 파라미터**(소환 대상)다. 트리거 자체(사망 이벤트)는 엔진에 하드코딩돼 있고, `special`은 그 하드코딩 동작의 인자만 제공한다.

---

## 6. 텍스트 자산 인벤토리 (objmon)와 이슈 "166" 재집계

**이슈 추정치 "본문 166개"는 실측과 다르다.** objmon 실측:

| 분류 | 수 | 설명 |
|------|----|------|
| 바이너리 템플릿 `m##`·`o##` | 25 (13+12) | 몬스터·오브젝트 고정크기 구조체 배열(텍스트 아님) |
| 정적 텍스트 자산(최상위) | 57 | SP_MAPSC 본문 후보(표지판·지도·두루마기·안내서·규칙 등) + `.tmp`/`.save`/`.2` 백업 |
| `ddesc/` 죽음 묘사 | 15 | 몬스터 사망 시 출력 텍스트(제우스·마왕 등, special과 무관) |

- `find objmon -type f` = 192(하위 디렉터리 포함), 최상위 파일 82. 어느 집계로도 **166에 도달하지 않는다** → 이슈 숫자는 추정 오차로 판단.
- `special` 필드가 설정된 **오브젝트 템플릿은 76종**(§1 실측: 27+30+1+17+1). 이 중 텍스트 파일과 직접 연결되는 것은 SP_MAPSC 27종(파일명 = 오브젝트명 공백→`_`).
- **정정 기록**: 실측 = 정적 텍스트 57 + ddesc 15 = 72 텍스트 파일, special 오브젝트 76종. 이식 시 이 실측치를 정본으로 삼는다.

SP_MAPSC 오브젝트명↔파일명 매핑 예: `중간계 지도`→`중간계_지도`, `보물지도`→`보물지도`, `표지판`→`표지판`, `종족 소개서`→`종족_소개서`. 파일이 없으면 `view_file`이 "화일을 읽을 수 없습니다." 출력.

---

## 7. `check_item`/`is_bad_item`: 로그인 무결성 스윕 (anti-cheat)

`special1.c`에는 특수 오브젝트와 별개의 **anti-cheat/anti-dupe 스윕**이 있다(트리거: `command1.c:140`, 로그인 암호 입력 단계 `case 3`에서 매 접속마다 실행).

```c
/* special1.c:344 is_bad_item — "비정상" 판정 임계값 */
strncmp(name,"제우스",6)==0            → 해킹 명명 아이템
armor > 50                             → 비정상 방어력
ndice*sdice+pdice > 100                → 비정상 공격력
OCONTN && shotsmax > 20                → 비정상 용량 보따리
OSPECI && pdice == 4                   → 이상 special 조합
type==POTION && shotscur > 500         → 물약 과다 사용회수
shotscur > 1000 || shotsmax > 1000     → 사용회수 초과
```

`check_item`(`special1.c:258`)은 장비(`ready[]`)·인벤토리·컨테이너(`check_contain`)·은행(`load_bank`)을 순회하며 `is_bad_item` 판정. `shotsmax>4999`인 극단 아이템은 **즉시 삭제 후 세이브**하고 나머지는 로그(`log_pl`)만 남긴다. 목적은 오버플로 조작·아이템 복제·해킹템 유입 차단.

**형상/콘텐츠 분류**: 스윕 메커니즘(로그인 훅·순회·삭제)은 **형상(재설계)** — 신규 스택에선 서버측 스키마 검증·불변 아이템 정의로 대체. 임계값(제우스명·armor>50·공격력>100 등)은 **anti-cheat 지식**으로 보존(원본 밸런스 상한의 힌트).

---

## 8. `special1.c` vs `sp.c`: 빌드 대상 판별

두 파일은 헤더가 모두 "SPECIAL1.C"인 near-duplicate다. **`Makefile`(`src/Makefile:20`)이 `special1.o`만 링크하고 `sp.o`는 포함하지 않는다.** 차이:

| 항목 | `special1.c` (빌드됨/정본) | `sp.c` (미빌드/죽은 백업) |
|------|--------------------------|--------------------------|
| `is_bad_item` | 제우스 해킹템 탐지 포함, `log_pl` | 제우스 없음, `log_dm`, 임계값 일부 다름(shotscur>50) |
| `check_item` | 실제 삭제(`del_obj_crt`)·은행 검사 | 삭제 주석 처리(no-op `free_obj2`) |

**oracle 참조 시 `special1.c`를 정본으로 사용.** `sp.c`는 이식 대상에서 제외(과거 버전).

---

## 콘텐츠(이식) vs 형상(재설계) 분류

| 항목 | 분류 | 근거·이식 방침 |
|------|------|----------------|
| SP_ enum 4종 의미(지도·자물쇠·전쟁·게시판) | **콘텐츠** | 게임 규칙. 그대로 이식 |
| SP_COMBO 필드 재사용(sdice/ndice/use_output/pdice) | **콘텐츠(규칙)** | 조합·출구·피해 규칙 이식, 필드 오버로드는 명시적 스키마로 정규화 |
| SP_MAPSC 텍스트 본문(57 파일) | **콘텐츠** | 본문 자산 이식. 파일→DB 문서 |
| ddesc 죽음 묘사(15) | **콘텐츠** | 텍스트 자산 이식 |
| 음수 cmdno·`-2` 반환 관례 디스패치 | **형상** | 명령→핸들러 매핑으로 재설계(명시적 special handler 등록) |
| `view_file` 18줄 페이지네이션 | **형상** | telnet 페이저 → 웹 UI 스크롤/모달 |
| `tempstr[3]` 세션 조합 버퍼 | **형상** | 서버측 세션 상태 객체 |
| SP_BOARD `board_dir`·파일 저장 | **형상** | 디렉터리·index 파일 → DB 컬렉션(A10 §5) |
| `room.special` = 가문/결혼 ID 게이트 | **콘텐츠(규칙)** | 접근 제어 규칙 이식. 단 "오버로드 필드"를 별도 필드(`familyId`/`marriageId`)로 분리 |
| `creature.special` = 소환 대상 번호 | **콘텐츠(규칙)** | 사망 시 소환 규칙 이식. 명시적 `summonMonsterId` 필드로 |
| `check_item`/`is_bad_item` 스윕 | **형상** | 로그인 훅 → 스키마 검증·불변 정의 |
| is_bad_item 임계값 | **anti-cheat 지식** | 밸런스 상한 힌트로 보존 |
| SP_WAR inert·special=7 이상 | **버그(정정)** | 이식 시 정정(전쟁나팔 효과 정의 or 제거, 7→4) |
| `sp.c` | **제외** | 죽은 백업 |

---

## 아키텍처 함의

1. **"스크립트 훅" 추상은 과대 명칭이다.** 무한에는 이벤트→스크립트 바인딩 시스템이 없다. 특수 동작은 (a) enum→C함수 하드코딩, (b) 데이터 필드 파라미터의 두 가지뿐. 신규 스택에서 **범용 스크립팅 엔진을 도입할지는 결정 게이트 사항**이나, 원본 재현만으로는 불필요 — 유한한 special handler 레지스트리로 충분하다.

2. **`special` 필드를 3개 명시적 개념으로 분리한다.** 하나의 `short special`을 오브젝트/방/몬스터에서 재사용한 것은 32비트 구조체 절약 관행. 신규 스키마에서는:
   - object: `special: { kind: 'mapsc'|'combo'|'board'|'war', params }`(태그드 유니온)
   - room: `access: { familyId? , marriageId? }`(RONFML/RONMAR 플래그와 값을 통합)
   - creature: `onDeathSummon?: monsterId`
   오버로드된 전투 스탯 필드(sdice/ndice/pdice/use_output)도 SP_COMBO에선 조합 파라미터로 **정규 필드 승격**.

3. **special handler는 명령 디스패처의 확장점으로 설계**한다. 음수 cmdno·`-2` 반환 같은 C 관용구 대신, 명령→핸들러 매핑 테이블에 special handler를 1급 등록. `읽어`·`눌러`·`사용` 등 명령이 대상 오브젝트의 `special.kind`를 보고 핸들러를 라우팅.

4. **텍스트 자산은 콘텐츠 파이프라인으로.** SP_MAPSC 본문 57개·ddesc 15개는 objmon 파일에서 DB 문서로 이관하되, 오브젝트명↔본문 연결을 **참조 키**(파일명 규칙 대신 명시 ID)로 재설계. 페이지네이션은 UI 레이어.

5. **무결성 검증을 서버 계층으로 승격.** 로그인 시 `check_item` 스윕은 클라이언트 신뢰가 낮던 telnet 시절의 방어. 신규 스택은 아이템 생성·거래 시점의 서버측 불변식 검증으로 대체하고, is_bad_item 임계값은 밸런스 상한 참조로 남긴다.

6. **데이터 정합성 게이트 필요.** special=7 보드·SP_WAR inert 같은 데이터 이상은 변환 파이프라인(`convertWorld.js`)에 **special 값 유효성 검사**(정의된 enum·플래그-값 정합)를 추가해 이식 시점에 검출·정정한다.

---

## 부록: oracle 참조 인덱스

- **SP_ 상수·플래그**: `mtype.h:44`(OBJPATH), `:472`(MSUMMO), `:500`(OUSEFL), `:553-556`(SP_*), `:566`(F_ISSET), `:337-341`(RFAMIL/RONFML/RONMAR/RMARRI)
- **object special**: `special1.c:24`(special_obj)·`:91`(special_cmd)·`:124`(combo_box); `command1.c:626`(음수 cmdno); `command2.c:110`·`:117`; `command9.c:517`; `magic1.c:405`; `global.c:310`·`353`·`383`·`555-556`·`634`
- **board**: `board.c:32`(BOARD_INDEX)·`:36`(board_dir)·`:66`(look_board)·`:94`(list_board)·`:110`(type 매칭)
- **room special**: `command2.c:530`·`command6.c:274`·`command10.c:205`(RONFML); `player.c:115`·`magic5.c:434`(RONMAR); `dm3.c:77`(설정)
- **creature special**: `creature.c:553`(die_perm_crt)·`:611`(MSUMMO 소환)·`:821`(summon_crt)
- **war/integrity**: `special1.c:181`(call_war)·`:258`(check_item)·`:344`(is_bad_item); `command1.c:140`(로그인 트리거)
- **텍스트 뷰어**: `misc.c:332`(view_file)
- **빌드**: `src/Makefile:20`(special1.o, sp.o 제외)
- **실측 데이터**: `data/world/objects.json`(709종), `rooms.json`(2341종), `creatures.json`(674종)
