# A8 아이템·장비·경제·은행

> 무한의 아이템 체계(타입 taxonomy·착용/장비 규칙·object 필드), 경제(금화·가치·상점·전당포·수리·거래), 은행이 oracle에서 *무엇을 하는지*를 규명한다. 아이템 속성·가격 배수·착용 게이트·거래 규칙은 게임 규칙이므로 충실히 이식하고, 은행=별도 object 파일 컨테이너·`ready[]` 포인터 배열 비직렬화·상점 재고=인접방 규약·gold signed long 무가드는 형상이므로 자유롭게 재설계한다. 이슈 #8. 출처는 `legacy/muhan/src`(EUC-KR, byte-level)와 변환 산출물 `data/world/objects.json`. 코드 이식이 아니라 동작 추출.
>
> **oracle 읽기 주의**: 하네스 `grep` 래퍼가 `-I`(binary skip)를 붙여 EUC-KR 파일을 스킵한다. `command grep -a` 또는 `iconv -f EUC-KR -t UTF-8 -c … | grep`로 우회한다([[muhan-oracle-toolchain]]).
>
> **전투·마법·진행 공식은 재유도하지 않는다**: 무기 데미지·명중·숙련은 [[a5-combat]], 물약/두루마기/지팡이의 주문 시전은 [[a6-magic]], AC/thaco 폐형 공식·스탯 보정은 [[a7-player-progression]]에 이미 확정돼 있다. 본 노트는 그 공식들에 **아이템이 기여하는 항**(장비 armor 합산·무기 adjustment 명중 보정)만 얹는다.

## 개요

무한의 아이템은 전부 **`object` 구조체 하나**(352바이트)로 표현된다. 방·몬스터·플레이어 인벤토리·은행이 모두 같은 구조체를 담고, 같은 직렬화(`read_obj`/`write_obj`)를 쓴다([[a4-movement-rooms]]). 아이템의 성격은 **`type` 필드(0~14)** 하나로 갈린다: 무기 5종(0~4), 방어구·물약·두루마기·지팡이·컨테이너·돈·열쇠·광원·기타(5~13), 그리고 help엔 없는 CONTAINER2(14).

아이템의 게임 동작은 세 축이다. ① **착용/장비** — 방어구는 `wear`, 무기는 `ready`, 쥠물건은 `hold`가 처리하며, 각각 `creature.ready[20]` 슬롯 배열의 정해진 칸에 포인터를 꽂는다. 착용 효과(AC·명중)는 필드를 직접 가감하지 않고 **`ready[]` 전체를 매번 재계산**(`compute_ac`/`compute_thaco`)한다 — [[a7-player-progression]] §12의 "파생 스탯은 유효 상태의 함수" 원칙과 정확히 일치한다. ② **소비** — 물약/지팡이는 사용 시 `shotscur--`로 충전이 닳고, 소진되면 부서진다. ③ **경제** — `object.value`(long) 하나가 모든 가격의 기준이며, 상점 구매(100%)·전당포 판매(50%)·수리(25%)·몬스터 상점(max(10,value))이 그 위에 상수 배수로 얹힌다.

착용은 **다층 게이트**를 통과해야 한다: 클래스·성별·결혼·정렬·종족 크기 제한, 그리고 **아이템 강도에 비례한 레벨 요구**(방어구 `armor*5`, 무기 `(ndice·sdice+pdice)*3`). 게이트를 넘는 초강력 아이템(방어구 AC환산 >151, 무기 dice합 >39)은 착용 시도 시 **"푸른 연기와 함께 사라진다"** — 밸런스를 벗어난 아이템을 자동 소각하는 방어 장치다.

은행은 구조적으로 특이하다. 잔고는 `creature` 필드가 **아니라** 플레이어별 **별도 object 파일**(`PLAYERPATH/bank/<이름>`)이며, 그 object가 컨테이너로 동작해 현금은 `value`에, 보관 물품은 중첩 인벤토리에 담긴다. 이자는 없다(단순 금고). 이 "은행=object 파일" 형상이 신규 스택의 계좌 모델(MongoDB 문서)을 가른다.

핵심 분리: **타입 taxonomy·착용 슬롯·레벨/직업/성별/크기 게이트·가격 배수(100/50/25%)·소지 한도(150/200)·몹 소지금 랜덤화·거래 거부 조건은 콘텐츠**(충실히 이식), **은행=별도 object 파일 컨테이너·`ready[]` 포인터 배열·상점 재고=`rom_num+1` 인접방·gold signed long 무가드·time(0) 기반 확률·데드 statement는 형상**(재설계).

## 핵심 발견 요약

| # | 발견 | 분류 |
|---|------|------|
| 1 | **아이템 = `object` 352B 단일 구조체.** type 0~14로 성격 결정. 무기 0~4(Sharp/Thrust/Blunt/Pole/Missile), 5~13(Armor·Potion·Scroll·Wand·Container·Money·Key·LightSource·Misc), 14(Container2, help 미기재) | 콘텐츠(taxonomy) |
| 2 | **착용 = `ready[20]` 슬롯 배열.** wearflag(1~20)이 슬롯 인덱스(`ready[wearflag-1]`). BODY·팔·다리·목×2·손·머리·발·손가락×8·쥠·방패·얼굴·무기. 방어구=`wear`, 무기=`ready`, 쥠=`hold` | 콘텐츠(장비) |
| 3 | **착용 효과는 필드 직접변형 아님 — `ready[]` 재계산.** `compute_ac`=`… − Σ ready[i]->armor …`, `compute_thaco`=`… − ready[WIELD]->adjustment …`. wear/ready/remove가 재계산 트리거. [[a7-player-progression]] §12 원칙과 일치 | 콘텐츠(공식)/형상(트리거) |
| 4 | **착용 다층 게이트.** 클래스(ONOMAG·OCLSEL)·성별(ONOFEM=남/ONOMAL=여, 명명 역전)·결혼(OMARRI)·정렬(OGOODO/OEVILO ±50)·종족크기(OSIZE 3계급)·**레벨(방어구 armor*5, BODY armor*2 / 무기 dice합*3)** | 콘텐츠(규칙) |
| 5 | **밸런스 초과 아이템 자동 소각.** 착용 시 방어구 AC환산 >151, 무기 `ndice·sdice+pdice` >39, shots >600 → questnum·ONEWEV 아니면 free("푸른 연기와 함께 사라집니다") | 콘텐츠(가드) |
| 6 | **소비 아이템 = `magicpower-1` 스펠 시전.** Potion=`drink`, Scroll=`readscroll`, Wand=`zap` → `shotscur--` → [[a6-magic]] spllist[magicpower-1]를 각 컨텍스트로 시전. 무기 데미지는 [[a5-combat]] | 콘텐츠(→a6/a5) |
| 7 | **가격 = `object.value` 단일 필드 × 상수 배수.** 상점구매=value(1:1), 전당포판매=min(value/2, 10만), 수리=value/4, 몹구매=max(10, value) | 콘텐츠(경제) |
| 8 | **상점 재고 = 인접방 `rom_num+1` object를 복제, 무소진.** buy는 창고방에서 로드→복제 지급. 몹 상점(MPURIT)은 `carry[]` objnum 템플릿 복제(무한 재고) | 콘텐츠(규칙)/형상(방 규약) |
| 9 | **금화 = `creature.gold`(long, offset 348) 무가드.** 몹 처치 시 `die()`가 gold를 바닥의 MONEY object로 변환. 몹 소지금은 스폰 시 `mrand(gold/10, gold)` 랜덤(MNRGLD면 고정) | 콘텐츠(드롭)/형상(무가드) |
| 10 | **상점/서비스 방 = room flag.** RSHOPP=0(상점)·RPAWNS=2(전당포)·RREPAI=7(수리)·RDUMPR=1(덤프)·RBANK=39(은행)·RMARRI=41(결혼) | 콘텐츠(게이트)/형상(비트) |
| 11 | **은행 = 별도 object 파일 컨테이너.** `bank/<이름>` 파일, 현금=`object.value`, 물품=중첩 인벤토리(슬롯 200). 입금/출금/잔액/보관물/받아. **이자 없음, 3억 상한, 수수료·이체 없음** | 형상(영속화) |
| 12 | **거래 다중 거부.** 판매: gold<20·저품질(shots≤max/8)·ONEWEV·컨테이너내용·두루마기/물약. 양도: questnum·ONEWEV·이벤트. 습득: ONOTAK·OSCENE·MGUARD 감시 | 콘텐츠(규칙) |
| 13 | **소지 한도 = 무게 + 개수(150/200).** get/give/purchase=150, buy=200(장착 포함 count_inv). 무게는 `max_weight(ply)`([[a7-player-progression]]) 초과 시 거부 | 콘텐츠(한도) |

---

## 1. object 구조체와 타입 taxonomy (콘텐츠)

아이템은 **352바이트 `object` 구조체**다(`mstruct.h:112–135`). 검증된 오프셋 테이블은 `port/templates.js`의 `OBJ`이며([[muhan-mud-port]]), 이 노트가 참조하는 필드는:

| 필드 | 오프셋 | 자료형 | 의미 |
|---|---|---|---|
| `name` | 0 | char[80] | 이름(EUC-KR) |
| `description` | 80 | char[80] | 설명 |
| `key[3][20]` | 160 | char | 인식 키워드 3개(key[2]는 ONEWEV 소유자명으로 오버로드) |
| `use_output` | 220 | char[80] | 착용/장착 시 출력 |
| `value` | 300 | long | **가치/가격**(§7·8) |
| `weight` | 304 | short | 무게 |
| `type` | 306 | char | **타입 0~14** |
| `adjustment` | 307 | char | 무기 명중+피해 보정(+N) |
| `shotsmax/shotscur` | 308/310 | short | 사용/내구 횟수 |
| `ndice/sdice/pdice` | 312/314/316 | short | 데미지 주사위([[a5-combat]]) |
| `armor` | 318 | char | **AC 기여**(§3) |
| `wearflag` | 319 | char | **착용 슬롯 1~20**(§2) |
| `magicpower` | 320 | char | 소비 시 시전할 스펠 번호+1([[a6-magic]]) |
| `magicrealm` | 321 | char | 마법 계열 |
| `special` | 322 | short | 특수 동작 파라미터 |
| `flags[8]` | 324 | char | **비트필드**(§6) |
| `questnum` | 332 | char | 임무 번호(대부분의 파괴/게이트를 우회) |
| `first_obj` | 336 | ptr | 중첩 인벤토리(컨테이너) |

### 타입 상수 (`mtype.h:123–139`)

| type | 상수 | 게임 동작 |
|---|---|---|
| 0 | SHARP | 무기(검류). type ≤ MISSILE(4)이 "무기" 판정 관용구 |
| 1 | THRUST | 무기(찌르기) |
| 2 | BLUNT | 무기(둔기) |
| 3 | POLE | 무기(장병기) |
| 4 | MISSILE | 무기(투척/원거리) |
| 5 | ARMOR | 방어구. `armor` 필드가 AC 기여 |
| 6 | POTION | 물약. `drink`로 소비 → 스펠 시전 |
| 7 | SCROLL | 두루마기. `readscroll`로 시전 + `study`로 학습 |
| 8 | WAND | 지팡이. `zap`으로 시전 |
| 9 | CONTAINER | 컨테이너. 담기/꺼내기(OCONTN) |
| 10 | MONEY | 돈. 줍기 시 gold로 흡수 |
| 11 | KEY | 열쇠. shotscur = 사용 횟수 |
| 12 | LIGHTSOURCE | 광원(OLIGHT) |
| 13 | MISC | 기타. 특수 동작 없음 |
| 14 | CONTAINER2 | `mtype.h:132`에 정의되나 `help/otypes`엔 없음. 2차 컨테이너 변형(월드 데이터 실사용 여부 미확인 — 변환 시 별도 확인 필요) |

> **타입 열거 주의**: `help/otypes`는 0~13만 문서화하지만 헤더는 `CONTAINER2=14`를 추가 정의한다. 이식 시 타입 도메인은 **0~14**로 잡고, 14의 실제 사용을 `data/world/objects.json`에서 카운트해 확정한다.

무기군(0~4)은 **물리 데미지에 type별 배수가 없다** — type은 오직 **proficiency(무기 숙련) 계산 키**로만 쓰인다(`command5.c:240` `mod_profic`, [[a5-combat]]). 즉 검·둔기·장병기의 차이는 데미지 공식이 아니라 숙련 성장·명중에서 나온다.

---

## 2. 착용 슬롯과 `wear()` 게이트 (콘텐츠)

플레이어는 **`ready[MAXWEAR]` 포인터 배열**로 착용 아이템을 든다(`mstruct.h:204` `struct object *ready[MAXWEAR]`, `MAXWEAR=20`). `wearflag`(1~20)이 슬롯 인덱스이며 슬롯은 `ready[wearflag-1]`이다.

### 슬롯 매핑 (`mtype.h:206–230`)

| wearflag | 슬롯 | 부위 | 처리 명령 |
|---|---|---|---|
| 1 | BODY | 몸 | wear |
| 2 | ARMS | 팔 | wear |
| 3 | LEGS | 다리 | wear |
| 4 / 5 | NECK1 / NECK2 | 목(2칸) | wear |
| 6 | HANDS | 손 | wear |
| 7 | HEAD | 머리 | wear |
| 8 | FEET | 발 | wear |
| 9–16 | FINGER1–8 | 손가락(8칸) | wear |
| 17 | HELD | 쥔 물건 | hold |
| 18 | SHIELD | 방패 | wear |
| 19 | FACE | 얼굴 | wear |
| 20 | WIELD | 무기 | ready |

목은 2칸, 손가락은 8칸, 나머지는 1칸이다. `wearflag==WIELD`(무기)나 `HELD`(쥠)는 `wear`가 거부하고 각각 `ready`·`hold`로 라우팅한다.

### `wear()` 게이트 순서 (`command3.c:21`)

```c
if(!obj_ptr->wearflag || obj_ptr->wearflag == WIELD || obj_ptr->wearflag == HELD) {
    print(fd, "%I%j 입는 물건이 아닙니다."); return(0);      // 무기·쥠물건은 여기서 컷
}
```

이후 순차 검사(모두 통과해야 착용):

1. **직업**: ARMOR + `ONOMAG` + (MAGE 또는 CLERIC) → 거부("도술사, 불제자들은 사용할수 없습니다").
2. **성별**: `ONOFEM` + 여성 → 거부("남자들만"), `ONOMAL` + 남성 → 거부("여자들만"). **플래그 명명이 직관과 반대**(ONOFEM="Usable by only males").
3. **내구 소각**: `shotsmax > 1001 || shotscur > 1001` + questnum==0 → free.
4. **레벨 게이트**(`command3.c:88`):
   ```c
   if(obj_ptr->wearflag == BODY) check_ac = obj_ptr->armor * 2;
   else                          check_ac = obj_ptr->armor * 5;
   if(check_ac > 151 && obj_ptr->questnum == 0) { free; "푸른 연기와 함께 사라집니다"; }
   if(check_ac < 30) check_ac = 0;
   if(ply_ptr->class < INVINCIBLE && questnum==0 && !ONEWEV && ply_ptr->level < check_ac)
       "당신의 능력으로는 사용할 수 없는 물건입니다.";
   ```
   방어구 강도(`armor`)에 비례한 레벨 요구. BODY는 배수가 2배로 낮다(몸통 방어구는 armor가 크므로 완화). AC환산 30 미만은 요구 레벨 0.
5. **결혼**: ARMOR + `OMARRI` + 미혼(PMARRI 없음) → 거부.
6. **슬롯 점유**: NECK1·NECK2 둘 다 참 → "더이상 목에 걸 수 없습니다". FINGER1~8 전부 참 → "더이상 손가락에 낄 수 없습니다". 그 외 부위는 `ready[wearflag-1]`이 이미 있으면 "이미 착용 중".
7. **파손**: `shotscur < 1` → "부서져서 입을 수 없게 되었습니다".
8. **정렬**: `OGOODO` + alignment < −50 → 튕겨냄(바닥으로). `OEVILO` + alignment > 50 → 튕겨냄.
9. **직업 선택 무기/방어구**: `OCLSEL` 세트면 `OCLSEL + class` 비트가 켜져야 착용 가능(§6).
10. **종족 크기**(§6): `OSIZE1·OSIZE2` 조합이 종족과 안 맞으면 거부.

통과 시 슬롯 설정(`command3.c:195`) → `compute_ac(ply_ptr)` 재계산 → `F_SET(OWEARS)`:

```c
switch(obj_ptr->wearflag) {
case BODY: case ARMS: ... case SHIELD:
    ply_ptr->ready[obj_ptr->wearflag-1] = obj_ptr; break;    // 단일 부위
case NECK:
    if(ready[NECK1-1]) ready[NECK2-1]=obj; else ready[NECK1-1]=obj; break;
case FINGER:
    for(i=FINGER1; i<FINGER8+1; i++) if(!ready[i-1]){ ready[i-1]=obj; break; } break;
}
compute_ac(ply_ptr);
```

`wear_all`(`command3.c:287`)은 인벤토리를 순회하며 동일 게이트를 반복(임계 `>150` 등 동일). `remove`/`remove_all`(`command3.c:564`)은 `OCURSE`(저주) 아이템을 스킵하고(`command3.c:574`), 벗긴 뒤 `compute_ac`+`compute_thaco` 재계산, `F_CLR(OWEARS)`·`F_CLR(OWHELD)`.

---

## 3. 무기 장착 `ready()`·쥠 `hold()` (콘텐츠)

무기는 **단일 WIELD 슬롯**이다(양손/한손 구분 없이 한 자루만). `ready()`(`command3.c:691`):

1. `wearflag != WIELD` → "무장할 수 없습니다".
2. **마법사 무기 제한**: (SHARP 또는 THRUST) + `ndice·sdice+pdice > 14` + (MAGE/CLERIC) → 거부. 약한 단검류만 허용.
3. **성별**(SHARP/THRUST 한정 ONOFEM/ONOMAL).
4. **슬롯 점유**: `ready[WIELD-1]` 있으면 "이미 무장하고 있습니다".
5. **직업 선택**(OCLSEL), **정렬**(OGOODO/OEVILO → 바닥으로), **종족 크기**(§6).
6. **밸런스 소각**: `ndice·sdice+pdice > 39`, `shotsmax/cur > 600`, `ONSHAT && OALCRT` → questnum·ONEWEV 아니면 free("푸른 빛을 내며 사라집니다").
7. **레벨 게이트**(`command3.c:820`):
   ```c
   check_dmg = obj_ptr->ndice * obj_ptr->sdice + obj_ptr->pdice;
   if(class == FIGHTER)               check_dmg -= 7;   // 전투 직업 완화
   if(class == ASSASSIN || THIEF)     check_dmg -= 3;
   if(class == PALADIN || RANGER)     check_dmg -= 2;
   if(class < INVINCIBLE && check_dmg > 15 && !ONEWEV && level < check_dmg*3 && questnum==0)
       "당신의 능력으로는 사용할 수 없는 무기입니다.";
   ```
   무기 dice 기대 데미지에 비례한 레벨 요구(`dice합 × 3`), 물리 직업은 −7/−3/−2로 완화.
8. **개인 귀속**: `ONEWEV` + `key[2] != 플레이어 이름` → "다른 사람의 물건은 사용할 수 없습니다"(소유자 바인딩).

통과 시 `ready[WIELD-1] = obj` → `compute_thaco(ply_ptr)` → `F_SET(OWEARS)`.

**방패**는 wearflag=SHIELD(18)이라 `ready()`가 아니라 `wear()`가 처리한다(`ready[SHIELD-1]`, AC 기여). **쥠 물건**은 `hold()`(`command3.c:860`): wearflag이 HELD 또는 WIELD여야 하고, 임무템·이벤트템·강력 무기(dice합 >100)는 거부, `type < ARMOR`(무기)를 쥐면 `F_SET(OWHELD)`. HELD 무기는 근접 시 보조 데미지(`+mdice(HELD)/10`, [[a5-combat]])를 준다.

---

## 4. 착용 스탯 효과: `ready[]` 재계산 (콘텐츠 공식 / 형상 트리거)

**착용은 능력치 필드를 직접 가감하지 않는다.** wear/ready/remove는 슬롯 포인터를 꽂거나 비운 뒤 파생 스탯을 **`ready[]` 전체에서 다시 계산**한다. [[a7-player-progression]] §11·§12에서 확정한 폐형 공식에 아이템이 기여하는 항만 여기 적는다:

- **AC(방어)**: `compute_ac`(`player.c:971`)는 `100 − 5·bonus[dex] − (Σ ready[i]->armor) − (PPROTE ? 10 : 0)`, clamp[−127,127]. **아이템 기여 = 착용 방어구의 `armor` 필드 총합**. 방패도 `armor`로 합산된다. (기저 공식·dex 항은 [[a7-player-progression]] §11.)
- **thaco(명중)**: `compute_thaco`(`player.c:1001`)는 `thaco_list[class][circle] − ready[WIELD-1]->adjustment − mod_profic − bonus[str]`. **아이템 기여 = 착용 무기의 `adjustment`(+N)**. `circle=(level+3)/4` 인덱싱과 나머지 항은 [[a7-player-progression]] §11.

즉 무기의 `adjustment`는 **명중에만**, `armor`는 **AC에만** 들어간다. 데미지의 무기 기여(`ndice/sdice/pdice`)는 [[a5-combat]]에서 다룬다.

> **형상 함의**: 착용 효과가 `ready[]` 재계산으로 구현된 건 [[a7-player-progression]] §12의 "유효 스탯 = 순수 함수" 방향과 이미 부합한다. 다만 트리거가 **수동**(wear/ready/remove가 `compute_ac`/`compute_thaco`를 직접 호출)이라 호출 누락 시 stale해진다. 신규 스택은 AC/thaco를 `ready[]`에 대한 파생값으로 두고 슬롯 변경 시 무효화(또는 조회 시 계산)해 수동 호출을 제거한다.

착용 상태 플래그: **`OWEARS`(23)** = 착용 중(프롬프트에 흔한 `OWORN`은 **존재하지 않음**), **`OWHELD`(49)** = 쥠. 이 플래그는 인벤토리 목록·저장/로드 시 착용 여부 복원에 쓰인다.

---

## 5. 아이템 소비: 물약·두루마기·지팡이 (콘텐츠 → [[a6-magic]])

소비 아이템 3종은 모두 **`magicpower` 필드가 가리키는 스펠을 시전**하고 충전을 소모한다:

| type | 명령 | 핸들러 | 소모 | 시전 컨텍스트 |
|---|---|---|---|---|
| POTION(6) | 마시기 | `drink`(`magic1.c:496`) | `shotscur--` | `spllist[magicpower-1]`를 POTION 컨텍스트로 |
| SCROLL(7) | 읽기 | `readscroll`(`magic1.c:352`) | (소모) | SCROLL 컨텍스트 + `study`로 스펠 학습 가능 |
| WAND(8) | 쏘기 | `zap`(`magic1.c:673`) | `shotscur--` | WAND 컨텍스트, `magicrealm`=계열 |

시전되는 스펠 본체(효과·데미지·지속·마법 저항)는 [[a6-magic]]의 `spllist`/`ospell` 테이블이 정본이다. 본 노트 관점의 핵심은 **아이템이 스펠의 배달 수단**이라는 것: `magicpower-1`이 스펠 인덱스, `shotscur`가 남은 사용 횟수, 두루마기는 추가로 `study`(학습) 경로를 연다. 지팡이/열쇠는 `shotscur < 1`이면 고갈된 것으로 판정된다(전당포도 이를 저품질로 거부, §8).

---

## 6. object 플래그 (콘텐츠)

`flags[8]`은 64비트 비트필드다(`mtype.h:476–526`, `F_ISSET(obj, BIT)`). 아이템·거래에 관여하는 비트:

| 비트 | 상수 | 의미 |
|---|---|---|
| 6 | OCONTN | 컨테이너 |
| 7 | OWTLES | 무게 없는 보관(내부물 무게 미합산) |
| 10 | ONOMAG | 마법사·성직자 착용/사용 불가 |
| 11 | OLIGHT | 광원 |
| 12 / 13 | OGOODO / OEVILO | 선(align≥−50) / 악(align≤50) 전용 |
| 14 | OENCHA | 인챈트됨 |
| 17 | ONOTAK | 습득 불가 |
| 18 | OSCENE | 방 배경(습득 불가) |
| 19 / 20 | OSIZE1 / OSIZE2 | 부위 크기(§ 아래) |
| 21 | ORENCH | 랜덤 인챈트 대상 |
| 22 | OCURSE | 저주(벗기 거부) |
| 23 | OWEARS | 착용 중 |
| 25 | OCNDES | 담긴 아이템을 삼키는 컨테이너 |
| 26 / 27 | ONOMAL / ONOFEM | 여성 전용 / 남성 전용(**명명 역전**) |
| 28 | ODDICE | object dice 기반 데미지 |
| 31 | OCLSEL | 직업 선택 무기 |
| 32–39 | OASSNO…OTHIEO | 직업별 비트(`OCLSEL + class`) |
| 45 | OMARRI | 기혼자 전용 |
| 46 | OEVENT | 이벤트 아이템 |
| 49 | OWHELD | 쥠 |
| 50 | ONEWEV | 개인 귀속(key[2]=소유자명) |

### 종족 크기 제한 (OSIZE, `command3.c:168`·`774`)

```c
i = (F_ISSET(obj_ptr, OSIZE1) ? 1:0) * 2 + (F_ISSET(obj_ptr, OSIZE2) ? 1:0);
switch(i) {
case 1: /* 소형 */ 착용가능 = GNOME/HOBBIT/DWARF만;
case 2: /* 중형 */ 착용가능 = HUMAN/ELF/HALFELF/ORC만;
case 3: /* 대형 */ 착용가능 = HALFGIANT만;
/* 0 = 제한 없음 */
}
```

3계급(소/중/대) 크기로 종족을 게이트한다. 이는 [[a7-player-progression]] §7이 "종족 효과 3종" 중 하나로 지목한 "장비 크기 제한"의 구현부다. `class < INVINCIBLE`만 적용(승급자는 무시).

### 직업 선택 무기 (OCLSEL, `command3.c:163`)

```c
if(F_ISSET(obj_ptr, OCLSEL))
  if(!F_ISSET(obj_ptr, OCLSEL + ply_ptr->class) && class < INVINCIBLE)
      "당신의 직업에 맞지 않습니다.";
```

`OCLSEL`(31)이 켜지면 `OCLSEL + class` 비트(32~39, OASSNO=자객…OTHIEO=도둑)가 해당 직업에 켜져 있어야 착용/장착 가능. class 열거가 1부터 시작해 `OCLSEL+class`가 직업 비트와 정렬된다([[a7-player-progression]] §6 클래스 상수).

### rand_enchant 확률표 (`object.c:258`)

`ORENCH`(랜덤 인챈트) 아이템은 생성 시 인챈트가 굴려진다:

```c
m = mrand(1,100);
if(m > 98)      { OENCHA; adjustment=3; pdice+=3; }   // 3%
else if(m > 90) { OENCHA; adjustment=2; pdice+=2; }   // 8%
else if(m > 50) { OENCHA; adjustment=1; pdice+=1; }   // 40%
/* ≤50: 변화 없음 (50%) */
obj_ptr->pdice = MAX(obj_ptr->pdice, obj_ptr->adjustment);
```

+1(40%)/+2(8%)/+3(3%)/변화없음(50%). adjustment는 명중·데미지에, pdice는 데미지에 반영된다.

---

## 7. 금화 경제 (콘텐츠 규칙 / 형상 필드)

금화는 **`creature.gold`**(long, offset 348, `mstruct.h:189`)다. **상한·음수 가드가 없다** — 어디서도 clamp하지 않고, 가문 가입 시 `+= family_gold*10000`, 불태우기 대박 시 `+= 100000`까지 더한다.

**금화 증감 지점**(`command grep`으로 전수):

- **몹 처치 드롭**(`creature.c:331`): `die()`가 몹의 `gold`가 있으면 `load_obj(0,…)`(objnum 0 = 머니 템플릿)로 MONEY object를 만들어 `obj->value = crt->gold`로 설정하고 방에 떨군다. 즉 **몹의 소지금이 그대로 바닥의 "N냥" 오브젝트로 변환**된다.
- **몹 소지금 랜덤화**(`creature.c:879`): 스폰 시 `if(!MNRGLD && crt->gold) crt->gold = mrand(gold/10, gold)` — 고정금액 플래그(MNRGLD=25)가 없으면 소지금을 10~100% 사이로 랜덤. 몹 재고 아이템도 `value = mrand(value·9/10, value·11/10)`로 ±10% 변동(`creature.c:872`).
- **줍기**(`command2.c:807/888/990/1105`, 은행 553): `if(type==MONEY){ gold += value; free_obj; }` — 오브젝트 소멸, gold 흡수.
- **떨구기**(`drop_money`, `command2.c:1444`): `load_obj(0)`로 MONEY object 생성, `name="N냥"`, `value=amt`, 방에 add, `gold -= amt`.
- **양도**(`give_money`, `command8.c:143`): `"N냥"` 접미사 파싱, `amt<1 || amt>gold` 거부, 받는 쪽 `gold += amt` / 주는 쪽 `gold -= amt`. **세금·수수료 없음**.
- **잡수입**: 불태우기 `gold += 4` + 1/250 확률 `gold += 100000`(`command2.c:1742`); 가문 가입(`command11.c:638`).

---

## 8. 상점·전당포·수리·거래 (콘텐츠 공식)

서비스는 **방 플래그**로 게이트된다(`mtype.h:304–312`):

| 플래그 | 값 | 방 |
|---|---|---|
| RSHOPP | 0 | 상점(구매) |
| RDUMPR | 1 | 덤프 |
| RPAWNS | 2 | 전당포(판매) |
| RREPAI | 7 | 수리점 |
| RBANK | 39 | 은행(§9) |
| RMARRI | 41 | 결혼 |

### 구매 — `buy` (`command7.c:169`), 정가·복제·무소진

```c
load_rom(rom_num + 1, &dep_ptr);          // 재고 = 인접방 rom_num+1 ("창고방")
if(ply_ptr->gold < obj_ptr->value) 거절;  // 정가 = value (1:1)
obj_ptr2 = malloc; *obj_ptr2 = *obj_ptr;  // 복제
F_CLR(OPERM2/OPERMT/OTEMPP);              // 영구 플래그 제거 후 지급
ply_ptr->gold -= obj_ptr->value;          // 재고는 소진되지 않음
```

**구매가 = `value`**(배수 없음). 재고는 물리적으로 **인접 방 번호 `rom_num+1`**(상점 방 바로 다음 번호)의 오브젝트를 복제한다 — "상점 방 = 진열, rom_num+1 = 창고" 규약. 원본 오브젝트는 남아 **무한 재고**다. 개수 한도 200(장착 포함 `count_inv`).

### 몹 상점 — `purchase` (`command10.c:492`)

몹이 `MPURIT`(36) 플래그를 가지면 상인. 재고는 `crt->carry[]`의 objnum이며 `load_obj`로 **템플릿 복제**(무한):

```c
amt = MAX(10, obj_ptr->value * 1);        // command10.c:573 — 최저 10냥
if(ply_ptr->gold < amt) 거절;
gold -= amt; add_obj_crt(복제본);
```

**몹 구매가 = `max(10, value)`**(`*1`은 무의미). 개수 한도 150.

### 판매 — `sell` (`command7.c:227`), 전당포 50%

```c
gold = MIN(obj_ptr->value / 2, 100000);   // command7.c:258 — 50%, 상한 10만
```

**판매가 = `min(value/2, 100000)`**. `RPAWNS` 방 전용. 거부 조건(`command7.c:252–277`):

- `gold < 20`(= value < 40) → "그런 쓰레기는 안사요".
- **저품질**: 무기/방어구 `shotscur ≤ shotsmax/8`, 지팡이/열쇠 `shotscur < 1`.
- `ONEWEV`(개인 귀속) → 거부.
- 내부에 다른 오브젝트가 든 컨테이너(`first_obj`) → 거부.
- SCROLL 또는 POTION → 거부("두루마기나 독약같은것은 안사요").

**1/250 확률 "기분 좋은 날" 2배 지급은 정상 동작이다**(`command7.c:272`):

```c
if(((time(0)+mrand(1,100))%250) == 9) {
    print(… "두배로 드리죠" … gold*2);
    ply_ptr->gold += gold;                 // if 내부: +gold
}
else { print(… gold); }
ply_ptr->gold += gold;                     // if/else 밖: 또 +gold
```

lucky 분기는 if 내부에서 한 번, if/else 밖에서 또 한 번 더해 **실제 2배**를 지급한다(표시 `gold*2`와 일치). normal 분기는 밖에서만 더해 1배. **버그 아님.** (단 `time(0)` 기반 확률은 형상 — 결정적 스케줄러로 대체.)

### 수리 — `repair` (`command8.c:196`), 25%

```c
cost = obj_ptr->value / 4;                             // 수리비 = 25%
broke = mrand(1,100) + bonus[ply_ptr->piety];          // 신앙심이 높을수록 실패↓
if((broke <= 15 && shotscur < 1) || (broke <= 5 && shotscur > 0)) {
    "수리를 하다 부러뜨렸네";
    ply_ptr->gold += cost;                             // 실패 시 전액 환불
    free_obj(obj_ptr);                                 // 아이템은 소멸
}
else shotscur = shotsmax * mrand(5,9)/10;              // 성공: 내구 50~90% 회복
```

**수리비 = `value/4`**. 실패 확률은 `bonus[piety]`로 감소(신앙심 높을수록 파손 적음). 실패하면 아이템은 사라지지만 수리비는 환불. 전당포 `value` 조회 명령은 판매가(`value/2`, 상한 10만), 수리점 견적은 `value/4`를 보여준다(`command7.c:294`, `command8.c` value 경로).

### 교환·양도

- **trade**(`command10.c:664`, 몹 `MTRADE=37`): 물물교환. `ONAMED`(명명) 불가, 마모품(`shotscur ≤ shotsmax/10`, MISC 제외) 거부. 대가 objnum은 `carry[found+4]`. (몹이 받은 물건을 보관하지 않는 미완성 로직 — §10.)
- **give**(`command8.c:28`): 타 플레이어 양도. questnum 임무템(class<DM), `ONEWEV`, 이벤트템, 그런 걸 담은 컨테이너는 불가. 대상이 PLAYER가 아니면 거부.
- **get 거부**(`command2.c:694`): `ONOTAK`, `OSCENE`, `OINVIS`, 이미 완수한 questnum, `MGUARD`(7) 몹의 감시, "초인의 돌"(value==1001).

### 소지 한도

무게(`weight_ply + weight_obj > max_weight(ply)`, [[a7-player-progression]]) 또는 개수 초과 시 거부. 개수 상한: **get/give/purchase = 150**, **buy = 200**(장착 포함). 컨테이너 무게는 `weight_obj`가 내부물을 재귀 합산하되 `OWTLES`(무게 없는 보관) 아이템은 제외한다(`object.c:238`).

---

## 9. 은행 (형상 중심)

은행은 **구조적으로 특이**하다. 잔고가 `creature` 필드가 아니라 **플레이어별 별도 object 파일**이다.

### 저장 구조 (형상 — MongoDB 설계 직결)

- 파일 경로: `PLAYERPATH/bank/<플레이어이름>`(`bank.c:12`).
- 이 파일은 **단일 `object`**이며 컨테이너로 동작: 현금은 `object.value`(long, offset 300), 보관 물품은 그 object의 중첩 인벤토리(`first_obj`).
- 직렬화는 방·몬스터와 **동일한 `read_obj`/`write_obj`**(352B object + `int cnt` + 중첩 obj 재귀, [[a4-movement-rooms]]).
- 빈 계좌 초기화(`bank.c:308`): `malloc` + `zero` + `shotsmax = 200`(보관 슬롯 상한).
- 매 거래 후 `save_bank(name, bnk_ptr)` + `savegame_nomsg(ply_ptr)`를 **둘 다** 저장(은행 파일과 플레이어 세이브 동시 갱신).

### 명령어 (`global.c:339–343`)

| 한글 | 핸들러 | 동작 |
|---|---|---|
| `잔액` | `bank` | 현금 잔고 조회 |
| `입금` | `deposit` | 소지금 → 계좌 |
| `출금` | `withdraw` | 계좌 → 소지금 |
| `보관물` | `bank_inv` | 보관품 목록 / 물품 입고(`input_bank`) |
| `받아` | `output_bank` | 보관 물품 출고 |

모든 핸들러는 진입 시 `F_ISSET(parent_rom, RBANK)`(39)를 검사한다("은행에서만 가능합니다").

### 현금 이동

```c
// 입금 (bank.c:308~)   deposit
if(bnk_ptr->value + amt > 300000000) { "3억이상 입금할 수 없습니다"; return; }  // 상한 3억
bnk_ptr->value += amt;  ply_ptr->gold -= amt;

// 출금 (bank.c:375~)   withdraw
if(amt > bnk_ptr->value) 거부;
bnk_ptr->value -= amt;  ply_ptr->gold += amt;
```

- 입력은 `"N냥"` 접미사 파싱(`atol`), `amt < 1` 거부("음수가 될수 없습니다"). `입금 모두`=전 소지금, `출금 모두`=전 잔고.
- **잔고 상한 3억**(300000000, `bank.c:314`), **수수료 없음**(1:1), **이자 없음**(전 소스 `interest`/`이자` grep 0건 — 단순 금고).
- **이체·송금 없음**: 각 계좌는 `bank/<본인이름>` 파일로 격리. 출고 시 MONEY 타입 오브젝트는 gold로 흡수.
- 물품 보관 슬롯 상한 200(`shotscur ≥ shotsmax`면 "더이상 넣을 수 없습니다"), 컨테이너(OCONTN) 계열은 보관 불가.

### `bank_check.c` — 독립 관리 유틸 (데몬 아님)

`bank_check.c`는 게임 서버가 아니라 **오프라인 관리자 편집 유틸리티**다(`void main()` 보유). 콘솔에서 플레이어 이름을 받아 계좌 파일을 로드/조회하고, 없으면 빈 계좌를 생성한다. "check"는 이자 점검이 아니라 **계좌 파일 존재 확인/조회** — 이자 정산 배치·틱과 무관하다.

### 부수

- **자살 처리**(`command5.c:711`): 계좌 파일을 `suic/<name>.bank`로 이동(삭제 아님, 격리).
- **불량 아이템 정리**(`special1.c:297`): 로그인/점검 시 은행 컨테이너를 최대 200개 순회하며 `is_bad_item` 로깅(잔고는 미변경).

---

## 10. 형상·버그·데드코드 목록 (재설계 / 비재현 후보)

| # | 항목 | 성격 | 처리 |
|---|---|---|---|
| a | **은행 = 별도 object 파일 컨테이너**(`bank/<이름>`, 현금=value) | 형상 | MongoDB 문서 `{owner, gold, items[]}`. player 인라인 또는 별도 컬렉션 모두 원본 의미와 정합 |
| b | **`ready[20]` 포인터 배열** — 디스크상 4B 포인터×20, 로드 시 무의미 | 형상 | 착용 슬롯을 objectId 참조로. 저장은 착용 여부(OWEARS)로 복원 |
| c | **상점 재고 = `rom_num+1` 인접방 규약** — 방 번호 인접에 의존 | 형상 | 명시적 재고 목록(shop inventory) 모델. 복제·무소진은 규칙으로 이식 |
| d | **`gold` signed long 무가드** — 상한·음수 검증 없음, `+=100000` 등 | 형상/결함 | 상한·검증 추가(또는 BigInt/unsigned) |
| e | **`time(0)` 기반 확률**(전당포 2배 `command7.c:272`) — 벽시계 의존 | 형상 | 결정적 RNG/스케줄러로 대체(확률 1/250은 유지) |
| f | **은행 초기화 `F_ISSET(bnk_ptr, OCONTN)`**(`bank.c:311`) — 테스트 매크로를 설정처럼 호출, **플래그가 실제로 안 켜짐** | 버그(데드) | 신규 계좌 문서는 컨테이너 성격을 명시. 원본 OCONTN 의존 코드 영향 재확인 |
| g | **trade 몹이 받은 물건 미보관**(`command10.c` 주석 처리) — 대가만 지급 | 미완성 | 물물교환을 완결형으로 재설계할지 결정 |
| h | **CONTAINER2(14)** — 헤더 정의되나 help 미기재, 실사용 미확인 | 불명 | `data/world/objects.json` 카운트로 확정, 0이면 제외 |
| i | **파생 스탯 수동 재계산 트리거** — wear/ready/remove가 `compute_ac`/`compute_thaco` 직접 호출(누락 시 stale) | 형상 | [[a7-player-progression]] §12대로 유효 스탯 함수화 |
| j | **밸런스 소각 임계 하드코딩**(AC>151, dice합>39, shots>600) — 매직넘버 | 형상 | 아이템 검증 규칙을 데이터/config로 |

---

## 11. 아키텍처 함의

1. **아이템 = 단일 `object` 문서, 착용은 슬롯 참조.** 무한의 모든 컨테이너(방·몹·플레이어·은행)가 같은 object를 담으므로, MongoDB에서도 object를 단일 스키마로 모델링하고 컨테이너는 objectId 배열로 참조한다. 착용은 `ready[]` 슬롯을 objectId 맵(`{ WIELD: id, BODY: id, … }`)으로 재현한다.

2. **파생 스탯은 `ready[]`의 순수 함수**(§4). AC=`f(dex, Σ 착용 armor, 보호)`, thaco=`f(class, level, 무기 adjustment, 숙련, str)`. 착용/해제 시 필드를 가감하는 대신 슬롯 변경 → 재계산으로 두면 [[a7-player-progression]] §12의 최우선 재설계(base+modifier 분리)와 자연히 합쳐진다. 무기 `adjustment`는 명중 modifier, 방어구 `armor`는 AC modifier로 각각 태깅.

3. **경제는 `value` 하나 위의 상수 배수.** 구매 100%·판매 50%(cap 10만)·수리 25%·몹구매 max(10,value). 이 배수는 코드가 아니라 **경제 config**(JSON)로 두어 튜닝을 코드에서 분리한다. `value`는 아이템 템플릿의 정본 필드로 이식.

4. **상점 재고를 선언적으로.** 원본은 재고를 "인접 방 번호 규약"으로 표현하지만(§8), 이는 방 번호 인접성에 묶인 형상이다. 신규 스택은 상점에 명시적 재고 목록(무한/유한, 복제 여부)을 부여하고, 몹 상점의 `carry[]`도 상인 인벤토리로 모델링한다.

5. **은행은 계좌 도메인으로 분리**(§9). 원본의 "은행=object 파일 컨테이너"는 영리한 재사용이지만 형상이다. 계좌를 `{owner, gold, items[], slotLimit:200, cap:3억}` 문서로 두면 현금·보관을 명확히 분리하면서 원본 의미(이자 없음·3억 상한·이체 없음)를 그대로 이식한다. **이자 부재는 설계 선택 지점** — 무한 원작 충실성 vs 경제 확장 사이에서 결정 게이트로 표시.

6. **금화 무결성 가드 추가.** gold·value·잔고 전부 signed long 무가드다. 신규 스택은 상한·음수 검증·트랜잭션(입금/출금/판매의 원자성)을 넣는다 — 특히 은행은 두 파일(계좌+세이브) 동시 저장이라 부분 실패 시 유실/복제 위험이 있다.

7. **콘텐츠/형상 경계 확정.** 이식: §1 타입 taxonomy·§2 착용 슬롯·게이트·§3 무기 레벨게이트·§5 소비 아이템 배달·§6 플래그 의미·rand_enchant·종족 크기·§7 금화 드롭·§8 가격 배수·거래 거부·소지 한도·§9 은행 규칙(3억·200슬롯·이자 없음). 재설계/비재현: §10 전 항목(은행 파일 구조·`ready[]` 포인터·재고 방규약·무가드·time(0)·OCONTN 데드 statement·미완성 trade).

---

## 검증 메모

- **직접 읽어 확인**(byte-level): `wear`·`wear_all`·`remove_all`·`ready`·`hold`·`equip_list`(command3.c 전 게이트·슬롯 설정 로직), object type/wearflag/object-flag 상수(mtype.h:123–139·206–230·476–526), 상점 방 플래그(mtype.h:304–312·340·342), OBJ/CRT 오프셋(templates.js).
- **경제·은행 핵심 수치 원본 재확인**(에이전트 단독 출처였던 load-bearing 값): 판매가 `MIN(value/2, 100000)`(command7.c:258 확정), 수리비 `value/4`(command8.c:249 확정), 몹구매 `MAX(10, value*1)`(command10.c:573 확정), 은행 3억 상한 `value+amt > 300000000`(bank.c:314 확정), 현금=object.value(입금 `bnk_ptr->value += amt` 확정), buy 함수명(command7.c:169 확정).
- **정정**: 전당포 "2배 지급"은 **버그가 아니라 정상 동작**이다(lucky 분기 `gold += gold` if 내부 + if/else 밖 이중 가산 = 실제 2배, command7.c:277·284 확인). 초기 추출은 이를 미지급 버그로 오독했으나 라인 재확인으로 정정. 별개로 은행 초기화의 `F_ISSET(bnk_ptr, OCONTN)`(bank.c:311)은 테스트 매크로 오용으로 플래그가 실제 안 켜지는 **데드 statement**(§10-f).
- **에이전트 추출 + 미직접확인**(신뢰하되 인용 라인 표기): 소비 아이템의 magic1.c 시전 경로(`drink`/`readscroll`/`zap`, magicpower-1 → [[a6-magic]] 위임), `die()` 금화 변환(creature.c:331)·몹 소지금 랜덤(creature.c:879), give/trade/get 거부 조건 세부(command8.c·command10.c·command2.c), bank_check.c 독립 유틸 성격.
- **위임**: 무기 데미지·명중·숙련 공식은 [[a5-combat]], 물약/두루마기/지팡이 스펠 효과·마법계열은 [[a6-magic]], AC/thaco 폐형·`max_weight`·스탯 보정은 [[a7-player-progression]]. 본 노트는 아이템 기여 항(Σ armor·adjustment)만 얹었고 기저 공식은 재유도하지 않았다.
- **미확인/근사**: CONTAINER2(14) 실사용은 `data/world/objects.json` 카운트로 확정 필요. 원거리/특수공격의 type별 분기는 command5.c 근접 경로만 확인(special1.c 등 미정독). 몹 `carry[]` 5칸/오버로드(carry[0]=WIMPYVALUE) 세부는 몹 AI 범위로 위임.
- `command grep` 래퍼 `-I` EUC-KR skip 함정 재확인 — `command grep -a`/`iconv` 사용([[muhan-oracle-toolchain]]).
