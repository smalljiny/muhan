# A9 몬스터 AI·스폰·리스폰

> 무한의 몬스터가 오라클에서 *무엇을 하는지* 정리한다. 다루는 내용은 다음과 같다.
>
> - 언제 시뮬레이션되는가(active 리스트)
> - 어떻게 세계에 등장하는가(스폰 3계층)
> - 매 틱 무엇을 판단하는가(update_active AI)
> - 누구를 노리는가(어그로)
> - 어떻게 대화하고 도주하는가
>
> 다음은 게임 규칙이므로 충실히 이식한다: 공격성, 배회, 재생, 어그로 타깃 선택, 리스폰 주기, 대화 규칙. 다음은 원작의 구현 방식이므로 자유롭게 재설계한다: `first_active` 단일 연결 리스트, `time(0)` 초 단위 폴링, `perm_mon` lasttime 배열, 하드코딩된 침공 좌표, 데드 스캐폴드(몬스터 도주, 주기 발화).
>
> 이슈 #9. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)의 `update.c`, `creature.c`, `room.c`, `player.c`, `command8.c`다. 코드를 이식하지 않고 동작만 추출한다.
>
> **오라클 읽기 주의**: 하네스의 `grep` 래퍼는 `-I`(binary skip)를 붙이므로 EUC-KR 파일을 건너뛴다. `command grep -a`를 쓰거나 `iconv -f EUC-KR -t UTF-8 -c … | grep`으로 우회한다([[muhan-oracle-toolchain]]).
>
> **전투·경제 공식은 다시 유도하지 않는다**: 몬스터 명중(`thaco − armor/8`), 데미지(`mdice`), 경험치 분배, gold 드롭은 [[a5-combat]]와 [[a8-items-economy]]에서 확정했다. 이 노트는 몬스터가 그 공식을 *언제, 어떤 조건에서* 발동하는지(AI 결정)만 다루고, 수치 유도는 해당 노트를 참조한다. 방 입장과 이동 규칙은 [[a4-movement-rooms]]가 담당한다.
>
> **이동과 연동된 행동은 a4 담당**: MFOLLO(공격자 추종), MBLOCK(출구 차단), MPGUAR(수동 출구 감시)는 몬스터 행동이다. 하지만 `update_active` AI 틱이 아니라 플레이어 이동 코드에서 트리거되므로 [[a4-movement-rooms]]에서 다룬다. 이 노트에서 "배회"는 스폰 진입(wander-in)과 확률 퇴장(wander-out, §3.4)을 뜻한다. 몬스터가 스스로 방을 옮기는 동작은 데드 코드인 `check_for_flee`(§6)를 빼면 없다.

## 개요

무한의 몬스터 AI는 **함수 하나 `update_active`**(update.c:229)에 모여 있다. 게임 루프([[a1-runtime-loop]])가 `update_game`을 매 초 호출하고, 그 안에서 여러 하위 업데이트가 각자의 주기로 실행된다. 몬스터와 관련된 것은 다음과 같다.

- `update_active`: 매 초, AI 틱
- `update_random`: 20초, 배회 진입
- `update_monster`/`update_monster_two`: 4000초와 5000초, 침공 이벤트
- `add_permcrt_rom`: 방 입장 시 트리거, 고정 몬스터 리스폰

아키텍처의 중심은 **active 리스트**다. 매 틱 세계의 모든 몬스터를 순회하지 않는다. **플레이어가 있는 방의 몬스터만** `first_active` 연결 리스트에 등록해 시뮬레이션하고, 방이 비면 즉시 리스트에서 뺀다. 1993년의 32비트 단일 프로세스에서 큰 월드를 돌리기 위한 성능 기법이었다. 신규 스택에서는 "플레이어 근접 시뮬레이션"으로 재설계할 대상이다.

몬스터가 세계에 등장하는 방식(스폰)은 **서로 독립된 트리거 모델 세 가지**로 나뉜다.

1. **perm_mon(고정 몬스터)**: 방마다 `perm_mon[10]` 슬롯에 "이 방에 항상 있어야 할 몬스터"를 정의한다. **플레이어가 방에 들어올 때** 리젠할지 검사한다(entry-driven, lazy).
2. **random(배회 몬스터)**: 방마다 `random[10]` 후보와 `traffic` 확률을 둔다. **20초마다 폴링**해 플레이어가 있는 방에 확률적으로 진입시킨다(polled).
3. **invasion(침공 이벤트)**: 하드코딩된 방 번호와 몬스터 번호 범위에 **4000초와 5000초마다 폴링**해 대량으로 스폰하고 전역 방송한다(scripted polled).

몬스터 AI 틱(`update_active`)은 active 몬스터마다 다음 순서로 처리한다.

1. **공격 타이머**(민첩에 따라 2~3초)를 확인한다. 아직 때가 아니면 건너뛴다.
2. 상태이상을 해제하고 HP와 MP를 **재생**한다.
3. **scavenge**: 바닥 아이템을 줍는다.
4. **wander-out**: 적이 없으면 확률적으로 사라진다.
5. **전투**: 적 리스트를 처리한다. 주문 또는 근접 공격, breath, 드레인, 상태이상, 아이템 파괴가 여기에 속한다.
6. **어그로**: 적이 없는 공격형 몬스터가 타깃을 고른다.

타깃은 **piety(신앙심)에 반비례하는 가중치로 무작위 선택**한다. 신앙심이 낮은 플레이어일수록 더 자주 표적이 된다.

핵심 분리는 다음과 같다.

- **콘텐츠**(충실히 이식):
  - 공격성 3종(MAGGRE/MGAGGR/MEAGGR)
  - piety 역가중 타깃, 성향 필터와 레벨 필터
  - 재생율(60초마다 HP hpmax/10, MP mpmax/6)
  - 공격 주기(민첩에 따라 2~3초)
  - scavenge(15%, 20초)
  - 배회 확률(=traffic)
  - 리스폰 주기(사망 게이트), 스폰 그룹 크기
  - breath, 드레인, 상태이상의 발동율
  - 어그로 리스트 회전
  - 대화 응답, charm과 소환 규칙
- **구현 방식**(재설계):
  - first_active 단일 리스트, add/del 때의 malloc
  - time(0) 초 단위 폴링
  - perm_mon lasttime 배열
  - 하드코딩된 침공 좌표(방 8000~8300과 3601~3630, 몬스터 732~755와 265~299)
  - 데드 스캐폴드(check_for_flee, talkbuf, MSAYTLK)
  - goto
  - add_enm_crt의 주석과 코드 불일치

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **active 리스트 = 플레이어 근접 시뮬레이션.** `first_active` 단일 연결 리스트에 등록된 몬스터만 `update_active`가 매 초 순회한다. 플레이어가 방에 들어오면 방의 몬스터 전원을 `add_active`하고, 방이 비면(`!rom_ptr->first_ply`) 즉시 `del_active`한다 | 재설계(스케줄링) |
| 2 | **스폰 트리거 3모델.** ① perm_mon=**입장 기반**(add_ply_rom→add_permcrt_rom, lazy) ② random=**20초 폴링**(p=traffic) ③ invasion=**4000초와 5000초 폴링**(하드코딩 좌표) | 이식(규칙)/재설계(트리거) |
| 3 | **리스폰 = 사망 게이트 + 입장 시 재검사.** `perm_mon[i]`={interval,ltime,misc}. 몬스터가 죽으면 `die_perm_crt`가 `ltime=사망시각`으로 설정하고, 다음 입장 때 `ltime+interval ≤ 현재`이면 다시 스폰한다. 스케줄러가 아니라 lazy 검사다 | 이식(주기)/재설계(구현) |
| 4 | **어그로 타깃 = piety 역가중 랜덤.** `lowest_piety`(MAGGRE)는 Σmax(1,25−piety)로 가중한다. `low_piety_alg`(MGAGGR/MEAGGR)는 Σmax(1,30−piety)에 성향 필터(±100)와 레벨 필터(첫 루프에만 적용, §4.2의 비대칭)를 더한다. 신앙심이 낮을수록 표적이 될 확률이 높다 | 콘텐츠(공식) |
| 5 | **공격성 3종.** MAGGRE(무차별), MGAGGR(선한 플레이어 공격, alg=−1), MEAGGR(악한 플레이어 공격, alg=1). 성향-공격형은 레벨 티어로 표적을 편향한다(저렙의 가중치를 뺀다). 하지만 **선택 루프에는 레벨 필터가 없어서 저렙이 완전히 빠진다는 보장은 없다(원본의 비대칭)**. 민첩이 높은 플레이어는 30% 확률로 첫 공격을 피한다 | 이식(규칙)/재설계(비대칭) |
| 6 | **적 리스트 = `first_enm` etag 큐, 끝에 추가.** 주석은 "앞에 추가"라고 하지만 코드는 끝에 추가한다(주석과 코드 불일치). `first_enm`이 주 타깃을 유지하고, 나머지에게는 자동 반격한다. 타깃이 자리를 뜨면 `end_enm_crt`로 큐 뒤로 돌린다 | 이식(규칙)/재설계(불일치) |
| 7 | **AI 틱 게이트 = LT_ATTCK 타이머.** 민첩<20이면 interval 3초, 아니면 2초다. 타이머가 아직 안 됐으면 건너뛴다. 루프는 매 초 돌지만 몬스터별 행동은 2~3초 간격이다 | 이식(주기)/재설계(폴링) |
| 8 | **재생.** LT_HEALS 60초마다 HP += max(1,hpmax/10), MP += max(1,mpmax/6). while 루프로 밀린 만큼 한꺼번에 적용한다 | 콘텐츠(율) |
| 9 | **scavenge (MSCAVE).** 20초 이상 지났고, 15% 확률에 걸렸고, 바닥의 첫 아이템이 ONOTAK/OSCENE/OHIDDN/OPERM2/OPERMT가 아니면 줍고 MHASSC를 설정한다 | 콘텐츠(행동) |
| 10 | **wander-out.** MHASSC/MPERMT/MDMFOL이 아니고, 20초 이상 지났고, mrand≤traffic이고, 적이 없으면 "방황하고 있습니다"를 방송한 뒤 `free_crt`로 사라진다. 배회 몬스터가 자연스럽게 퇴장하는 방식이다 | 이식(행동)/재설계(free) |
| 11 | **주문 시전.** MMAGIC이고 mrand(1,100)≤n이면(n=20, MMAGIO면 proficiency[0]) `crt_spell`이 아는 스펠 최대 10개 중 하나를 무작위로 시전한다([[a6-magic]] spllist) | 콘텐츠(규칙) |
| 12 | **특수 공격.** breath(MBRETH, ~13%, 침/악취·독/냉기/화염의 4변종), 경험치 드레인(MENEDR 10%), 독(MPOISS 15%), 질병(MDISEA 10%), 실명(MBLNDR 10%), 아이템 용해(MDISIT 15%) | 콘텐츠(행동) |
| 13 | **아이템 파괴 (피격 시).** `choose_item`이 착용 아이템(WIELD·HELD 제외) 하나를 무작위로 골라 `shotscur--`한다. 0이 되면 "산산히 부서져"와 함께 제거하고 `compute_ac`를 호출한다 | 콘텐츠(규칙) |
| 14 | **몬스터 도주 = 완전히 꺼져 있음.** `check_for_flee`는 첫 줄이 `return;`이라 아무 일도 하지 않는다(데드). MFLEER는 이 데드 함수 안과 DM 표시 문자열에만 나온다. 도주는 **플레이어만** 한다(PWIMPY hpcur≤WIMPYVALUE / PFEARS 확률) | 이식(as-shipped)/재설계(데드) |
| 15 | **대화 = 대화형은 동작, 주기 발화는 데드.** `talk` 명령은 정적 `talk[80]` 또는 MTALKS 키워드 파일(first_tlk)로 응답하고 `talk_action`(공격/소셜/시전/퀘스트 지급)을 실행한다. MTLKAG는 대화 후 적대한다. **MSAYTLK/LT_SAYTLK(주기 발화)는 연결되지 않은 데드 코드다** | 이식(규칙)/재설계(데드) |
| 16 | **사망 트리거.** 플레이어는 hpcur<1이면 `die()`. 몬스터 사망은 `attack_crt`의 반환값으로 판단한다. `die()`가 경험치 분배, gold 드롭([[a5-combat]]/[[a8-items-economy]]), 인벤토리 드롭, 퀘스트, 리스폰 타이머 리셋, MSUMMO 소환을 처리한다 | 콘텐츠(→a5/a8) |
| 17 | **소지 아이템 랜덤화 (스폰 시).** `carry[10]` objnum 템플릿 중 1~3개(90/6/4%)를 복제하고, `value`를 ±10% 흔들고, ORENCH면 무작위로 인챈트한다. gold는 MNRGLD면 고정, 아니면 mrand(gold/10, gold) | 이식(경제)/재설계(랜덤) |

---

## 1. active 리스트: "플레이어 근접 시뮬레이션" (원작 구현 방식)

무한은 매 틱 세계의 모든 몬스터를 돌리지 않는다. **`first_active`**(update.c:30, `static ctag *`) 단일 연결 리스트에 등록된 몬스터만 `update_active`가 순회한다. 등록과 해제는 다음 지점에서 일어난다.

**등록 (`add_active`, update.c:858)**: `ctag`를 malloc해 리스트 맨 앞에 넣는다. 호출 지점은 다음과 같다.
- **방 입장** (`add_ply_rom`, room.c:21): 플레이어가 방에 들어오면 방의 모든 몬스터(`first_mon`)를 `add_active`한다. 첫 플레이어가 들어올 때 방 전체가 "깨어난다".
- **배회 진입** (`update_random`): 새로 스폰된 배회 몬스터를 등록한다.
- **고정 몬스터 스폰** (`add_permcrt_rom`, room.c:383): `if(rom_ptr->first_ply) add_active`. 방에 플레이어가 있을 때만 등록한다.
- **소환** (`summon_crt`, creature.c:889).

**해제 (`del_active`, update.c:890)**: 리스트를 훑어 해당 `ctag`를 free한다. 호출 지점은 다음과 같다.
- **방이 빔**: `update_active` 루프 맨 위(update.c:254)의 `if(!rom_ptr->first_ply){ del_active(crt_ptr); continue; }`. 매 틱 몬스터가 있는 방에 플레이어가 없으면 즉시 비활성으로 만든다.
- **사망** (`die`, creature.c:362), **배회 퇴장**(wander-out), **DM 추종 이동** 등.

이 구조에서 **몬스터 AI 비용은 "플레이어가 보고 있는 방의 수"에 비례**하고 세계 크기와는 관계가 없다. 빈 방의 고정 몬스터는 리스트에 없으므로 CPU를 쓰지 않고, HP나 적 같은 상태도 변하지 않는다. 플레이어가 없는 동안 시간이 멈춘 것과 같다.

리스트 구현 자체는 **구현 방식**이다. 단일 연결 리스트를 쓰고, 매번 malloc/free하고, del할 때 O(n)으로 훑고, head에 삽입하며, `add_active`가 먼저 `del_active`로 중복을 지운다. 신규 스택에서는 방→몬스터 인덱스와 방 점유 이벤트(플레이어 입장/퇴장)로 활성 집합을 갱신하고, active 몬스터에만 라운드 스케줄러를 돌리도록 재설계한다.

## 2. 스폰/리스폰: 세 개의 독립 트리거 모델 (규칙은 이식 / 트리거는 재설계)

무한에서 몬스터가 등장하는 방식은 성격이 다른 **세 시스템**으로 나뉜다. 이 분리가 A9에서 얻는 가장 중요한 아키텍처 시사점이다.

| 모델 | 트리거 | 주기/조건 | 대상 정의 | 그룹 크기 |
|------|--------|-----------|-----------|-----------|
| **perm_mon** (고정) | **입장 기반** (add_ply_rom→add_permcrt_rom) | 사망 후 `interval` 경과 + 다음 입장 시 재검사 | 방 `perm_mon[10]`={interval,ltime,misc=몬스터 번호} | 같은 몬스터 번호 슬롯 수를 합산 |
| **random** (배회) | **폴링** update_random | 20초(`Random_update_interval`), `mrand(1,100)≤traffic` | 방 `random[10]` 후보 + `traffic` | RPLWAN이면 플레이어 수, 아니면 `numwander` |
| **invasion** (침공) | **폴링** update_monster / _two | 4000초 / 5000초 | 하드코딩된 방·몬스터 번호 범위 | 50 / 10 고정 |

### 2.1 perm_mon: 입장 기반 리스폰 (add_permcrt_rom, room.c:308)

방 구조체(mstruct.h:154)에는 `struct lasttime perm_mon[10]`이 있다. `lasttime`은 {`interval`(long), `ltime`(long), `misc`(short)}이다(mstruct.h:53). `misc`는 고정 몬스터 템플릿 번호, `interval`은 리스폰 지연, `ltime`은 마지막 사망 시각이다.

플레이어가 방에 들어오면 `add_ply_rom`(room.c:22)이 **가장 먼저** `add_permcrt_rom`을 호출한다. 그 로직은 다음과 같다.
1. 각 `perm_mon[i]`에 대해 `ltime + interval > 현재시각`이면 건너뛴다(아직 리스폰 대기 중).
2. 같은 `misc`(몬스터 번호)를 가진 슬롯을 세어 스폰해야 할 총수 `n`을 구한다.
3. 지금 방에 살아 있는 같은 이름의 MPERMT 몬스터 수 `m`을 세어, **`n − m`마리만** 더 스폰한다(중복 방지).
4. 한 마리씩 스폰할 때마다 `carry[]` 아이템 랜덤화(핵심 발견 #17)와 gold 랜덤화를 하고, `F_SET(MPERMT)` → `add_crt_rom`을 거친 뒤, 방에 플레이어가 있으면 `add_active`한다.

**사망 시 리스폰 타이머 리셋**: `die_perm_crt`(creature.c:553)가 죽은 몬스터가 있던 방의 `perm_mon[]`에서 이름이 같은 슬롯을 찾아 `ltime = 현재시각`으로 설정한다. 그 뒤 `interval`이 지나야 다시 스폰할 수 있다.

핵심은 **스케줄러가 아니라 입장 시점에 하는 lazy 검사**라는 데 있다. 아무도 없는 방에서 죽은 고정 몬스터는 시간이 지나도 스스로 살아나지 않는다. 다음 플레이어가 들어오는 순간 그동안 흐른 시간을 계산해 리젠한다. 빈 방에서 시간이 멈춘다는 §1의 원칙과 맞아떨어진다.

### 2.2 random + traffic: 폴링 배회 진입 (update_random, update.c:114)

방 구조체에는 `short random[10]`(배회 후보 몬스터 번호, mstruct.h:152)과 `char traffic`(진입 확률 0~100, mstruct.h:153)이 있다. `update_game`은 20초(`Random_update_interval`)마다 `update_random`을 실행한다.
1. **플레이어가 있는 방을 중복 없이** 순회한다(`check[]` 배열로 같은 방은 1회만).
2. `mrand(1,100) > traffic`이면 건너뛴다. 즉 **traffic이 곧 진입 확률**(%)이다.
3. `random[mrand(0,9)]` 후보 중 하나를 고르고, 비어 있으면 건너뛴다. 그다음 `load_crt`.
4. **그룹 크기**: `RPLWAN`(방 플래그 23)이 설정돼 있으면 `mrand(1, 방 플레이어수)`, 아니면 몬스터의 `numwander>1`일 때 `mrand(1, numwander)`, 둘 다 아니면 1이다.
5. 한 마리마다 공격/scavenge/wander 타이머를 현재 시각으로 초기화하고(민첩<20이면 interval 3, 아니면 2), `carry[]` 아이템 랜덤화(핵심 발견 #17)와 gold 랜덤화를 한 뒤 `add_crt_rom` + `add_active`한다.

배회 몬스터는 §3.4의 wander-out으로 자연스럽게 퇴장한다. 따라서 traffic은 진입 확률과 퇴장 확률 양쪽에 쓰이며, 방에 몬스터가 얼마나 자주 드나드는지를 나타낸다.

### 2.3 invasion: 하드코딩 폴링 이벤트 (update_monster / _two, update.c:755·784)

두 함수는 **하드코딩된 대규모 침공 이벤트**다. 소스 주석에 "아래 소스 짜구 무지 후회함"이라고 적혀 있을 만큼 임시방편으로 만든 코드다.

- **update_monster** (4000초): 50회 반복하며 방 `mrand(8000,8300)`에 몬스터 `mrand(732,755)`를 스폰한다. 전역 방송은 "드레니아에 카오스의 지휘하에 몹이 침공했습니다."
- **update_monster_two** (5000초): 10회 반복하며 방 `mrand(3601,3630)`에 몬스터 `mrand(265,299)`를 스폰한다. 방송은 "무적존을 강탈하려고 드레니아 몹이 침공했습니다."

방 번호와 몬스터 번호 범위가 소스에 리터럴로 들어 있다. 이것은 **원작 구현 방식(하드코딩)**이다. 신규 스택에서는 방 태그, 몬스터 풀, 주기, 방송 메시지를 데이터로 정의한 이벤트로 옮겨 재설계한다. 침공이라는 게임 이벤트 자체(주기적인 몬스터 물결과 전역 알림)는 콘텐츠다.

### 2.4 부차 스폰: 소환·초인의 돌

- **summon_crt** (creature.c:821): `MSUMMO` 몬스터가 죽을 때(`die_perm_crt`) `special` 필드에 적힌 번호의 몬스터를 소환하고, 죽인 플레이어를 바로 적으로 등록한다(`add_enm_crt`). "죽으면서 부하를 부르는" 패턴이다.
- **update_moonstone** (update.c:728, 20000초): 몬스터가 아니라 아이템 스폰이지만 같은 "랜덤 방 선택" 패턴을 쓴다. RNOTEL이 아닌 무작위 방에 obj 640(초인의 돌)을 떨어뜨리고 전역 방송한다. [[a8-items-economy]] 담당이지만 스폰 메커니즘과 비교하려고 기록한다.

## 3. update_active: 몬스터 AI 틱 루프 (이식 + 재설계)

`update_active`(update.c:229)는 매 초 `first_active`를 순회하며 몬스터마다 "행동 기회"를 한 번 처리한다. 처리 순서가 곧 우선순위다.

**3.0 루프 진입 게이트**
- `if(!rom_ptr->first_ply){ del_active; continue; }`: 방이 비면 비활성으로 만든다(§1).
- **공격 타이머**(update.c:280): `atime = LT(crt_ptr, LT_ATTCK)`. `atime > t`이면 아직 행동할 수 없으므로 다음 몬스터로 넘어간다. 때가 됐으면 타이머를 리셋한다. 민첩<20이면 interval 3초, 아니면 2초다. **루프는 매 초 돌지만 몬스터 하나하나의 행동은 2~3초 간격이다**(폴링은 재설계, 민첩 연동 주기는 이식).

**3.1 상태이상·charm 해제** (update.c:259~278)
- MBEFUD(혼동)와 MCHARM(매혹, LT_CHRMD)이 만료됐는지 검사한다.

**3.2 재생** (update.c:264~276) — 콘텐츠(율)
```
while (LT_HEALS ≤ t && (hp<hpmax || mp<mpmax)) {
    hpcur += MAX(1, hpmax/10)   // 60초마다 최대 HP의 10%
    mpcur += MAX(1, mpmax/6)    // 60초마다 최대 MP의 약 17%
    i += 60; LT_HEALS.interval = 60
}
```
while 루프이므로 밀린 시간만큼 한꺼번에 적용된다. 방을 오래 비웠다가 돌아오면 여러 주기가 한 번에 처리된다.

**3.3 scavenge (MSCAVE)** (update.c:291~310) — 콘텐츠(행동)
- 조건은 세 가지다. LT_MSCAV 기준으로 20초 이상 지났고, `mrand(1,100)≤15`(15%)에 걸렸고, 방 바닥의 첫 아이템이 ONOTAK·OSCENE·OHIDDN·OPERM2·OPERMT 중 어느 것도 아니어야 한다. 그러면 아이템을 줍고 `MHASSC`를 설정하며 "줍습니다"를 방송한다. 무언가를 주운 몬스터는 wander-out 대상에서 빠진다(§3.4).

**3.4 wander-out** (update.c:312~328) — 이식(행동) / 재설계(free)
- MHASSC·MPERMT·MDMFOL이 아니고, LT_MWAND 기준 20초 이상 지났고, `mrand(1,100)≤traffic`이고, **적이 없으면**(`!first_enm`) "방황하고 있습니다"를 방송한다. 그 뒤 `del_crt_rom` + `del_active` + `free_crt`로 **완전히 사라진다**. §2.2 배회 진입과 짝을 이루며, traffic을 퇴장 확률로도 쓴다.

**3.5 조기 종료** (update.c:329~333)
- 적도 없고 공격형(MAGGRE/MGAGGR/MEAGGR)도 아니면 다음 몬스터로 넘어간다. 이 시점에 전투와 무관한 평화로운 행동(재생, scavenge, wander)은 모두 끝난 상태다.

**3.6 전투** — §4·§5.

**3.7 어그로 개시** (update.c:587~615) — §4.

`update_active` 맨 위에 선언된 `char talkbuf[32][256]`, `namebuf[1024]`, `FILE *fp`, `maxtalk`은 함수 어디에서도 쓰이지 않는 **데드 스캐폴드**다(원작 구현 방식이므로 이식하지 않는다). MSAYTLK 주기 발화를 만들다 만 흔적으로 보인다(§7).

## 4. 어그로: 적 리스트 + piety 역가중 타깃 (콘텐츠)

### 4.1 적 리스트 (`first_enm`, creature.c)

몬스터마다 `etag *first_enm`(mstruct.h:210) 큐가 있다. `etag`는 {enemy 이름, 누적 damage, next_tag}다.

- **add_enm_crt** (creature.c:70): 이미 있으면 무시한다. 없으면 malloc해 **리스트 끝에 붙인다**(`while(tmp->next_tag) tmp=tmp->next_tag`). **주석("앞에 추가하며, 앞쪽일수록 공격받을 확률이 높다")과 코드(끝에 추가)가 다르다.** 실제 동작은 FIFO다. 새 적을 추가할 때 `NUMHITS=0`으로 리셋한다. *(오라클의 함정이다. 주석을 믿지 말 것.)*
- **del_enm_crt** / **find_enm_crt** / **is_enm_crt**: 이름으로 조회하거나 삭제하고, 누적 damage를 돌려준다.
- **add_enm_dmg** (creature.c:213): 피격될 때 해당 적의 damage를 누적한다. `die()`가 경험치를 분배할 때 가중치로 쓴다([[a5-combat]]).
- **end_enm_crt** (creature.c:177): 적을 큐 **맨 뒤로 돌린다**. 주 타깃이 방을 떠났지만 아직 접속 중이면(`find_who`) 지우지 않고 뒤로 돌려서 다음 적으로 타깃을 옮긴다.

전투 처리(update.c:334~)에서는 `first_enm`이 **주 타깃**이다. 방에서 타깃을 찾지 못하면 접속 여부에 따라 del 또는 end로 나뉜다. 타깃을 때린 뒤 `NUMHITS≠0`이면 나머지 적 전원에게 `attack_crt`로 **자동 반격**한다(update.c:502~523). 즉 여럿과 싸울 때 몬스터는 첫 번째 적을 주로 치면서 나머지 적도 조금씩 상대한다.

### 4.2 어그로 타깃 선정 — piety 역가중 랜덤 (player.c)

적이 없는 공격형 몬스터는 매 틱 방에서 새 표적을 고른다(update.c:587).

- **MAGGRE (무차별)** → `lowest_piety`(player.c:1314): 방의 플레이어마다 가중치 `MAX(1, 25 − piety)`를 준다. 총합에서 `mrand(1, total)`을 뽑고, 누적값이 거기에 도달한 플레이어를 고른다. **신앙심(piety)이 낮을수록 가중치가 커져 표적이 될 확률이 높다.** 숨은 플레이어(PHIDDN), 투명한 플레이어(PINVIS, 몬스터가 MDINVI면 무시), DM 투명(PDMINV)은 제외한다.
- **MGAGGR / MEAGGR (성향-공격)** → `low_piety_alg`(player.c:1473): 가중치 `MAX(1, 30 − piety)`에 **필터 두 가지**를 더한다.
  - **성향**: `alg=−1`(MGAGGR)이면 alignment ≥ 100인(선한) 플레이어만, `alg=1`(MEAGGR)이면 alignment ≤ −100인(악한) 플레이어만 고른다. *(update.c:594의 `MGAGGR ? −1 : 1`. MGAGGR="선한 유저 공격", MEAGGR="악한 유저 공격"이라는 주석과 맞다.)*
  - **레벨 (원본의 비대칭에 주의)**: `low_piety_alg`는 플레이어 목록을 두 번 순회한다.
    - **첫 루프(가중치 합산)**는 플레이어 레벨 티어 `(level+3)/4 < lvl`(몬스터 티어)이면 제외해, 저렙을 `total`에서 뺀다.
    - **둘째 루프(누적값으로 선택)에는 레벨 필터가 없다**(성향 필터만 있다).
    - 그래서 `pick`은 저렙을 뺀 `total`에서 뽑지만, 선택할 때의 누적값에는 저렙 가중치가 다시 들어간다. **리스트 순서에 따라 저렙 플레이어가 표적이 될 수 있다.** 저렙 쪽으로 덜 가도록 가중치를 빼기는 하지만 완전히 빠진다는 보장은 없다.
    - add_enm_crt(§4.1)와 같은 종류의 오라클 비대칭이다. MAGGRE(`lowest_piety`)에는 레벨 필터가 아예 없다.

**민첩 회피** (update.c:601): 타깃의 민첩이 몬스터보다 높고 `mrand(1,10)<4`(30%)이면 이번 틱에는 공격을 시작하지 않는다. 날쌘 플레이어는 확률적으로 먼저 공격받지 않는다.

어그로를 시작하면(update.c:606~614) "당신을 공격합니다"를 방송하고, `LT_ATTCK.interval=0`으로 바로 다음 공격을 할 수 있게 한 뒤, `add_enm_crt`로 적을 등록한다.

## 5. 전투 행동: 특수 공격의 발동 조건 (콘텐츠 → 수치는 a5)

명중(`thaco − att armor/8`, min 1), 데미지(`mdice`), 피격 판정(`mrand(1,20) ≥ n`)의 **수치 유도는 [[a5-combat]]**에 있다. 여기서는 몬스터 AI가 *언제 무엇을 발동하는지*만 기록한다.

**5.1 주문 시전** (update.c:350~376, `crt_spell` update.c:654)
- `MMAGIC`이고 `mrand(1,100) ≤ n`일 때 시전한다. `n=20`이 기본이고, `MMAGIO`면 `proficiency[0]`(설정된 시전 확률%)을 쓴다. charm으로 조종당하는 몬스터는 시전하지 않는다.
- `crt_spell`은 `spells[16]` 비트맵에서 아는 스펠을 최대 10개 모아 무작위로 1개를 고른다. 공격 스펠은 `offensive_spell`로, 힐·버프(SVIGOR·SMENDW·SFHEAL)는 자신에게 시전한다([[a6-magic]] spllist). 반환값 2는 플레이어 사망 또는 방 이탈, 1은 적중이다.

**5.2 breath weapon (MBRETH)** (update.c:387~423): `mrand(1,30)<5`(약 13%)일 때 발동한다. MBRWP1과 MBRWP2의 조합으로 4변종이 있고, 데미지는 `dice((level+3)/4, N, …)`다.
- 침 뱉기(BRWP1만): d3, 저레벨용.
- 악취 입김(BRWP1+BRWP2): d2, 중독(PPOISN) 부여.
- 냉기(BRWP2만): d4(PRCOLD 저항이 있으면 d2).
- 화염(둘 다 없음): d4(PRFIRE 저항이 있으면 d2).

**5.3 경험치 드레인 (MENEDR)** (update.c:426~436): breath가 발동하지 않았을 때 `mrand(1,100)<10`(10%)이면 발동한다. `dice((level+3)/4, 5, ×5)`만큼 경험치를 빼앗고 `lower_prof`로 숙련도를 낮춘다. 언데드류의 대표적인 위협이다.

**5.4 피격 후 상태이상** (update.c:453~477): 근접 공격이 명중한 뒤 확률로 부여한다.
- 독 (MPOISS): 15% → PPOISN
- 질병 (MDISEA): 10% → PDISEA
- 실명 (MBLNDR): 10% → PBLIND
- 아이템 용해 (MDISIT): 15% → `dissolve_item`([[a8-items-economy]])

**5.5 혼동 (MBEFUD)**: 몬스터가 혼동 상태면 자기 데미지가 `n/3`으로 줄고 "혼비백산합니다"가 나온다.

**5.6 아이템 파괴 (choose_item)** (update.c:483~500, `choose_item` update.c:629): 명중하면 플레이어가 착용한 아이템(WIELD·HELD 슬롯 제외) 중 하나를 무작위로 골라 `shotscur--`한다. 0 미만이 되면 "산산히 부서져"와 함께 제거하고 `compute_ac`로 다시 계산한다([[a8-items-economy]] §3에서 말한 ready[] 재계산의 트리거다).

**5.7 플레이어 사망·도주** (update.c:525~552):
- hpcur<1이면 `die(att_ptr, crt_ptr)`([[a5-combat]]).
- **PWIMPY**: hpcur ≤ `WIMPYVALUE`(carry[0]를 재정의한 값)이면 자동으로 `flee`.
- **PFEARS**: 확률적으로 도주한다. `ff = 40 + (1 − hpcur/hpmax)×40 + 체질보너스×3 (팔라딘 −10)`이고, `ff < mrand(1,100)`이면 도주한다.

## 6. 도주: 몬스터 도주는 비활성, 플레이어 전용 (콘텐츠 as-shipped)

조사하기로 명시한 항목이지만, 결론은 **"출시 상태(as-shipped)에서 몬스터 도주 기능은 완전히 꺼져 있다"**이다.

- **check_for_flee** (creature.c:624): 함수 본문의 첫 실행문이 `return;`이다(creature.c:631). 그 아래의 MFLEER 검사, HP 임계값, 인접 방 탈출 로직은 **모두 도달할 수 없는 데드 코드**다. 전체 `.c`를 grep하면 MFLEER는 이 데드 함수 안(creature.c:632)과 DM 상태 표시 문자열(dm2.c:398 `"Flee, "`)에만 나온다. **실제로 실행되는 어떤 경로에서도 읽지 않는다.**
- 따라서 무한에서 **도주하는 것은 플레이어뿐**이다(§5.7 PWIMPY/PFEARS). 몬스터는 HP가 낮아도 도망가지 않고 끝까지 싸운다.

신규 스택 시사점: MFLEER 플래그는 몬스터 데이터에 있지만 동작이 없다. 이식할 때 두 가지 중 하나를 결정 게이트에서 정한다. (a) 원본 동작을 재현해 무시한다(도주 없음). (b) **의도된 신규 기능**으로 되살려 데이터의 MFLEER를 실제 도주로 구현한다. 데드 코드의 원래 의도(HP<20%이면 로드된 인접 방으로 75% 확률로 탈출)는 참고용으로 남긴다.

## 7. 대화: interactive는 live, periodic는 dead (콘텐츠 규칙)

대화도 조사하기로 명시한 항목이며, **두 시스템을 나눠서 봐야** 한다.

### 7.1 interactive talk (live) — `talk` (command8.c:798)

플레이어가 `말하다/talk <몬스터> [키워드]`를 실행하면 다음과 같이 처리한다.
- **키워드가 없거나 MTALKS가 아닌 몬스터**(command8.c:826): 몬스터의 정적 `talk[80]` 필드를 방송한다. 비어 있으면 "멍하니 바라봅니다". `MTLKAG`(대화 후 적대)가 설정돼 있으면 `add_enm_crt`한다.
- **MTALKS + 키워드**(command8.c:844): 몬스터 대화 파일(`first_tlk`, `ttag` 리스트)을 로드해 키워드를 매칭한다. 맞으면 응답을 방송하고 `talk_action`을 실행한다. 맞지 않으면 "어깨를 으쓱"하고, MTLKAG면 적대한다.

**talk_action** (command8.c:883): 매칭된 대화가 트리거하는 행동이다(`tt->type`).
- **1 = attack**: `add_enm_crt`하고 공격을 방송한다.
- **2 = action**: 몬스터가 소셜 명령(`tt->action`)을 실행한다. 대상이 `PLAYER`면 그 플레이어를 지정한다.
- **3 = cast**: `tt->action`의 스펠명을 spllist에서 찾아 시전한다. 공격 스펠이면 offensive_spell을 쓰고, 이미 적이면 시전을 거부한다.
- **4 = give**: `tt->action`의 objnum 아이템을 준다. 무게, 150개 한도, 퀘스트를 검사한다([[a8-items-economy]]).

즉 대화는 **데이터 기반 상태 기계**(키워드→응답+부수효과)다. 신규 스택에서 대화 파일을 JSON(키워드→{응답, action 타입, 파라미터})으로 옮기면 그대로 이식된다.

### 7.2 periodic talk (dead) — MSAYTLK / LT_SAYTLK

`MSAYTLK`("말하는 몹", mtype.h:471)와 `LT_SAYTLK`(mtype.h:201)는 몬스터가 **주기적으로 스스로 말하는** 기능을 위해 정의됐다. 그러나 전체 `.c`를 grep하면 MSAYTLK는 DM 상태 표시(dm2.c:449 `"continue talk, "`)에만 나오고, LT_SAYTLK는 어디에서도 읽지 않는다. `update_active`에서 쓰지 않는 `talkbuf[32][256]` 스캐폴드(§3)가 이 기능을 만들다 만 흔적이다. 그래서 **설정만 할 수 있고 동작은 없는 데드 코드**로 분류한다. 이식할 때는 §6의 MFLEER와 마찬가지로 "재현=무시 / 재설계=신규 구현"을 결정 게이트에서 정한다.

## 8. 사망·charm·소환 (콘텐츠 → 수치는 a5/a8)

- **die** (creature.c:262): 몬스터가 죽으면 다음을 처리한다.
  - 적 리스트의 damage에 비례해 경험치를 분배한다([[a5-combat]]).
  - 인벤토리와 gold를 바닥에 떨어뜨린다([[a8-items-economy]]).
  - MPERMT면 `die_perm_crt`로 리스폰 타이머를 리셋한다(§2.1).
  - charm을 해제하고 `del_active`+`del_crt_rom`+`free_crt`를 호출한다.
  - 플레이어 사망 분기(경험치 감소, 레벨 강등, 1008호(사망 방)로 이동 등)는 [[a7-player-progression]]과 [[a5-combat]]가 담당한다.
- **charm** (MCHARM, creature.c:721~812): `is_charm_crt`/`add_charm_crt`/`del_charm_crt`가 플레이어별 매혹 몬스터 리스트(`Ply[fd].extr->first_charm`)를 관리한다. 매혹된 몬스터는 시전자를 공격하지 않는다(update.c:345, `p=1`). LT_CHRMD가 만료되면 풀린다.
- **die_perm_crt의 부수효과**: 퀘스트 몬스터(`questnum`)면 퀘스트를 완료하고 경험치를 준다. MDEATH면 `ddesc/` 파일의 사후 묘사를 방송한다. MSUMMO면 `summon_crt`로 부하를 소환한다(§2.4).

## 콘텐츠(이식) vs 구현 방식(재설계) 분류

| 항목 | 콘텐츠 (충실히 이식) | 구현 방식 (자유롭게 재설계) |
|------|---------------------|----------------------|
| 활성 집합 | "플레이어 근처의 몬스터만 시뮬레이션"하는 원칙 | `first_active` 단일 연결 리스트, malloc/free ctag, head 삽입, O(n) del |
| 고정 스폰 | 방별 고정 몬스터, 사망 후 interval 리스폰, 중복 방지 | perm_mon[10] lasttime 배열, **입장 시 lazy 재검사** |
| 배회 스폰 | 진입 확률=traffic, 그룹 크기(numwander/RPLWAN), 20초 주기 감각 | update_random 폴링, check[]로 방 중복 제거 |
| 침공 이벤트 | 주기적 몬스터 물결 + 전역 방송 | **하드코딩된 방/몬스터 번호 범위**(8000~8300·3601~3630, 732~755·265~299), 4000·5000초 |
| AI 주기 | 민첩에 연동된 공격 간격(2~3초) | 매 초 폴링 + LT_ATTCK 타이머, last_*_update statics |
| 재생 | 60초마다 HP hpmax/10 · MP mpmax/6, 밀린 만큼 소급 적용 | while 루프 catch-up |
| scavenge | 20초/15%, 아이템 플래그 존중, MHASSC | 바닥 first_obj 직접 접근 |
| wander-out | 배회 몬스터의 확률 퇴장(=traffic) | free_crt로 즉시 메모리 회수 |
| 어그로 | piety 역가중 랜덤, 성향·레벨 필터, 민첩 30% 회피 | lowest_piety/low_piety_alg 2회 순회 |
| 공격성 3종 | MAGGRE/MGAGGR/MEAGGR의 의미 | 비트 플래그 인덱스 |
| 적 리스트 | FIFO 큐, damage 누적, 타깃 이탈 시 회전, 다중 자동반격 | etag 리스트, **주석과 코드 불일치**(add_enm_crt) |
| 특수 공격 | breath 4변종·드레인·독·질병·실명·용해의 발동율 | dice() 호출, F_ISSET 분기 |
| 아이템 파괴 | 피격 시 착용품 소모, 파괴 시 AC 재계산 | choose_item checklist |
| 도주 | 플레이어 PWIMPY/PFEARS 임계 | **몬스터 도주 = 데드(check_for_flee `return;`)** |
| 대화 | 대화형 키워드→응답+action(공격/소셜/시전/지급), MTLKAG | 대화 파일 ttag 리스트, **주기 발화(MSAYTLK) = 데드 스캐폴드** |
| 소지 랜덤화 | carry[] 1~3개(90/6/4%), value ±10%, ORENCH 인챈트, MNRGLD gold | mrand 호출 위치 |
| 사망 | die() 트리거, 리스폰 리셋, 퀘스트, MSUMMO 소환 | free_crt/링크드 리스트 정리, goto crt_died |

## 아키텍처 시사점

1. **활성 집합은 방 점유 이벤트로 관리하는 스케줄러로 만든다.** 매 틱 `first_active`를 훑으며 방이 비었는지 확인하지 않는다. 대신 방→몬스터 인덱스와 플레이어 입장/퇴장 이벤트로 활성 집합을 조금씩 갱신하고, active 몬스터만 라운드 스케줄러(EventEmitter/타이머 휠)에 등록한다. "빈 방에서는 시간이 멈춘다"는 의미는 유지한다. 방이 비어 있는 동안 몬스터 상태(HP, 적, 타이머)는 진행하지 않는다.

2. **스폰 3모델을 명시적인 트리거 타입으로 통일한다.**
   - (a) perm은 **입장 훅**이다. 방에 들어올 때 리스폰 레코드를 검사한다.
   - (b) random은 **인터벌 틱**이다. 방별 traffic 확률을 쓴다.
   - (c) invasion은 **스크립트 이벤트**다. 몬스터 풀, 주기, 좌표, 방송을 데이터로 정의한다.

   하드코딩된 침공 좌표는 이벤트 설정으로 옮긴다.

3. **리스폰은 사망 타임스탬프 + lazy 재계산과 스케줄 잡 중 하나를 고른다.** 원본의 "사망 시각을 기록하고 다음 입장 때 경과 시간을 계산하는" 방식은 상태를 최소로 유지하는 좋은 패턴이다. MongoDB에 방 인스턴스별 `perm_mon` 사망 타임스탬프를 저장하고, 입장할 때나 드물게 도는 스윕에서 리젠 여부를 판정한다. 스케줄러 잡으로 바꿔도 되지만, 빈 방에까지 잡을 거는 비용을 피하려면 lazy가 유리하다.

4. **AI 틱은 몬스터별 다음 행동 시각을 담은 우선순위 큐로 처리한다.** 매 초 전체를 순회하지 않고, active 몬스터마다 다음 행동 시각(민첩에 따라 2~3초)을 힙에 넣어 때가 된 것만 처리한다. 재생, scavenge, wander, 전투는 몬스터 상태에 붙은 개별 타이머로 나눈다.

5. **어그로 타깃은 piety 역가중 랜덤 공식을 그대로 이식한다.** `MAX(1, 25−piety)` / `MAX(1, 30−piety)` 가중치, 성향 필터(±100), 레벨 티어 필터, 민첩 30% 회피는 게임 밸런스의 일부이므로 수치까지 보존한다.
   - 단 `low_piety_alg`의 레벨 필터는 두 루프 중 첫 번째(가중치 합산)에만 있고 선택 루프에는 없다. 이것은 **원본의 비대칭**이다. 신규 구현이 "저렙은 완전히 제외"로 정리하면 밸런스가 미묘하게 달라진다.
   - as-shipped 재현이 기본이라면 이 비대칭까지 재현할지, 의도를 살려 정리할지 명시적으로 결정한다.
   - 적 리스트는 FIFO 큐, 이탈 시 회전, 다중 자동반격의 의미를 재현한다. 다만 add_enm_crt의 주석은 무시하고 코드 동작(끝에 추가)을 따른다.

6. **대화는 데이터 기반 상태 기계로 만든다.** 몬스터 대화 파일을 JSON(키워드→{응답, action: attack/social/cast/give, 파라미터})으로 이식하면 talk_action 분기가 그대로 대응된다. 정적 talk 문자열과 MTLKAG(대화 후 적대)도 몬스터 데이터 필드로 유지한다.

7. **데드 스캐폴드는 이식하지 않고 결정 게이트에 올린다.** 몬스터 도주(MFLEER/check_for_flee)와 주기 발화(MSAYTLK/LT_SAYTLK/talkbuf)는 데이터에 플래그는 있지만 동작이 없다. as-shipped를 충실히 재현하면 이 둘은 무시된다. 원저자의 의도를 살려 **신규 기능으로 구현**하는 일은 별도 범위다. 포팅 원칙([[muhan-port-principle]])은 "동작을 충실히 재현"하는 것이 기준이다. 따라서 기본값은 재현(=구현하지 않음)이고, 되살리려면 명시적으로 결정한다.
