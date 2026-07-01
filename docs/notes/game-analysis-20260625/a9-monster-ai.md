# A9 몬스터 AI·스폰·리스폰

> 무한의 몬스터가 oracle에서 *무엇을 하는지* — 언제 시뮬레이션되고(active 리스트), 어떻게 세계에 등장하며(스폰 3계층), 매 틱 무엇을 판단하고(update_active AI), 누구를 노리며(어그로), 어떻게 대화·도주하는지를 규명한다. 공격성·배회·재생·어그로 타깃 선택·리스폰 주기·대화 규칙은 게임 규칙이므로 충실히 이식하고, `first_active` 단일 연결 리스트·`time(0)` 초 단위 폴링·`perm_mon` lasttime 배열·하드코딩 침공 좌표·데드 스캐폴드(몬스터 도주·주기 발화)는 형상이므로 자유롭게 재설계한다. 이슈 #9. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)의 `update.c`·`creature.c`·`room.c`·`player.c`·`command8.c`. 코드 이식이 아니라 동작 추출.
>
> **oracle 읽기 주의**: 하네스 `grep` 래퍼가 `-I`(binary skip)를 붙여 EUC-KR 파일을 스킵한다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`로 우회한다([[muhan-oracle-toolchain]]).
>
> **전투·경제 공식은 재유도하지 않는다**: 몬스터 명중(`thaco − armor/8`)·데미지(`mdice`)·경험치 분배·gold 드롭은 [[a5-combat]]와 [[a8-items-economy]]에 확정돼 있다. 본 노트는 그 공식을 *언제·어떤 조건에서* 몬스터가 발동하는지(AI 결정 축)만 다루고, 수치 유도는 참조로 넘긴다. 방 입장·이동 규칙은 [[a4-movement-rooms]] 소관이다.
>
> **이동 연동 행동은 a4 소관**: MFOLLO(공격자 추종)·MBLOCK(출구 차단)·MPGUAR(수동 출구 감시)는 몬스터 행동이지만 `update_active` AI 틱이 아니라 플레이어 이동 코드에서 트리거되므로 [[a4-movement-rooms]]에서 다룬다. 본 노트의 "배회"는 스폰 진입(wander-in)과 확률 퇴장(wander-out, §10)을 뜻하며, 몬스터의 자율 방-이동은 데드 `check_for_flee`(§6)를 빼면 없다.

## 개요

무한의 몬스터 AI는 **단일 함수 `update_active`**(update.c:229)에 응축돼 있다. 게임 루프([[a1-runtime-loop]])가 `update_game`을 매 초 호출하고, 그 안에서 여러 하위 업데이트가 각자의 주기로 발동한다. 몬스터 관련은 넷이다: `update_active`(매 초, AI 틱), `update_random`(20초, 배회 진입), `update_monster`/`update_monster_two`(4000·5000초, 침공 이벤트), 그리고 방 입장 시 트리거되는 `add_permcrt_rom`(고정 몬스터 리스폰).

핵심 아키텍처는 **active 리스트**다. 세계의 모든 몬스터를 매 틱 순회하지 않는다 — **플레이어가 있는 방의 몬스터만** `first_active` 연결 리스트에 등록해 시뮬레이션하고, 방이 비면 즉시 리스트에서 제거한다. 이것이 1993년 32비트 단일 프로세스에서 대규모 월드를 돌린 성능 트릭이며, 신규 스택에서 "플레이어 근접 시뮬레이션"으로 재설계할 대상이다.

몬스터의 세계 등장(스폰)은 **세 개의 독립 트리거 모델**로 갈린다. ① **perm_mon(고정 몬스터)** — 방마다 `perm_mon[10]` 슬롯에 "이 방에 항상 있어야 할 몬스터"를 정의하고, **플레이어가 방에 들어올 때** 리젠 여부를 검사한다(entry-driven, lazy). ② **random(배회 몬스터)** — 방마다 `random[10]` 후보와 `traffic` 확률을 두고, **20초 폴링**으로 플레이어 점유 방에 확률적으로 진입시킨다(polled). ③ **invasion(침공 이벤트)** — 하드코딩된 방/몬스터 번호 범위에 **4000·5000초 폴링**으로 대량 스폰하고 전역 방송한다(scripted polled).

몬스터 AI 틱(`update_active`)은 각 active 몬스터에 대해: **공격 타이머**(민첩에 따라 2~3초) 게이트 → 상태이상 해제·**재생**(HP/MP) → **scavenge**(바닥 아이템 줍기) → **wander-out**(적 없으면 확률적 소멸) → **전투**(적 리스트 처리: 주문/근접, breath/드레인/상태이상/아이템 파괴) → **어그로**(적 없는 공격형 몬스터가 타깃 선정). 타깃은 **piety(신앙심) 역가중 랜덤** — 신앙심 낮은 플레이어가 더 자주 표적이 된다.

핵심 분리: **공격성 3종(MAGGRE/MGAGGR/MEAGGR)·piety 역가중 타깃·정렬/레벨 필터·재생율(HP hpmax/10·MP mpmax/6 per 60초)·공격 주기(민첩 2~3초)·scavenge 15%/20초·배회 확률=traffic·리스폰 주기(사망 게이트)·스폰 그룹 크기·breath/드레인/상태이상 발동율·어그로 리스트 회전·대화 응답·charm/소환 규칙은 콘텐츠**(충실히 이식), **first_active 단일 리스트·add/del malloc·time(0) 초 폴링·perm_mon lasttime 배열·하드코딩 침공 좌표(방 8000~8300·3601~3630, 몹 732~755·265~299)·데드 스캐폴드(check_for_flee·talkbuf·MSAYTLK)·goto·add_enm_crt 주석-코드 불일치는 형상**(재설계).

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **active 리스트 = 플레이어 근접 시뮬레이션.** `first_active` 단일 연결 리스트에 등록된 몬스터만 매 초 `update_active`가 순회. 방에 플레이어 진입 시 방 몬스터 전원 `add_active`, 방이 비면(`!rom_ptr->first_ply`) 즉시 `del_active` | 형상(스케줄링) |
| 2 | **스폰 트리거 3모델.** ① perm_mon=**입장 구동**(add_ply_rom→add_permcrt_rom, lazy) ② random=**폴링 20초**(p=traffic) ③ invasion=**폴링 4000·5000초**(하드코딩 좌표) | 콘텐츠(규칙)/형상(트리거) |
| 3 | **리스폰 = 사망 게이트 + 입장 재검사.** `perm_mon[i]`={interval,ltime,misc}. 사망 시 `die_perm_crt`가 `ltime=사망시각` 세팅, 다음 입장 때 `ltime+interval ≤ 현재`면 재스폰. 스케줄러가 아니라 lazy 검사 | 콘텐츠(주기)/형상(구현) |
| 4 | **어그로 타깃 = piety 역가중 랜덤.** `lowest_piety`(MAGGRE)=Σmax(1,25−piety) 가중, `low_piety_alg`(MGAGGR/MEAGGR)=Σmax(1,30−piety) + 정렬 필터(±100) + 레벨 필터(첫 루프만, §4.2 비대칭). 신앙심 낮을수록 표적 확률↑ | 콘텐츠(공식) |
| 5 | **공격성 3종.** MAGGRE(무차별)·MGAGGR(선한 유저 공격, alg=−1)·MEAGGR(악한 유저 공격, alg=1). 정렬-공격형은 레벨 티어로 표적을 편향(저렙 가중치 배제)하나 **선택 루프엔 레벨 필터가 없어 저렙 완전 배제는 보장 안 됨(원본 비대칭)**. 민첩 높은 유저는 30% 초기 회피 | 콘텐츠(규칙)/형상(비대칭) |
| 6 | **적 리스트 = `first_enm` etag 큐, END append.** 주석은 "front 추가"라지만 코드는 tail append(주석-코드 불일치). `first_enm`=주 타깃 유지, 나머지 auto-counterattack. 타깃 이탈 시 `end_enm_crt`로 큐 뒤로 회전 | 콘텐츠(규칙)/형상(불일치) |
| 7 | **AI 틱 게이트 = LT_ATTCK 타이머.** 민첩<20 → interval 3초, 아니면 2초. 타이머 미도래면 스킵. 매 초 루프지만 몬스터별 행동은 2~3초 간격 | 콘텐츠(주기)/형상(폴링) |
| 8 | **재생.** LT_HEALS 60초마다 HP += max(1,hpmax/10), MP += max(1,mpmax/6). while 루프로 밀린 만큼 소급 적용 | 콘텐츠(율) |
| 9 | **scavenge (MSCAVE).** 20초↑ 경과 & 15% & 바닥 첫 아이템이 ONOTAK/OSCENE/OHIDDN/OPERM2/OPERMT 아니면 줍고 MHASSC 세팅 | 콘텐츠(행동) |
| 10 | **wander-out.** MHASSC/MPERMT/MDMFOL 아니고 20초↑ & mrand≤traffic & 적 없으면 "방황하고 있습니다" 방송 후 `free_crt` 소멸. 배회 몬스터의 자연 퇴장 | 콘텐츠(행동)/형상(free) |
| 11 | **주문 시전.** MMAGIC & mrand(1,100)≤n (n=20, MMAGIO면 proficiency[0]) → `crt_spell`이 알려진 스펠 최대 10개 중 랜덤 시전([[a6-magic]] spllist) | 콘텐츠(규칙) |
| 12 | **특수 공격.** breath(MBRETH, ~13%: 침/악취·독/냉기/화염 4변종)·경험치 드레인(MENEDR 10%)·독(MPOISS 15%)·질병(MDISEA 10%)·실명(MBLNDR 10%)·아이템 용해(MDISIT 15%) | 콘텐츠(행동) |
| 13 | **아이템 파괴 (피격 시).** `choose_item`이 착용 아이템(WIELD·HELD 제외) 랜덤 선택 → `shotscur--`, 0 되면 "산산히 부서져" 제거 후 `compute_ac` | 콘텐츠(규칙) |
| 14 | **몬스터 도주 = 완전 비활성.** `check_for_flee` 첫 줄 `return;`로 no-op(데드). MFLEER는 데드 함수 내부와 DM 표시 문자열에만 등장. 도주는 **플레이어 전용**(PWIMPY hpcur≤WIMPYVALUE / PFEARS 확률) | 콘텐츠(as-shipped)/형상(데드) |
| 15 | **대화 = interactive live / periodic dead.** `talk` 명령: 정적 `talk[80]` 또는 MTALKS 키워드 파일(first_tlk)→응답+`talk_action`(공격/소셜/시전/퀘스트지급). MTLKAG=대화 후 적대. **MSAYTLK/LT_SAYTLK(주기 발화)는 미배선 데드** | 콘텐츠(규칙)/형상(데드) |
| 16 | **사망 트리거.** 플레이어 hpcur<1 → `die()`. 몬스터 사망은 `attack_crt` 반환값. `die()`가 경험치 분배·gold 드롭([[a5-combat]]/[[a8-items-economy]])·인벤 드롭·퀘스트·리스폰 타이머 리셋·MSUMMO 소환 처리 | 콘텐츠(→a5/a8) |
| 17 | **소지 아이템 랜덤화 (스폰 시).** `carry[10]` objnum 템플릿 중 1~3개(90/6/4%) 복제, `value`를 ±10% 흔들고 ORENCH면 랜덤 인챈트. gold=MNRGLD면 고정, 아니면 mrand(gold/10, gold) | 콘텐츠(경제)/형상(랜덤) |

---

## 1. active 리스트: "플레이어 근접 시뮬레이션" (형상)

무한은 세계의 모든 몬스터를 매 틱 돌리지 않는다. **`first_active`**(update.c:30, `static ctag *`) 단일 연결 리스트에 등록된 몬스터만 `update_active`가 순회한다. 등록/해제는 세 지점에서 일어난다:

**등록 (`add_active`, update.c:858)** — 리스트 맨 앞에 `ctag`를 malloc해 삽입. 호출 지점:
- **방 입장** (`add_ply_rom`, room.c:21) — 플레이어가 방에 들어오면 방의 모든 몬스터(`first_mon`)를 `add_active`. 첫 플레이어 진입 시 방 전체가 "깨어난다".
- **배회 진입** (`update_random`) — 새로 스폰된 배회 몬스터 등록.
- **고정 몬스터 스폰** (`add_permcrt_rom`, room.c:383) — `if(rom_ptr->first_ply) add_active` — 방에 플레이어가 있을 때만 등록.
- **소환** (`summon_crt`, creature.c:889).

**해제 (`del_active`, update.c:890)** — 리스트 스캔 후 해당 `ctag` free. 호출 지점:
- **방이 빔** — `update_active` 루프 최상단(update.c:254): `if(!rom_ptr->first_ply){ del_active(crt_ptr); continue; }`. 매 틱 각 몬스터의 방에 플레이어가 없으면 즉시 비활성.
- **사망** (`die`, creature.c:362), **배회 퇴장**(wander-out), **DM 추종 이동** 등.

이 구조의 의미: **몬스터 AI 비용은 "플레이어가 관측 중인 방 수"에 비례**하지 세계 크기에 무관하다. 빈 방의 고정 몬스터는 리스트에 없어 CPU를 쓰지 않고, 상태(HP·적)도 진행하지 않는다 — 플레이어가 없는 동안 시간이 멈춘 것과 같다.

리스트 구현 자체(단일 연결 리스트·매번 malloc/free·O(n) del 스캔·삽입은 head, `add_active`가 먼저 `del_active`로 중복 제거)는 **형상**이다. 신규 스택에서는 방→몬스터 인덱스 + 방 점유 이벤트(플레이어 입장/퇴장)로 활성 집합을 갱신하고, active 몬스터에만 라운드 스케줄러를 돌리는 형태로 재설계한다.

## 2. 스폰/리스폰: 세 개의 독립 트리거 모델 (콘텐츠 규칙 / 형상 트리거)

무한의 몬스터 등장은 성격이 다른 **세 시스템**으로 갈린다. 이 분리가 A9의 핵심 아키텍처 함의다.

| 모델 | 트리거 | 주기/조건 | 대상 정의 | 그룹 크기 |
|------|--------|-----------|-----------|-----------|
| **perm_mon** (고정) | **입장 구동** (add_ply_rom→add_permcrt_rom) | 사망 후 `interval` 경과 + 다음 입장 시 재검사 | 방 `perm_mon[10]`={interval,ltime,misc=몹번호} | 슬롯 중복 몹번호 합산 |
| **random** (배회) | **폴링** update_random | 20초(`Random_update_interval`), `mrand(1,100)≤traffic` | 방 `random[10]` 후보 + `traffic` | RPLWAN=플레이어수, 아니면 `numwander` |
| **invasion** (침공) | **폴링** update_monster / _two | 4000초 / 5000초 | 하드코딩 방·몹 번호 범위 | 50 / 10 고정 |

### 2.1 perm_mon: 입장 구동 리스폰 (add_permcrt_rom, room.c:308)

방 구조체(mstruct.h:154)에 `struct lasttime perm_mon[10]`이 있다. `lasttime`={`interval`(long), `ltime`(long), `misc`(short)}(mstruct.h:53). `misc`=고정 몬스터 템플릿 번호, `interval`=리스폰 지연, `ltime`=마지막 사망 시각.

플레이어가 방에 들어올 때 `add_ply_rom`(room.c:22)이 **가장 먼저** `add_permcrt_rom`을 호출한다. 그 로직:
1. 각 `perm_mon[i]`에 대해 `ltime + interval > 현재시각`이면 스킵(아직 리스폰 대기 중).
2. 같은 `misc`(몹번호)를 가진 슬롯을 세어 `n`(스폰해야 할 총 수) 계산.
3. 현재 방에 이미 살아있는 같은 이름 MPERMT 몬스터 수 `m`을 세어, **`n − m`마리만** 추가 스폰(중복 방지).
4. 각 스폰: `carry[]` 아이템 랜덤화(§17) + gold 랜덤화 → `F_SET(MPERMT)` → `add_crt_rom` → 방에 플레이어 있으면 `add_active`.

**사망 시 리스폰 타이머 리셋** — `die_perm_crt`(creature.c:553)가 죽은 몬스터의 방 `perm_mon[]`에서 이름이 일치하는 슬롯을 찾아 `ltime = 현재시각`으로 세팅. 이후 `interval`이 지나야 재스폰 가능.

핵심: **이것은 스케줄러가 아니라 lazy(입장 시점) 검사**다. 아무도 없는 방의 죽은 고정 몬스터는 시간이 지나도 스스로 부활하지 않는다 — 다음 플레이어가 들어오는 순간 "그동안 지났어야 할 시간"을 계산해 리젠한다. 빈 방에서 시간이 멈추는 §1 원칙과 일관된다.

### 2.2 random + traffic: 폴링 배회 진입 (update_random, update.c:114)

방 구조체에 `short random[10]`(배회 후보 몹번호, mstruct.h:152)과 `char traffic`(진입 확률 0~100, mstruct.h:153)이 있다. `update_game`이 20초(`Random_update_interval`)마다 `update_random` 발동:
1. **플레이어 점유 방을 중복 제거**하며 순회(`check[]` 배열로 같은 방 1회만).
2. `mrand(1,100) > traffic`이면 스킵 — **traffic이 곧 진입 확률**(%).
3. `random[mrand(0,9)]` 후보 중 하나 선택, 없으면 스킵. `load_crt`.
4. **그룹 크기**: `RPLWAN`(방 플래그 23) 세팅 시 `mrand(1, 방 플레이어수)`, 아니면 몹 `numwander>1`이면 `mrand(1, numwander)`, 아니면 1.
5. 각 마리: 공격/scavenge/wander 타이머를 현재 시각으로 초기화(민첩<20→interval 3, else 2), `carry[]` 아이템 랜덤화(§17), gold 랜덤화, `add_crt_rom` + `add_active`.

배회 몬스터는 §10의 wander-out으로 자연 퇴장한다 — 즉 traffic은 진입·퇴장 양쪽 확률로 쓰여 방의 "몬스터 유동성"을 표현한다.

### 2.3 invasion: 하드코딩 폴링 이벤트 (update_monster / _two, update.c:755·784)

두 함수는 **하드코딩된 대규모 침공 이벤트**다. 소스 주석부터 "아래 소스 짜구 무지 후회함"이라 적혀 있어 애드혹 성격이 뚜렷하다.

- **update_monster** (4000초): 50회 반복하며 방 `mrand(8000,8300)`에 몹 `mrand(732,755)`를 스폰. 전역 방송 "드레니아에 카오스의 지휘하에 몹이 침공했습니다."
- **update_monster_two** (5000초): 10회 반복하며 방 `mrand(3601,3630)`에 몹 `mrand(265,299)` 스폰. "무적존을 강탈하려고 드레니아 몹이 침공했습니다."

방/몹 번호 범위가 소스에 리터럴로 박혀 있다 — 이것은 **형상(하드코딩)**이며, 신규 스택에서는 데이터 정의된 이벤트(방 태그·몹 풀·주기·방송 메시지)로 승격해 재설계한다. 침공이라는 게임 이벤트 자체(주기적 몹 물결 + 전역 알림)는 **콘텐츠**다.

### 2.4 부차 스폰: 소환·초인의 돌

- **summon_crt** (creature.c:821): `MSUMMO` 몬스터가 죽을 때(`die_perm_crt`) `special` 필드 번호의 몬스터를 소환, 죽인 플레이어를 즉시 적으로 등록(`add_enm_crt`). "죽으면서 부하를 부르는" 패턴.
- **update_moonstone** (update.c:728, 20000초): 몬스터가 아니라 아이템 스폰이지만 같은 "랜덤 방 선택" 패턴 — RNOTEL 아닌 랜덤 방에 obj 640(초인의 돌)을 떨궈 전역 방송. [[a8-items-economy]] 소관이나 스폰 메커니즘 대조용으로 기록.

## 3. update_active: 몬스터 AI 틱 루프 (콘텐츠 + 형상)

`update_active`(update.c:229)는 매 초 `first_active`를 순회하며 각 몬스터의 한 "행동 기회"를 처리한다. 순서가 곧 우선순위다.

**3.0 루프 진입 게이트**
- `if(!rom_ptr->first_ply){ del_active; continue; }` — 방 비면 비활성(§1).
- **공격 타이머**(update.c:280): `atime = LT(crt_ptr, LT_ATTCK)`. `atime > t`면 아직 행동 불가 → 다음 몬스터. 미도래 아니면 타이머 리셋: 민첩<20 → interval 3초, else 2초. **매 초 루프지만 개별 몬스터 행동은 2~3초 간격**(형상: 폴링 / 콘텐츠: 민첩 연동 주기).

**3.1 상태이상·charm 해제** (update.c:259~278)
- MBEFUD(혼동) 만료 검사, MCHARM(매혹) 만료 검사(LT_CHRMD).

**3.2 재생** (update.c:264~276) — 콘텐츠(율)
```
while (LT_HEALS ≤ t && (hp<hpmax || mp<mpmax)) {
    hpcur += MAX(1, hpmax/10)   // 60초마다 최대 HP의 10%
    mpcur += MAX(1, mpmax/6)    // 60초마다 최대 MP의 약 17%
    i += 60; LT_HEALS.interval = 60
}
```
while 루프라 밀린 시간만큼 소급 적용된다(방을 오래 비웠다 오면 여러 주기가 한 번에).

**3.3 scavenge (MSCAVE)** (update.c:291~310) — 콘텐츠(행동)
- LT_MSCAV 기준 20초↑ 경과 & `mrand(1,100)≤15`(15%) & 방 바닥 첫 아이템이 ONOTAK·OSCENE·OHIDDN·OPERM2·OPERMT 어느 것도 아니면 → 아이템을 줍고 `MHASSC` 세팅, "줍습니다" 방송. 무언가 주운 몬스터는 wander-out에서 제외(§3.4).

**3.4 wander-out** (update.c:312~328) — 콘텐츠(행동) / 형상(free)
- MHASSC·MPERMT·MDMFOL 아니고, LT_MWAND 20초↑ 경과 & `mrand(1,100)≤traffic` & **적이 없으면**(`!first_enm`) → "방황하고 있습니다" 방송 후 `del_crt_rom` + `del_active` + `free_crt`로 **완전 소멸**. §2.2 배회 진입의 짝. traffic이 퇴장 확률로 재사용됨.

**3.5 조기 종료** (update.c:329~333)
- 적도 없고 공격형(MAGGRE/MGAGGR/MEAGGR)도 아니면 → 다음 몬스터. 평화로운 non-active 행동(재생·scavenge·wander) 완료.

**3.6 전투** — §4·§5.

**3.7 어그로 개시** (update.c:587~615) — §4.

`update_active` 상단에 선언된 `char talkbuf[32][256]`, `namebuf[1024]`, `FILE *fp`, `maxtalk`은 함수 어디서도 쓰이지 않는 **데드 스캐폴드**다(형상: 이식 제외). MSAYTLK 주기 발화의 미완성 흔적으로 보인다(§7).

## 4. 어그로: 적 리스트 + piety 역가중 타깃 (콘텐츠)

### 4.1 적 리스트 (`first_enm`, creature.c)

각 몬스터는 `etag *first_enm`(mstruct.h:210) 큐를 가진다. `etag`={enemy 이름, damage 누적, next_tag}.

- **add_enm_crt** (creature.c:70): 이미 있으면 무시. 없으면 malloc해 **리스트 끝에 append**(`while(tmp->next_tag) tmp=tmp->next_tag`). **주석("front에 추가, front일수록 공격 확률↑")과 코드(tail append)가 불일치** — 실제 동작은 FIFO다. 새 적 추가 시 `NUMHITS=0` 리셋. *(oracle 미묘함: 주석을 믿지 말 것.)*
- **del_enm_crt** / **find_enm_crt** / **is_enm_crt**: 이름으로 조회·삭제, 누적 damage 반환.
- **add_enm_dmg** (creature.c:213): 피격 시 해당 적의 damage 누적 — `die()`의 경험치 분배 가중치([[a5-combat]]).
- **end_enm_crt** (creature.c:177): 적을 큐 **맨 뒤로 회전**. 주 타깃이 방을 떠났지만 아직 접속 중이면(`find_who`) 삭제 대신 회전 → 다음 적으로 타깃 이동.

전투 처리(update.c:334~): `first_enm`이 **주 타깃**. 그 방에서 타깃을 못 찾으면 접속 여부로 del/end 분기. 타깃을 때린 뒤 `NUMHITS≠0`이면 나머지 적 전원에 `attack_crt` **자동 반격**(update.c:502~523). 즉 다중 교전 시 몬스터는 첫 적을 주로 치되 모든 적을 조금씩 상대한다.

### 4.2 어그로 타깃 선정 — piety 역가중 랜덤 (player.c)

적이 없는 공격형 몬스터는 매 틱 방에서 새 표적을 고른다(update.c:587).

- **MAGGRE (무차별)** → `lowest_piety`(player.c:1314): 방 플레이어 각각에 가중치 `MAX(1, 25 − piety)`를 부여, 총합에서 `mrand(1, total)` 뽑아 누적 도달 플레이어 선택. **신앙심(piety)이 낮을수록 가중치↑ → 표적 확률↑**. 숨음(PHIDDN)·투명(PINVIS, 몬스터가 MDINVI면 무시)·DM투명(PDMINV)은 제외.
- **MGAGGR / MEAGGR (정렬-공격)** → `low_piety_alg`(player.c:1473): 가중치 `MAX(1, 30 − piety)` + **필터 2종**:
  - **정렬**: `alg=−1`(MGAGGR) → alignment ≥ 100(선한) 플레이어만. `alg=1`(MEAGGR) → alignment ≤ −100(악한) 플레이어만. *(update.c:594에서 `MGAGGR ? −1 : 1`. MGAGGR="선한 유저 공격", MEAGGR="악한 유저 공격" 주석과 일치.)*
  - **레벨 (원본 비대칭 주의)**: `low_piety_alg`는 두 번 순회한다. **첫 루프(가중치 합산)**는 플레이어 레벨 티어 `(level+3)/4 < lvl`(몬스터 티어)이면 제외해 저렙을 `total`에서 뺀다. 그러나 **둘째 루프(pick 도달 선택)에는 레벨 필터가 없다**(정렬 필터만). 결과적으로 저렙 제외 `total`로 `pick`을 뽑되 선택 누적엔 저렙 가중치가 다시 들어가, **리스트 순서에 따라 저렙 플레이어가 표적으로 선택될 수 있다** — 저렙 편향(가중치 배제)은 있으나 완전 배제는 보장되지 않는다. add_enm_crt(§4.1)와 같은 장르의 oracle 비대칭이다. MAGGRE(`lowest_piety`)는 레벨 필터 자체가 없다.

**민첩 회피** (update.c:601): 타깃의 민첩 > 몬스터 민첩이고 `mrand(1,10)<4`(30%)면 이번 틱 공격 개시 스킵 — 날쌘 플레이어는 선제 어그로를 확률적으로 흘린다.

어그로 개시 시(update.c:606~614): "당신을 공격합니다" 방송, `LT_ATTCK.interval=0`(즉시 다음 공격 가능), `add_enm_crt`로 적 등록.

## 5. 전투 행동: 특수 공격의 발동 조건 (콘텐츠 → 수치는 a5)

명중(`thaco − att armor/8`, min 1)·데미지(`mdice`)·피격 판정(`mrand(1,20) ≥ n`)의 **수치 유도는 [[a5-combat]]**. 여기서는 몬스터 AI가 *언제 무엇을 발동하는지*만 기록한다.

**5.1 주문 시전** (update.c:350~376, `crt_spell` update.c:654)
- `MMAGIC` & `mrand(1,100) ≤ n`. `n=20`(기본) 또는 `MMAGIO`면 `proficiency[0]`(설정된 시전 확률%). charm으로 조종당하는 몬스터는 시전 안 함.
- `crt_spell`: `spells[16]` 비트맵에서 알려진 스펠을 최대 10개 수집, 랜덤 1개 선택. 공격형 스펠은 `offensive_spell`로, 힐/버프(SVIGOR·SMENDW·SFHEAL)는 자기 대상으로 시전([[a6-magic]] spllist). 반환 2=플레이어 사망/방 이탈, 1=적중.

**5.2 breath weapon (MBRETH)** (update.c:387~423) — `mrand(1,30)<5`(약 13%). MBRWP1·MBRWP2 조합으로 4변종, 데미지 `dice((level+3)/4, N, …)`:
- 침 뱉기(BRWP1만): d3, 저레벨용.
- 악취 입김(BRWP1+BRWP2): d2, 중독(PPOISN) 부여.
- 냉기(BRWP2만): d4(저항 PRCOLD면 d2).
- 화염(둘 다 없음): d4(저항 PRFIRE면 d2).

**5.3 경험치 드레인 (MENEDR)** (update.c:426~436) — breath 미발동 시 `mrand(1,100)<10`(10%). `dice((level+3)/4, 5, ×5)`만큼 경험치 흡수, `lower_prof`로 숙련도 하락. 언데드류의 대표 위협.

**5.4 피격 후 상태이상** (update.c:453~477) — 근접 명중 후 확률 부여:
- 독 (MPOISS): 15% → PPOISN
- 질병 (MDISEA): 10% → PDISEA
- 실명 (MBLNDR): 10% → PBLIND
- 아이템 용해 (MDISIT): 15% → `dissolve_item`([[a8-items-economy]])

**5.5 혼동 (MBEFUD)** — 몬스터가 혼동 상태면 자기 데미지 `n/3`으로 감소, "혼비백산합니다".

**5.6 아이템 파괴 (choose_item)** (update.c:483~500, `choose_item` update.c:629) — 명중 시 플레이어 착용 아이템(WIELD·HELD 슬롯 제외) 중 랜덤 1개의 `shotscur--`. 0 미만이면 "산산히 부서져" 제거 후 `compute_ac` 재계산([[a8-items-economy]] §3의 ready[] 재계산 트리거).

**5.7 플레이어 사망·도주** (update.c:525~552):
- hpcur<1 → `die(att_ptr, crt_ptr)`([[a5-combat]]).
- **PWIMPY**: hpcur ≤ `WIMPYVALUE`(=carry[0] 재정의)면 자동 `flee`.
- **PFEARS**: 확률적 도주. `ff = 40 + (1 − hpcur/hpmax)×40 + 체질보너스×3 (팔라딘 −10)`, `ff < mrand(1,100)`이면 도주.

## 6. 도주: 몬스터 도주는 비활성, 플레이어 전용 (콘텐츠 as-shipped)

명시 산출 축이지만 결론은 **"몬스터 도주 기능은 as-shipped 상태에서 완전히 꺼져 있다"**이다.

- **check_for_flee** (creature.c:624): 함수 본체 첫 실행문이 `return;`(creature.c:631). 그 아래 MFLEER 검사·HP 임계·인접 방 탈출 로직은 **전부 도달 불가 데드 코드**. 전 `.c` grep 결과 MFLEER는 이 데드 함수 내부(creature.c:632)와 DM 상태표시 문자열(dm2.c:398 `"Flee, "`)에만 등장 — **어떤 라이브 경로에서도 읽히지 않는다**.
- 따라서 무한에서 **도주하는 것은 플레이어뿐**이다(§5.7 PWIMPY/PFEARS). 몬스터는 HP가 낮아도 도망가지 않고 끝까지 싸운다.

신규 스택 함의: MFLEER 플래그는 몬스터 데이터에 존재하나 동작이 없다. 이식 시 (a) 원본 동작 재현 = 무시(도주 없음), 또는 (b) **의도된 신규 기능**으로 되살려 데이터의 MFLEER를 실제 도주로 구현할지는 결정 게이트 항목. 데드 코드의 원래 의도(HP<20% & 인접 로드된 방으로 75% 확률 탈출)는 참고용으로 남긴다.

## 7. 대화: interactive는 live, periodic는 dead (콘텐츠 규칙)

대화도 명시 축이며, **두 시스템을 갈라야** 한다.

### 7.1 interactive talk (live) — `talk` (command8.c:798)

플레이어가 `말하다/talk <몬스터> [키워드]` 실행 시:
- **키워드 없음 or non-MTALKS**(command8.c:826): 몬스터의 정적 `talk[80]` 필드를 방송. 비어 있으면 "멍하니 바라봅니다". `MTLKAG`(대화 후 적대) 세팅 시 `add_enm_crt`.
- **MTALKS + 키워드**(command8.c:844): 몬스터 대화 파일(`first_tlk`, `ttag` 리스트) 로드, 키워드 매칭 → 응답 방송 + `talk_action`. 매칭 실패 시 "어깨를 으쓱", MTLKAG면 적대.

**talk_action** (command8.c:883) — 매칭된 대화가 트리거하는 행동(`tt->type`):
- **1 = attack**: `add_enm_crt` + 공격 방송.
- **2 = action**: 소셜 명령(`tt->action`)을 몬스터가 실행, 대상 `PLAYER`면 그 플레이어 지정.
- **3 = cast**: `tt->action` 스펠명을 spllist에서 찾아 시전(공격형이면 offensive_spell, 이미 적이면 시전 거부).
- **4 = give**: `tt->action` objnum 아이템 지급(무게·150개 한도·퀘스트 검사 [[a8-items-economy]]).

즉 대화는 **데이터 구동 상태 기계**(키워드→응답+부수효과)다. 신규 스택에서 대화 파일을 JSON(키워드→{응답, action 타입, 파라미터})으로 승격하면 그대로 이식된다.

### 7.2 periodic talk (dead) — MSAYTLK / LT_SAYTLK

`MSAYTLK`("말하는 몹", mtype.h:471)와 `LT_SAYTLK`(mtype.h:201)는 몬스터가 **주기적으로 스스로 말하는** 기능을 위한 정의지만, 전 `.c` grep 결과 MSAYTLK는 DM 상태표시(dm2.c:449 `"continue talk, "`)에만, LT_SAYTLK는 어디서도 읽히지 않는다. `update_active`의 미사용 `talkbuf[32][256]` 스캐폴드(§3)가 이 기능의 미완성 흔적이다. → **설정만 가능하고 동작 없는 데드**로 분류. 이식 시 §6의 MFLEER와 동일하게 "재현=무시 / 재설계=신규 구현" 결정 게이트.

## 8. 사망·charm·소환 (콘텐츠 → 수치는 a5/a8)

- **die** (creature.c:262): 몬스터 사망 시 적 리스트의 damage 비례로 경험치 분배([[a5-combat]]), 인벤토리·gold를 바닥에 드롭([[a8-items-economy]]), MPERMT면 `die_perm_crt`로 리스폰 타이머 리셋(§2.1), charm 해제, `del_active`+`del_crt_rom`+`free_crt`. 플레이어 사망 분기는 경험치 감소·레벨 강등·1008호(사망 방) 이동 등 — [[a7-player-progression]]·[[a5-combat]] 소관.
- **charm** (MCHARM, creature.c:721~812): `is_charm_crt`/`add_charm_crt`/`del_charm_crt`가 플레이어별 매혹 몬스터 리스트(`Ply[fd].extr->first_charm`) 관리. 매혹된 몬스터는 시전자를 공격하지 않음(update.c:345, `p=1`). LT_CHRMD 만료로 해제.
- **die_perm_crt의 부수효과**: 퀘스트 몬스터(`questnum`)면 퀘스트 완료·경험치 지급, MDEATH면 `ddesc/` 파일의 사후 묘사 방송, MSUMMO면 `summon_crt`로 부하 소환(§2.4).

## 콘텐츠(이식) vs 형상(재설계) 분류

| 항목 | 콘텐츠 (충실히 이식) | 형상 (자유롭게 재설계) |
|------|---------------------|----------------------|
| 활성 집합 | "플레이어 근접 몬스터만 시뮬레이션" 원칙 | `first_active` 단일 연결 리스트, malloc/free ctag, head 삽입, O(n) del |
| 고정 스폰 | 방별 고정 몬스터, 사망 후 interval 리스폰, 중복 방지 | perm_mon[10] lasttime 배열, **입장 시 lazy 재검사** |
| 배회 스폰 | 진입 확률=traffic, 그룹 크기(numwander/RPLWAN), 20초 주기 감각 | update_random 폴링, check[] 방 중복 제거 |
| 침공 이벤트 | 주기적 몹 물결 + 전역 방송 | **하드코딩 방/몹 번호 범위**(8000~8300·3601~3630, 732~755·265~299), 4000·5000초 |
| AI 주기 | 공격 간격 민첩 연동(2~3초) | 매 초 폴링 + LT_ATTCK 타이머, last_*_update statics |
| 재생 | HP hpmax/10 · MP mpmax/6 per 60초, 소급 적용 | while 루프 catch-up |
| scavenge | 20초/15%, 아이템 플래그 존중, MHASSC | 바닥 first_obj 직접 접근 |
| wander-out | 배회 몹 확률 퇴장(=traffic) | free_crt 즉시 메모리 회수 |
| 어그로 | piety 역가중 랜덤, 정렬·레벨 필터, 민첩 30% 회피 | lowest_piety/low_piety_alg 2회 순회 |
| 공격성 3종 | MAGGRE/MGAGGR/MEAGGR 의미론 | 비트 플래그 인덱스 |
| 적 리스트 | FIFO 큐, damage 누적, 타깃 이탈 시 회전, 다중 자동반격 | etag 리스트, **주석-코드 불일치**(add_enm_crt) |
| 특수 공격 | breath 4변종·드레인·독·질병·실명·용해 발동율 | dice() 호출, F_ISSET 분기 |
| 아이템 파괴 | 피격 시 착용품 소모, 파괴 시 AC 재계산 | choose_item checklist |
| 도주 | 플레이어 PWIMPY/PFEARS 임계 | **몬스터 도주 = 데드(check_for_flee `return;`)** |
| 대화 | interactive 키워드→응답+action(공격/소셜/시전/지급), MTLKAG | 대화 파일 ttag 리스트, **주기 발화(MSAYTLK) = 데드 스캐폴드** |
| 소지 랜덤화 | carry[] 1~3개(90/6/4%), value ±10%, ORENCH 인챈트, MNRGLD gold | mrand 호출 위치 |
| 사망 | die() 트리거, 리스폰 리셋, 퀘스트, MSUMMO 소환 | free_crt/링크드 리스트 정리, goto crt_died |

## 아키텍처 함의

1. **활성 집합 = 방 점유 이벤트 구동 스케줄러.** `first_active`를 매 틱 스캔·방 비움 체크하는 대신, 방→몬스터 인덱스 + 플레이어 입장/퇴장 이벤트로 활성 집합을 증분 갱신하고, active 몬스터만 라운드 스케줄러(EventEmitter/타이머 휠)에 등록한다. "빈 방=시간 정지" 의미론은 유지 — 몬스터 상태(HP·적·타이머)를 방이 비는 동안 진행하지 않는다.

2. **스폰 3모델을 명시적 트리거 타입으로 통일.** (a) perm=**입장 훅**(방 진입 시 리스폰 레코드 검사), (b) random=**인터벌 틱**(방별 traffic 확률), (c) invasion=**스크립트 이벤트**(데이터 정의된 몹 풀·주기·좌표·방송). 하드코딩 침공 좌표는 이벤트 설정으로 승격한다.

3. **리스폰은 death-timestamp + lazy 재계산 또는 스케줄 잡 중 택1.** 원본의 "사망 시각 기록 → 다음 입장 시 경과 계산"은 상태를 최소화하는 좋은 패턴이다. MongoDB에 방 인스턴스별 `perm_mon` 사망 타임스탬프를 저장하고, 입장 시 또는 저빈도 스윕으로 리젠 판정한다. 스케줄러 잡으로 바꿔도 되나, 빈 방까지 잡을 거는 비용을 피하려면 lazy가 유리하다.

4. **AI 틱 = 몬스터별 next-action 시각을 가진 우선순위 큐.** 매 초 전체 순회 대신, 각 active 몬스터의 다음 행동 시각(민첩 연동 2~3초)을 힙에 넣어 도래분만 처리한다. 재생·scavenge·wander·전투는 몬스터 상태에 붙은 개별 타이머로 분리한다.

5. **어그로 타깃 = piety 역가중 랜덤 공식을 그대로 이식.** `MAX(1, 25−piety)` / `MAX(1, 30−piety)` 가중치, 정렬 필터(±100), 레벨 티어 필터, 민첩 30% 회피는 게임 밸런스의 일부이므로 수치까지 보존한다. 단 `low_piety_alg`의 레벨 필터는 두 루프 중 첫 번째(가중치 합산)에만 있고 선택 루프엔 없는 **원본 비대칭**이라, 신규 구현이 "저렙 완전 배제"로 정규화하면 밸런스가 미묘하게 달라진다 — as-shipped 재현이 기본이면 이 비대칭까지 재현하거나, 의도를 살려 정규화할지 명시 결정한다. 적 리스트는 FIFO 큐 + 이탈 시 회전 + 다중 자동반격 의미론을 재현하되, add_enm_crt의 주석은 무시하고 코드 동작(tail append)을 따른다.

6. **대화 = 데이터 구동 상태 기계.** 몬스터 대화 파일을 JSON(키워드→{응답, action: attack/social/cast/give, 파라미터})으로 이식하면 talk_action 분기가 그대로 매핑된다. 정적 talk 문자열과 MTLKAG(대화 후 적대)도 몬스터 데이터 필드로 유지한다.

7. **데드 스캐폴드는 이식하지 않되 결정 게이트에 올린다.** 몬스터 도주(MFLEER/check_for_flee)와 주기 발화(MSAYTLK/LT_SAYTLK/talkbuf)는 데이터엔 플래그가 있으나 동작이 없다. as-shipped 충실 재현은 이 둘을 무시하는 것이고, 원저자 의도를 살려 **신규 기능으로 구현**하는 것은 별도 스코프다 — 포팅 원칙([[muhan-port-principle]])상 "동작은 충실히 재현"이 기준이므로 기본값은 재현(=미구현), 되살림은 명시 결정으로 처리한다.
